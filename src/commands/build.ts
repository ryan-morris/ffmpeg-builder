import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BuildError, dockerCommand, dockerRunArgs, dockerStatus, ensureImage, runStreaming } from '../build/docker.ts';
import { acquireBuildLock, hostEnv, hostToolchainIdentity, nativeBash, nativeEnv, nativePaths, nativePreflight, nativeWorkRoot } from '../build/native.ts';
import { makeBuildPlan, toolchainIdentity, type BuildSource } from '../build/plan.ts';
import { publishingRepo } from '../release-remote.ts';
import { LOCK_FILE, readFolderLock, type LockedProfile } from '../lockfile.ts';
import type { CellPlan } from '../resolve.ts';
import type { PlatformEntry } from '../schema/engine.ts';
import { artifactName, FOLDER_FILE, targetProfile, type Folder } from '../targets.ts';
import { folderErrors, FolderError, runFolderCheck } from './folder.ts';
import { depsOn, type EngineData } from '../engine-data.ts';
import { packageRoot } from '../paths.ts';
import { displayPath, type Profile } from '../profile.ts';
import { planProfile } from '../resolve.ts';

/** A remote URL as a reader can open it: no credentials, and scp-style `git@host:path` as https. */
export function publicRepoUrl(url: string): string {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]!.replace(/\.git$/, '')}`;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\.git$/, '');
  } catch {
    return url;
  }
}

/** Whether a git remote is something a reader can fetch: a URL (scheme://) or scp-style host:path, not a local path. */
function isRemoteUrl(remote: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ? !/^file:/i.test(remote) : /^[\w.-]+@[\w.-]+:(?!\/)/.test(remote);
}

/**
 * The repository and commit THIRD-PARTY-NOTICES.txt names: FFMPEG_BUILD_SOURCE_REPO / _REF (CI sets them), else the
 * folder's git remote (origin, when it is a URL rather than a local path) and HEAD, with -dirty when tracked files
 * have changes HEAD doesn't hold. Missing ones are left out (the notices then say it wasn't recorded).
 */
export function sourceIdentity(dir: string, env: NodeJS.ProcessEnv = process.env): BuildSource {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    } catch {
      return undefined;
    }
  };
  const remote = env.FFMPEG_BUILD_SOURCE_REPO ? undefined : git(['remote', 'get-url', 'origin']);
  const repo = env.FFMPEG_BUILD_SOURCE_REPO || (remote && isRemoteUrl(remote) ? remote : undefined);
  let ref = env.FFMPEG_BUILD_SOURCE_REF || undefined;
  if (!ref) {
    const head = git(['rev-parse', 'HEAD']);
    // tracked files only: the build's own output (dist/) is usually untracked
    if (head) ref = git(['status', '--porcelain', '--untracked-files=no']) ? `${head}-dirty` : head;
  }
  return { ...(repo ? { repo: publicRepoUrl(repo) } : {}), ...(ref ? { ref } : {}) };
}

export function cacheRoot(): string {
  return resolve(process.env.FFMPEG_BUILD_CACHE ?? join(homedir(), '.cache', 'ffmpeg-build')); // docker needs absolute
}

type Result = { output: string; exitCode: number };

/** The platform's entry in platforms.yml, or why it can't be built here. */
function platformEntry(data: EngineData, platform: string): PlatformEntry | Result {
  const target = data.platforms.get(platform);
  if (!target) return { output: `building for ${platform} isn't supported yet (ffmpeg-build builds: ${[...data.platforms.keys()].join(', ')})`, exitCode: 2 };
  if (target.image === 'macos' && process.platform !== 'darwin') return { output: `${platform} builds on macOS (Xcode); run this on a Mac`, exitCode: 2 };
  return target;
}

/** Builds a target: its one build, named after it (see artifactName). */
/**
 * The libraries `only` names and everything they build against in this build, in build order: a recipe check builds
 * them without FFmpeg. Names this build doesn't have are an error.
 */
export function onlyLibraries(data: EngineData, cell: CellPlan, only: string[]): string[] {
  const missing = only.filter((n) => !cell.recipes.includes(n));
  if (missing.length) throw new FolderError(`this target doesn't build ${missing.join(', ')} (it builds ${cell.recipes.join(', ')})`);
  const keep = new Set<string>();
  const add = (n: string) => {
    if (keep.has(n)) return;
    keep.add(n);
    const r = data.recipes.get(n)!;
    for (const d of [...depsOn(r, 'needs', cell.cell.platform), ...depsOn(r, 'uses', cell.cell.platform)]) if (cell.recipes.includes(d)) add(d);
  };
  only.forEach(add);
  return cell.recipes.filter((n) => keep.has(n));
}

export async function runTargetBuild(folder: Folder, name: string, data: EngineData, options: { out: string; dryRun?: boolean; only?: string[] }): Promise<Result> {
  const t = folder.targets.find((x) => x.name === name);
  if (!t) throw new FolderError(`no target ${name} in ${FOLDER_FILE} (targets: ${folder.targets.map((x) => x.name).join(', ')})`);
  const entry = platformEntry(data, t.platform);
  if ('exitCode' in entry) return entry;
  const checked = runFolderCheck(folder, data, { target: name });
  if (checked.exitCode) return checked;
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const version = lock?.ffmpeg[t.ffmpeg];
  if (!lock || !version) return { output: `${LOCK_FILE} has no FFmpeg ${t.ffmpeg} yet; run ffmpeg-build lock first`, exitCode: 1 };
  // folder-wide problems (a pin no build can meet, a lock that no longer fits) stop every target's build
  const errors = folderErrors(folder, data, lock);
  if (errors.length) return { output: [folder.file, ...errors.map((e) => `  ✗ ${e}`)].join('\n'), exitCode: 1 };
  const profile = targetProfile(folder, t);
  const [cell] = planProfile(profile, data, { [t.ffmpeg]: version }).cells;
  const buildName = artifactName(t, version);
  const only = options.only?.length ? onlyLibraries(data, cell!, options.only) : undefined;
  if (only && options.dryRun) return { output: `would build ${only.join(', ')} for ${t.platform}, without FFmpeg`, exitCode: 0 };
  if (options.dryRun) return { output: `would build ${buildName} (${t.platform}) in ${entry.image === 'macos' ? 'Xcode on this Mac' : `ffmpeg-build-${entry.image}`}`, exitCode: 0 };
  return runJob({ platform: t.platform, target: entry, profile, locked: { ffmpeg: lock.ffmpeg, libraries: lock.libraries, pinned: [] }, out: options.out, builds: [{ cell: cell!, variant: t.name, name: buildName, ...(t.releaseGroup ? { group: t.releaseGroup } : {}), ...(only ? { only } : {}) }] }, data);
}

