// `ffmpeg-build test --target <name>`: runs a target's build where this machine can run it. A smoke test first (the
// programs start, their configure line is the plan's, a short encode works), then each script the target lists in
// `tests:`, with FFMPEG, FFPROBE and FFMPEG_DIR set. A build this machine can't run is skipped and says why.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EngineData } from '../engine-data.ts';
import { LOCK_FILE, readFolderLock } from '../lockfile.ts';
import { artifactName, FOLDER_FILE, type Folder } from '../targets.ts';
import { extractTarGz } from '../untar.ts';
import { FolderError } from './folder.ts';

type Result = { output: string; exitCode: number };

/** This machine as a platform, and the platforms it can also run (Rosetta, Windows on Arm's x64 emulation). */
export function runnablePlatforms(platform = process.platform, arch = process.arch, musl = existsSync('/etc/alpine-release'), rosetta = hasRosetta()): string[] {
  if (platform === 'linux' && arch === 'x64') return [musl ? 'linux-musl-x64' : 'linux-x64'];
  if (platform === 'linux' && arch === 'arm64') return [musl ? 'linux-musl-arm64' : 'linux-arm64'];
  if (platform === 'linux' && arch === 'arm') return ['linux-armhf'];
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

/** The program `name` in an unpacked runtime archive: at its root or in bin/, with .exe on Windows builds. */
function program(dir: string, name: string, windows: boolean): string | undefined {
  const file = windows ? `${name}.exe` : name;
  return [join(dir, file), join(dir, 'bin', file)].find((p) => existsSync(p));
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
};

export function runTest(folder: Folder, _data: EngineData, options: { target: string; dist: string; runnable?: string[] }): Result {
  const t = folder.targets.find((x) => x.name === options.target);
  if (!t) throw new FolderError(`no target ${options.target} in ${FOLDER_FILE} (targets: ${folder.targets.map((x) => x.name).join(', ')})`);
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const version = lock?.ffmpeg[t.ffmpeg];
  if (!version) throw new FolderError(`${LOCK_FILE} has no FFmpeg ${t.ffmpeg}; run ffmpeg-build lock (and build) first`);
  const runnable = options.runnable ?? runnablePlatforms();
  if (!runnable.includes(t.platform)) {
    return { output: `${t.name}: skipped, ${t.platform} builds don't run on this machine (it runs ${runnable.join(', ') || 'none of the build platforms'})`, exitCode: 0 };
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
    if (!ffmpeg) {
      step(false, `no ffmpeg program in ${artifactName(t, version)}.tar.gz`);
    } else {
      const v = run(ffmpeg, ['-hide_banner', '-version']);
      step(v.code === 0 && v.out.includes(`ffmpeg version ${version}`), `ffmpeg -version says ${version}`, v.error?.message ?? v.out);
      const conf = run(ffmpeg, ['-hide_banner', '-buildconf']);
      step(conf.code === 0 && conf.out.includes(t.license === 'lgplv2' || t.license === 'lgplv3' ? '--disable-gpl' : '--enable-gpl'), `ffmpeg -buildconf matches ${t.license}`, conf.out);
      const enc = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=320x240:rate=25', '-f', 'null', '-']);
      step(enc.code === 0, 'a one-second test pattern encodes', enc.out);
      // the target's own tests, from the folder
      const env = { ...process.env, FFMPEG: ffmpeg, FFPROBE: ffprobe ?? '', FFMPEG_DIR: dir, FFMPEG_TARGET: t.name, FFMPEG_PLATFORM: t.platform };
      for (const test of t.tests) {
        const script = join(folder.dir, test);
        const r = /\.sh$/.test(test) || !windows ? run('bash', [script], env) : run(script, [], env);
        step(r.code === 0, `tests: ${test}`, r.error?.message ?? r.out);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { output: [`${t.name} (${artifactName(t, version)}.tar.gz)`, ...lines, '', failed ? `${failed} failed` : 'all passed'].join('\n'), exitCode: failed ? 1 : 0 };
}
