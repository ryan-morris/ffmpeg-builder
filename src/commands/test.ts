// `ffmpeg-build test --target <name>`: runs a target's build where this machine can run it. A smoke test first (the
// programs start, their configure line is the plan's, a short encode works), then each script the target lists in
// `tests:`, with FFMPEG, FFPROBE and FFMPEG_DIR set. A build this machine can't run is skipped and says why. A
// linux-musl-x64 build on a glibc linux-x64 machine with Docker runs in a plain Alpine container (the image the
// musl toolchain is built from, pinned by the same digest).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { LICENSE_FLAGS } from '../build/plan.ts';
import type { EngineData } from '../engine-data.ts';
import { LOCK_FILE, readFolderLock } from '../lockfile.ts';
import { packageRoot } from '../paths.ts';
import { artifactName, FOLDER_FILE, type Folder } from '../targets.ts';
import { extractTarGz } from '../untar.ts';
import { FolderError } from './folder.ts';

type Result = { output: string; exitCode: number };

/** Whether this Linux machine's C library is musl: Node's report names the glibc it runs on, and none on musl. */
export function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/** This machine as a platform, and the platforms it can also run (Rosetta, Windows on Arm's x64 emulation). */
export function runnablePlatforms(platform = process.platform, arch = process.arch, musl = isMusl(), rosetta = hasRosetta()): string[] {
  if (platform === 'linux' && arch === 'x64') return [musl ? 'linux-musl-x64' : 'linux-x64'];
  if (platform === 'linux' && arch === 'arm64') return [musl ? 'linux-musl-arm64' : 'linux-arm64'];
  if (platform === 'linux' && arch === 'arm') return musl ? [] : ['linux-armhf']; // there is no musl armhf build
  if (platform === 'darwin' && arch === 'arm64') return rosetta ? ['osx-arm64', 'osx-x64'] : ['osx-arm64'];
  if (platform === 'darwin' && arch === 'x64') return ['osx-x64'];
  if (platform === 'win32' && arch === 'x64') return ['win-x64'];
  if (platform === 'win32' && arch === 'arm64') return ['win-arm64', 'win-x64'];
  return [];
}

function hasRosetta(): boolean {
  if (process.platform !== 'darwin') return false;
  return spawnSync('arch', ['-x86_64', '/usr/bin/true']).status === 0;
}

/** The Alpine image linux-musl-x64 builds from (images/linux-musl-x64/Dockerfile's FROM, digest and all). */
export function muslImage(engineRoot = packageRoot): string {
  const from = /^FROM\s+(\S+@sha256:[0-9a-f]{64})/m.exec(readFileSync(join(engineRoot, 'images', 'linux-musl-x64', 'Dockerfile'), 'utf8'))?.[1];
  if (!from) throw new FolderError('images/linux-musl-x64/Dockerfile has no FROM pinned by digest');
  return from;
}

const dockerWorks = () => spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }).status === 0;

/**
 * Git Bash on Windows (never WSL's bash.exe, which PATH often finds first): $BASH when it is a file, else the bash
 * beside `git --exec-path`'s Git install, else the usual install folders.
 */
export function gitBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, gitExecPath: () => string | undefined = defaultGitExecPath): string | undefined {
  const candidates: string[] = [];
  if (env.BASH) candidates.push(env.BASH);
  const exec = gitExecPath();
  // <git>/mingw64/libexec/git-core: bash is <git>/bin/bash.exe; some layouts keep git-core two levels down
  if (exec) candidates.push(resolve(exec, '..', '..', '..', 'bin', 'bash.exe'), resolve(exec, '..', '..', 'bin', 'bash.exe'));
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
  }
  return candidates.find((c) => !/[\\/]system32[\\/]bash\.exe$/i.test(c) && !/[\\/]WindowsApps[\\/]/i.test(c) && exists(c));
}

function defaultGitExecPath(): string | undefined {
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** How a test script runs on this host: .sh with bash (Git Bash on Windows), .cmd/.bat with cmd, .ps1 with PowerShell. */
export function scriptCommand(script: string, host: NodeJS.Platform = process.platform, find: { bash?: () => string | undefined; pwsh?: () => string | undefined } = {}): { cmd: string; args: string[]; verbatim?: true } | { error: string } {
  const ext = extname(script).toLowerCase();
  if (host !== 'win32') return { cmd: 'bash', args: [script] };
  // verbatim: /s takes off the outer quotes, leaving the path quoted however many spaces it has
  if (ext === '.cmd' || ext === '.bat') return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `""${script}""`], verbatim: true };
  if (ext === '.ps1') {
    const ps = (find.pwsh ?? defaultPowerShell)();
    return ps ? { cmd: ps, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] } : { error: 'needs PowerShell: neither pwsh nor powershell is on PATH' };
  }
  if (ext === '.sh') {
    const bash = (find.bash ?? gitBash)();
    return bash ? { cmd: bash, args: [script] } : { error: "needs Git Bash, which isn't found: install Git for Windows, or set BASH to its bash.exe (WSL's bash isn't used)" };
  }
  return { cmd: script, args: [] };
}

function defaultPowerShell(): string | undefined {
  return ['pwsh', 'powershell'].find((p) => spawnSync(p, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0);
}

/** `docker run` arguments that run `cmd` in the musl image with the build and the folder mounted at their own paths. */
export function dockerArgs(image: string, mounts: string[], cwd: string, env: Record<string, string>, cmd: string, args: string[], network = false): string[] {
  return [
    'run', '--rm', ...(network ? [] : ['--network', 'none']),
    ...mounts.flatMap((m) => ['-v', `${m}:${m}:ro`]),
    '-w', cwd,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    image, cmd, ...args,
  ];
}

/** The program `name` in an unpacked runtime archive: at its root or in bin/, with .exe on Windows builds. */
function program(dir: string, name: string, windows: boolean): string | undefined {
  const file = windows ? `${name}.exe` : name;
  return [join(dir, file), join(dir, 'bin', file)].find((p) => existsSync(p));
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, verbatim = false) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, windowsVerbatimArguments: verbatim });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `ffmpeg -version` names exactly this version (9.1.0, not 9.1.0.1 or 9.1.01). */
export const versionMatches = (out: string, version: string) => new RegExp(`^ffmpeg version ${escape(version)}(?: |$)`, 'm').test(out);

