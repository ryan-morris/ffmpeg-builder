// Builds that run natively on the host instead of in a toolchain image: the macOS platforms (platforms.yml
// `image: macos`), which need Xcode. The same platforms/driver.sh runs them, with its paths passed in the environment.
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BuildError } from './docker.ts';
import { toolchainIdentity } from './plan.ts';

/**
 * Where native builds keep their libraries and scratch space: FFMPEG_BUILD_WORK (made absolute), else
 * ~/ffmpeg-build-work. No whitespace: the path ends up in FFmpeg's configure flags, CMake files and CFLAGS.
 */
export function nativeWorkRoot(): string {
  const root = resolve(process.env.FFMPEG_BUILD_WORK || join(homedir(), 'ffmpeg-build-work'));
  if (/\s/.test(root)) throw new BuildError(`the native build folder ${root} has a space in it; set FFMPEG_BUILD_WORK to a folder without spaces`);
  return root;
}

// What a native build inherits from the user's shell: nothing that steers compilers or search paths (CC, CPATH,
// LIBRARY_PATH, CMAKE_PREFIX_PATH, MAKEFLAGS, SDKROOT...), which would change what's built without changing the cache key.
const HOST_ENV = /^(HOME|USER|LOGNAME|TMPDIR|LANG|LC_[A-Z]+|TERM|PATH|SHELL|HOMEBREW_PREFIX|DEVELOPER_DIR)$/;

/** The host environment a native build runs with: the allowlisted variables, with Homebrew's bin first on PATH. */
export function hostEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && HOST_ENV.test(k)) out[k] = v;
  const brew = `${env.HOMEBREW_PREFIX || '/opt/homebrew'}/bin`;
  out.PATH = [brew, ...(env.PATH ?? '').split(':').filter((p) => p && p !== brew)].join(':');
  return out;
}

/**
 * One build per platform at a time on a machine: its deps folder is fixed and wiped at the start, so a second build
 * would rebuild under the first and poison the library cache. The lock holds the pid; a lock whose process is gone
 * is taken over. Returns the release function.
 */
export function acquireBuildLock(workRoot: string, platform: string): () => void {
  const path = join(workRoot, `${platform}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (pid && isAlive(pid)) throw new BuildError(`another ffmpeg-build is already building ${platform} on this machine (pid ${pid}); wait for it, or delete ${path} if it's gone`);
      rmSync(path, { force: true }); // its build died without releasing it
    }
  }
  throw new BuildError(`couldn't take the build lock ${path}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, but someone else's
  }
}

/**
 * A platform's folders under the work root. The deps folder is fixed per platform because the libraries' .pc files
 * record it; it is wiped before each build, so one platform builds at a time on a host.
 */
export function nativePaths(workRoot: string, platform: string): { depsDir: string; work: string } {
  const posix = workRoot.replaceAll('\\', '/');
  return { depsDir: `${posix}/deps/${platform}`, work: `${posix}/work/${platform}` };
}

/** The environment platforms/driver.sh reads its paths from (its defaults are the container's). */
export function nativeEnv(p: { plan: string; recipes: string; engine: string; cache: string; out: string; depsDir: string; work: string }): Record<string, string> {
  return { FFB_PLAN: p.plan, FFB_RECIPES: p.recipes, ENGINE: p.engine, FFB_CACHE: p.cache, FFB_OUT: p.out, DEPS_DIR: p.depsDir, FFB_WORK: p.work };
}

/** The bash that runs the driver: Homebrew's (macOS ships bash 3.2, without mapfile), else the one on PATH. */
export function nativeBash(): string {
  if (process.env.FFMPEG_BUILD_BASH) return process.env.FFMPEG_BUILD_BASH;
  return ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find((b) => existsSync(b)) ?? 'bash';
}

/**
 * Before a native build: the driver needs bash 4+ (macOS ships 3.2) and jq, both from Homebrew. Says what's missing
 * instead of failing partway through the first library.
 */
export function nativePreflight(): void {
  let out = '';
  try {
    out = execFileSync(nativeBash(), ['-c', 'echo "${BASH_VERSINFO[0]}"; command -v jq || echo NO-JQ'], { encoding: 'utf8', env: hostEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new BuildError('a native build needs bash 4 or newer (Homebrew: `brew install bash`); none was found');
  }
  const [major, jq] = out.trim().split('\n');
  const missing = [Number(major) < 4 ? 'bash 4 or newer (macOS ships 3.2)' : '', jq === 'NO-JQ' ? 'jq' : ''].filter(Boolean);
  if (missing.length) throw new BuildError(`a native build needs ${missing.join(' and ')}: install the tools in platforms/setup/apple-brew.txt with Homebrew`);
}

/**
 * What the platform's setup says its host toolchain is (its `toolchain_facts`: Xcode and SDK versions, the pinned
 * Homebrew tools' versions). Run with the same bash as the build.
 */
export function setupFacts(engineRoot: string, setup: string, platform: string, depsDir: string): string {
  const script = 'set -euo pipefail; source "${ENGINE}/setup/$1.sh"; declare -F toolchain_facts >/dev/null || { echo "no toolchain_facts" >&2; exit 3; }; toolchain_facts';
  try {
    return execFileSync(nativeBash(), ['-c', script, '_', setup], {
      encoding: 'utf8',
      // what the driver sets before sourcing a setup
      env: { ...hostEnv(), ENGINE: join(engineRoot, 'platforms').replaceAll('\\', '/'), BUILD_RID: platform, DEPS_DIR: depsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    if (err.status === 3) throw new BuildError(`platforms/setup/${setup}.sh has no toolchain_facts; a native build can't key its library cache without it`);
    throw new BuildError(`couldn't read the host toolchain from platforms/setup/${setup}.sh: ${(err.stderr ?? '').trim() || 'it failed'}`);
  }
}

/**
 * A native build's toolchain identity, the library cache's key part: the host toolchain the setup reports, the deps
 * folder the libraries are installed into (their .pc files record it), the driver and the setup with its helpers.
 */
export function hostToolchainIdentity(engineRoot: string, setup: string, platform: string, depsDir: string): string {
  return toolchainIdentity(engineRoot, `host\0${setupFacts(engineRoot, setup, platform, depsDir)}\0${depsDir}`, setup);
}