interface Job {
  platform: string;
  target: PlatformEntry;
  profile: Profile;
  locked: LockedProfile;
  out: string;
  builds: { cell: CellPlan; variant: string; name?: string; group?: string; only?: string[] }[]; // only: these libraries, no FFmpeg
}

/** Runs the builds of one platform: in its toolchain image, or natively on a Mac. */
async function runJob(job: Job, data: EngineData): Promise<Result> {
  const { target, profile, locked } = job;
  const options = { platform: job.platform, out: job.out };
  const native = target.image === 'macos'; // built on the host with Xcode, not in a toolchain image

  const docker = native ? 'ready' : await dockerStatus();
  if (docker === 'missing') {
    return { output: `ffmpeg-build needs Docker to build ${options.platform}; install it (Docker Desktop on Windows/macOS) and try again`, exitCode: 2 };
  }
  if (docker === 'stopped') {
    return { output: 'Docker is installed but not running; start it (Docker Desktop on Windows/macOS) and try again', exitCode: 2 };
  }

  const out = resolve(options.out);
  const libs = join(cacheRoot(), 'libs');
  mkdirSync(out, { recursive: true });
  mkdirSync(libs, { recursive: true });
  // images/ and platforms/ ship with the engine; recipes come from the data
  const workRoot = native ? nativeWorkRoot() : undefined;
  const paths = workRoot ? nativePaths(workRoot, options.platform) : undefined;
  if (workRoot) {
    nativePreflight();
    mkdirSync(workRoot, { recursive: true });
  }
  const release = workRoot ? acquireBuildLock(workRoot, options.platform) : () => {};
  try {
    const image = native ? undefined : await ensureImage(packageRoot, target.image);
    const toolchain = paths ? hostToolchainIdentity(packageRoot, target.setup, options.platform, paths.depsDir) : toolchainIdentity(packageRoot, image!.id, target.setup);
    const built: string[] = [];
    // what THIRD-PARTY-NOTICES.txt names as the source: the build's definition, and the release it ships in
    // (FFMPEG_BUILD_RELEASE, set by the build workflow) with the repository it is published in
    const folderDir = profile.dir ?? process.cwd();
    const source = sourceIdentity(folderDir);
    const releaseTag = process.env.FFMPEG_BUILD_RELEASE || undefined;
    const repository = releaseTag ? publishingRepo(folderDir) : undefined;
    for (const { cell, variant, name, group, only } of job.builds) {
      const full = makeBuildPlan({
        profile, data, locked, cell, imageId: toolchain, cacheDir: libs,
        variant, source,
        ...(releaseTag ? { release: releaseTag } : {}),
        ...(repository ? { repository } : {}),
        ...(group ? { group } : {}),
        ...(name ? { name } : {}),
        ...(paths ? { depsDir: paths.depsDir } : {}),
      });
      const { ffmpeg: _ffmpeg, ...withoutFfmpeg } = full;
      const plan = only ? { ...withoutFfmpeg, libraries: full.libraries.filter((l) => only.includes(l.name)) } : full;
      const planDir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-plan-'));
      const planPath = join(planDir, 'plan.json');
      const log = join(out, `${plan.name}.log`);
      let result: { code: number; lastError?: string };
      try {
        writeFileSync(planPath, JSON.stringify(plan, null, 2));
        if (paths) {
          // a container starts empty every time; a native build starts from empty folders instead
          for (const dir of [paths.depsDir, paths.work]) rmSync(dir, { recursive: true, force: true });
          const env = nativeEnv({ plan: planPath, recipes: join(data.root, 'recipes'), engine: join(packageRoot, 'platforms'), cache: cacheRoot(), out, ...paths });
          result = await runStreaming(nativeBash(), [join(packageRoot, 'platforms', 'driver.sh')], log, { ...hostEnv(), ...env });
        } else {
          const args = dockerRunArgs({ tag: image!.tag, recipes: join(data.root, 'recipes'), engine: join(packageRoot, 'platforms'), cache: cacheRoot(), out, plan: planPath });
          result = await runStreaming(dockerCommand(), args, log);
        }
      } finally {
        rmSync(planDir, { recursive: true, force: true });
      }
      if (result.code !== 0) {
        const what = result.lastError ?? "FFmpeg's build failed";
        throw new BuildError([...built, `building ${plan.name} failed: ${what}; the log is ${displayPath(log)}`].join('\n'));
      }
      built.push(only ? `built ${only.join(', ')} for ${job.platform} (libraries only, no FFmpeg)` : `built ${displayPath(join(out, `${plan.name}.tar.gz`))}, ${plan.name}-dev.tar.gz and ${plan.name}.sources.json`);
    }
    return { output: built.join('\n'), exitCode: 0 };
  } finally {
    release();
  }
}
