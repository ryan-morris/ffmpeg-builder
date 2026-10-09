import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeEngine } from './helpers.ts';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

/** A local git repo with one commit, the given tags and branches. `url` is its file:// URL. */
export function makeGitRepo(tags: string[], options: { branches?: string[]; annotated?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-upstream-'));
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'release');
  for (const tag of tags) addTag(dir, tag, options.annotated?.includes(tag));
  for (const branch of options.branches ?? []) git(dir, 'branch', branch);
  return { dir, url: pathToFileURL(dir).href, head: git(dir, 'rev-parse', 'HEAD') };
}

export function addTag(dir: string, tag: string, annotated = false): void {
  git(dir, 'tag', ...(annotated ? ['-a', '-m', tag] : []), tag);
}

/** Serves `pages` (path -> HTML) on a local port until `close()`. Unknown paths are 404. */
export async function serveListing(pages: Record<string, string>) {
  const server = createServer((req, res) => {
    const page = pages[req.url ?? ''];
    res.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html' });
    res.end(page ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Like runCli, but doesn't block this process, so a listing server in the test can answer. */
export async function runCliAsync(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, ...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, encoding: 'utf8' });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout + err.stderr, exitCode: err.code };
  }
}

/**
 * A small engine whose upstreams are all local: FFmpeg (git tags), dav1d and nv-codec (git tags), x264 (a
 * branch) and lame (a SourceForge-style listing). `profiles` holds p.yml; `env` points the CLI at the engine.
 */
export async function makeScenario() {
  const ffmpeg = makeGitRepo(['n8.1.3', 'n9.0.2', 'n9.1.0', 'n10.0.0']);
  const dav1d = makeGitRepo(['0.9.5', '1.5.4', '1.5.5']);
  const nvcodec = makeGitRepo(['n13.0.19.1', 'n13.1.15.0']);
  const x264 = makeGitRepo([], { branches: ['stable'] });
  const listing = await serveListing({
    '/lame/': '<a href="/projects/lame/files/lame/3.100/">3.100</a> <a href="/projects/lame/files/lame/4.0/">4.0</a> <a href="/index.html">x</a>',
  });
  const options = '  dav1d: { needs: dav1d, min: 1.0.0 }\n  nvenc: { needs: nv-codec, platforms: [linux-*, win-*] }\n  x264: { needs: x264, ffmpeg-license: gpl }\n  libmp3lame: { needs: lame }\n';
  const engine = writeEngine({
    'ffmpeg/source.yml': `git: ${ffmpeg.url}\nversions: { git-tags: '^n(\\d+\\.\\d+(?:\\.\\d+)?)$' }\nurl: ${ffmpeg.url}/ffmpeg-{version}.tar.xz\n`,
    'ffmpeg/8.yml': `major: 8\nreleases: [8.1.3]\noptions:\n${options}`,
    'ffmpeg/9.yml': `major: 9\nreleases: [9.0.2]\noptions:\n${options}`,
    'recipes/dav1d/recipe.yml': `name: dav1d\nlicense: BSD-2-Clause\nsource: { git: ${dav1d.url} }\nversions: { git-tags: '^(\\d+\\.\\d+\\.\\d+)$' }\nplatforms: all\n`,
    'recipes/nv-codec/recipe.yml': `name: nv-codec\nlicense: MIT\nsource: { git: ${nvcodec.url} }\nversions: { git-tags: '^n(\\d+\\.\\d+\\.\\d+\\.\\d+)$' }\nnotes:\n  "13.1": needs NVIDIA driver 610+\nplatforms: [linux-x64, win-x64]\n`,
    'recipes/x264/recipe.yml': `name: x264\nlicense: GPL-2.0-or-later\nsource: { git: ${x264.url} }\nversions: { git-branch: stable }\nplatforms: all\n`,
    'recipes/lame/recipe.yml': `name: lame\nlicense: LGPL-2.0-or-later\nsource: { url: "${listing.url}/lame-{version}.tar.gz" }\nversions: { listing: "${listing.url}/lame/", files: '^(\\d+\\.\\d+)$' }\nplatforms: all\n`,
  });
  const profiles = mkdtempSync(join(tmpdir(), 'ffmpeg-build-profiles-'));
  writeFileSync(
    join(profiles, 'p.yml'),
    'name: p\nffmpeg: [8, 9]\nplatforms: [linux-x64, win-x64]\nlicense: gplv3\nwith: [dav1d, nvenc, x264, libmp3lame]\npin:\n  - nvenc: { version: "13.0", platforms: [win-x64] }\n',
  );
  return { engine, profiles, env: { FFMPEG_BUILD_DATA: engine }, ffmpeg, dav1d, nvcodec, x264, listing, close: listing.close };
}
