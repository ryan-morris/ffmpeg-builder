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

/** The highest published (not draft) release whose tag is `<base>.<build>`, with its manifest; none when there is none. */
export async function previousRelease(repo: string, base: string): Promise<Previous | undefined> {
  let best: { tag: string; build: number } | undefined;
  for (const r of await listReleases(repo)) {
    const t = parseTag(r.tag_name);
    if (r.draft || !t || `${t.group ? `${t.group}-` : ''}${t.ffmpeg}` !== base) continue;
    if (!best || t.build > best.build) best = { tag: r.tag_name, build: t.build };
  }
  if (!best) return undefined;
  try {
    return { ...best, manifest: (await readManifest({ repo, tag: best.tag })).manifest };
  } catch (e) {
    if (e instanceof FetchError && /has no asset manifest\.yml/.test(e.message)) return best;
    throw e;
  }
}
