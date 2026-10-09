// Where a folder's releases are published, and the last one for a given tag base: the repository comes from
// GITHUB_REPOSITORY (in Actions) or the folder's git remote.
import { execFileSync } from 'node:child_process';
import { FetchError, listReleases, parseTag, readManifest } from './fetch.ts';
import type { Manifest } from './manifest.ts';

/** owner/repo of a GitHub remote URL (https or ssh), or undefined. */
export function repoOfRemote(url: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

/** The repository this folder publishes to, when it can be told. */
export function publishingRepo(dir: string): string | undefined {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    return repoOfRemote(execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return undefined;
  }
}

/** The last release of a tag base. One made before ffmpeg-build has no manifest, but still counts for build numbers. */
export interface Previous { tag: string; build: number; manifest?: Manifest }

async function withManifest(repo: string, at: { tag: string; build: number }): Promise<Previous> {
  try {
    return { ...at, manifest: (await readManifest({ repo, tag: at.tag })).manifest };
  } catch (e) {
    if (e instanceof FetchError && /has no asset manifest\.yml/.test(e.message)) return at;
    throw e;
  }
}

const key = (ffmpeg: string, build: number) => {
  const [a = 0, b = 0, c = 0] = ffmpeg.split('.').map(Number);
  return [a, b, c, build];
};
const later = (x: number[], y: number[]) => {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

/**
 * A release's predecessors among the published (not draft) releases: `sameBase`, the highest build of the same group
 * and FFmpeg version (it numbers the next build); `lastInMajor`, the newest release of the same group and FFmpeg major
 * (what the release follows on from: a move from 9.0.2 to 9.0.3 still compares with 9.0.2's last build).
 */
export async function previousReleases(repo: string, group: string, ffmpeg: string): Promise<{ sameBase?: Previous; lastInMajor?: Previous }> {
  let same: { tag: string; build: number } | undefined;
  let last: { tag: string; build: number; key: number[] } | undefined;
  for (const r of await listReleases(repo)) {
    const t = parseTag(r.tag_name);
    if (r.draft || !t || t.group !== group || t.ffmpeg.split('.')[0] !== ffmpeg.split('.')[0]) continue;
    if (t.ffmpeg === ffmpeg && (!same || t.build > same.build)) same = { tag: r.tag_name, build: t.build };
    const k = key(t.ffmpeg, t.build);
    if (!last || later(k, last.key)) last = { tag: r.tag_name, build: t.build, key: k };
  }
  return {
    ...(same ? { sameBase: await withManifest(repo, same) } : {}),
    ...(last ? { lastInMajor: last.tag === same?.tag ? await withManifest(repo, same) : await withManifest(repo, { tag: last.tag, build: last.build }) } : {}),
  };
}