/** The licence flags `ffmpeg -buildconf` lacks: every one the build's licence passes to configure. */
export const missingLicenseFlags = (buildconf: string, license: keyof typeof LICENSE_FLAGS) => {
  const words = new Set(buildconf.split(/\s+/));
  return LICENSE_FLAGS[license].filter((f) => !words.has(f));
};

export function runTest(folder: Folder, _data: EngineData, options: { target: string; dist: string; runnable?: string[]; docker?: boolean }): Result {
  const t = folder.targets.find((x) => x.name === options.target);
  if (!t) throw new FolderError(`no target ${options.target} in ${FOLDER_FILE} (targets: ${folder.targets.map((x) => x.name).join(', ')})`);
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const version = lock?.ffmpeg[t.ffmpeg];
  if (!version) throw new FolderError(`${LOCK_FILE} has no FFmpeg ${t.ffmpeg}; run ffmpeg-build lock (and build) first`);
  const runnable = options.runnable ?? runnablePlatforms();
  // a musl x64 build runs in an Alpine container on a glibc x64 Linux machine that has Docker
  const inDocker = !runnable.includes(t.platform) && t.platform === 'linux-musl-x64' && runnable.includes('linux-x64') && (options.docker ?? dockerWorks());
  if (!runnable.includes(t.platform) && !inDocker) {
    const docker = t.platform === 'linux-musl-x64' && runnable.includes('linux-x64') ? ' (with Docker it would run in an Alpine container)' : '';
    return { output: `${t.name}: skipped, ${t.platform} builds don't run on this machine (it runs ${runnable.join(', ') || 'none of the build platforms'})${docker}`, exitCode: 0 };
  }
  const archive = join(resolve(options.dist), `${artifactName(t, version)}.tar.gz`);
  if (!existsSync(archive)) throw new FolderError(`${t.name} isn't built in ${options.dist} (ffmpeg-build build --target ${t.name} --out ${options.dist})`);

  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-test-'));
  const lines: string[] = [];
  let failed = 0;
  const step = (ok: boolean, what: string, detail?: string) => {
    lines.push(`  ${ok ? '✓' : '✗'} ${what}`);
    if (!ok) {
      failed++;
      if (detail) lines.push(...detail.trim().split('\n').slice(-15).map((l) => `      ${l}`));
    }
  };
  try {
    extractTarGz(readFileSync(archive), dir);
    const windows = t.platform.startsWith('win-');
    const ffmpeg = program(dir, 'ffmpeg', windows);
    const ffprobe = program(dir, 'ffprobe', windows);
    const testEnv = { FFMPEG: ffmpeg ?? '', FFPROBE: ffprobe ?? '', FFMPEG_DIR: dir, FFMPEG_TARGET: t.name, FFMPEG_PLATFORM: t.platform };
    const image = inDocker ? muslImage() : '';
    const exec = (cmd: string, args: string[], env: Record<string, string> = {}, verbatim = false) =>
      inDocker ? run('docker', dockerArgs(image, [dir, folder.dir], folder.dir, env, cmd, args)) : run(cmd, args, { ...process.env, ...env }, verbatim);
    if (inDocker) lines.push(`  (in ${image.split('@')[0]}, a plain musl system)`);
    if (!ffmpeg) {
      step(false, `no ffmpeg program in ${artifactName(t, version)}.tar.gz`);
    } else {
      const v = exec(ffmpeg, ['-hide_banner', '-version']);
      step(v.code === 0 && versionMatches(v.out, version), `ffmpeg -version says ${version}`, v.error?.message ?? v.out);
      const conf = exec(ffmpeg, ['-hide_banner', '-buildconf']);
      const missing = missingLicenseFlags(conf.out, t.license);
      step(conf.code === 0 && !missing.length, `ffmpeg -buildconf matches ${t.license}${missing.length ? ` (missing ${missing.join(' ')})` : ''}`, conf.out);
      const enc = exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=320x240:rate=25', '-f', 'null', '-']);
      step(enc.code === 0, 'a one-second test pattern encodes', enc.out);
      // the target's own tests, from the folder
      for (const test of t.tests) {
        const script = join(folder.dir, test);
        if (inDocker) {
          // Alpine has sh, not bash: add bash for a .sh script (the container's network is needed for that one step)
          const r = /\.sh$/.test(test)
            ? run('docker', dockerArgs(image, [dir, folder.dir], dirname(script), testEnv, 'sh', ['-c', 'apk add --no-cache -q bash >/dev/null && exec bash "$0"', script], true))
            : exec(script, [], testEnv);
          step(r.code === 0, `tests: ${test}`, r.error?.message ?? r.out);
          continue;
        }
        const how = scriptCommand(script);
        if ('error' in how) {
          step(false, `tests: ${test}`, how.error);
          continue;
        }
        const r = exec(how.cmd, how.args, testEnv, how.verbatim);
        step(r.code === 0, `tests: ${test}`, r.error?.message ?? r.out);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { output: [`${t.name} (${artifactName(t, version)}.tar.gz)`, ...lines, '', failed ? `${failed} failed` : 'all passed'].join('\n'), exitCode: failed ? 1 : 0 };
}
