import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A build that couldn't run or failed; the message says what and where the log is. */
export class BuildError extends Error {}

export function dockerCommand(): string {
  return process.env.FFMPEG_BUILD_DOCKER ?? 'docker';
}

/** 'ready', 'missing' (no docker command), or 'stopped' (installed, but its engine doesn't answer). */
export async function dockerStatus(): Promise<'ready' | 'missing' | 'stopped'> {
  try {
    await execFileAsync(dockerCommand(), ['version', '--format', '{{.Server.Version}}'], { timeout: 30_000 });
    return 'ready';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'stopped';
  }
}

/** The tag for images/<image>/Dockerfile: its name and the first 12 hex of the Dockerfile's sha256. */
export function imageTag(root: string, image: string): string {
  const hash = createHash('sha256').update(readFileSync(join(root, 'images', image, 'Dockerfile'))).digest('hex');
  return `ffmpeg-build-${image}:${hash.slice(0, 12)}`;
}

async function inspectId(tag: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(dockerCommand(), ['image', 'inspect', '--format', '{{.Id}}', tag], { timeout: 30_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The docker command that builds a toolchain image. With FFMPEG_BUILD_IMAGE_CACHE=gha (set by the CI workflow), buildx
 * reuses GitHub Actions' cache, one scope per image, so CI doesn't rebuild an unchanged image every run.
 */
export function imageBuildArgs(tag: string, dir: string, image: string, cache = process.env.FFMPEG_BUILD_IMAGE_CACHE): string[] {
  if (cache === 'gha') return ['buildx', 'build', '--load', '--cache-from', `type=gha,scope=${image}`, '--cache-to', `type=gha,mode=max,scope=${image}`, '-t', tag, dir];
  return ['build', '-t', tag, dir];
}

/**
 * The image's tag and Docker ID, building it from images/<image> when this machine doesn't have it yet. The ID is
 * the library cache's toolchain identity: dnf packages aren't pinned, so a rebuilt image counts as a new toolchain.
 */
export async function ensureImage(root: string, image: string): Promise<{ tag: string; id: string }> {
  const tag = imageTag(root, image);
  let id = await inspectId(tag);
  if (!id) {
    const { code } = await runStreaming(dockerCommand(), imageBuildArgs(tag, join(root, 'images', image), image));
    if (code !== 0) throw new BuildError(`Couldn't build the toolchain image ${tag} (docker build exited ${code}).`);
    id = await inspectId(tag);
    if (!id) throw new BuildError(`Built the toolchain image ${tag}, but Docker can't find it.`);
  }
  return { tag, id };
}

/** --mount, not -v: Windows paths contain ':' and may contain spaces. Its value is CSV, so a path with a comma is quoted. */
export function mountArgs(m: { recipes: string; engine: string; cache: string; out: string; plan: string }): string[] {
  const field = (f: string) => (/[",]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f);
  const mount = (source: string, target: string, readonly: boolean) => ['--mount', `type=bind,${field(`source=${source}`)},target=${target}${readonly ? ',readonly' : ''}`];
  return [
    ...mount(m.recipes, '/recipes', true),
    ...mount(m.engine, '/engine', true),
    ...mount(m.cache, '/cache', false),
    ...mount(m.out, '/out', false),
    ...mount(m.plan, '/plan.json', true),
  ];
}

/** The user to hand the build's files back to: the host user on Linux, where a container's root files stay root's. */
export function hostUserOf(platform = process.platform): { uid: number; gid: number } | undefined {
  return platform === 'linux' && process.getuid && process.getgid ? { uid: process.getuid(), gid: process.getgid() } : undefined;
}

/**
 * The docker run that builds one plan: --init so Ctrl-C reaches the build (a bash pid 1 ignores it). On Linux the
 * driver gives what it wrote back to the host user (Docker Desktop maps ownership itself).
 */
export function dockerRunArgs(m: { tag: string; recipes: string; engine: string; cache: string; out: string; plan: string; hostUser?: { uid: number; gid: number } }): string[] {
  const { tag, hostUser = hostUserOf(), ...mounts } = m;
  const owner = hostUser ? ['-e', `FFB_HOST_UID=${hostUser.uid}`, '-e', `FFB_HOST_GID=${hostUser.gid}`] : [];
  return ['run', '--rm', '--init', ...owner, ...mountArgs(mounts), tag, 'bash', '/engine/driver.sh'];
}

/**
 * Runs a command, showing its output and copying it to `logPath`. Resolves to its exit code and the last
 * `ERROR: ...` line it printed (the driver's way of naming what failed), without the prefix.
 */
export function runStreaming(command: string, args: string[], logPath?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; lastError?: string }> {
  return new Promise((resolve, reject) => {
    const log = logPath ? createWriteStream(logPath) : undefined;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    let lastError: string | undefined;
    const take = (to: NodeJS.WriteStream) => (d: Buffer) => {
      to.write(d);
      log?.write(d);
      for (const line of d.toString().split(/\r?\n/)) if (line.startsWith('ERROR: ')) lastError = line.slice('ERROR: '.length);
    };
    child.stdout.on('data', take(process.stdout));
    child.stderr.on('data', take(process.stderr));
    child.on('error', reject);
    child.on('close', (code) => {
      const done = () => resolve(lastError ? { code: code ?? 1, lastError } : { code: code ?? 1 });
      if (log) log.end(done);
      else done();
    });
  });
}
