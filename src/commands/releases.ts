// `ffmpeg-build releases`: the folder's releases, each with its next tag, whether it is due (anything in it changed
// since its last release) and why, and its targets with the runner each builds on. CI turns `--due --json` into its
// build matrix.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FetchError } from '../fetch.ts';
import type { EngineData } from '../engine-data.ts';
import { LOCK_FILE, readFolderLock, type FolderLock } from '../lockfile.ts';
import { packageRoot } from '../paths.ts';
import { changesSince, planReleases, removals, type PlannedRelease, type TargetFacts } from '../release.ts';
import { previousReleases, publishingRepo, type Previous } from '../release-remote.ts';
import type { Folder } from '../targets.ts';
import { publishingProblems } from '../bundle.ts';
import { FolderError, runFolderCheck } from './folder.ts';

type Result = { output: string; exitCode: number };

export interface ReleaseRow {
  tag: string;
  group: string;
  ffmpeg: string;
  previous?: string;
  due: boolean;
  reasons: string[];
  removals: string[];
  targets: { name: string; platform: string; runner: string; cacheKey: string }[];
}

/**
 * The CI library-cache key of a target: its platform, component versions, toolchain and engine. Anything that changes
 * a library's build changes it, so a stale cache is never restored under the key (restore keys fall back per platform).
 */
const cacheKey = (platform: string, f: TargetFacts) =>
  `ffmpeg-build-libs-${platform}-${createHash('sha256').update(JSON.stringify([f.components, f.toolchain, f.engine])).digest('hex').slice(0, 24)}`;

/** Each release with its last published one (when a repository is known and can be read). */
export async function releaseRows(folder: Folder, data: EngineData, options: { offline?: boolean; lock?: FolderLock; skipUnbuildable?: boolean } = {}): Promise<{ rows: ReleaseRow[]; plans: PlannedRelease[]; previous: Map<string, Previous | undefined> }> {
  const lock = options.lock ?? readFolderLock(join(folder.dir, LOCK_FILE));
  if (!lock) throw new FolderError(`no ${LOCK_FILE} here; run ffmpeg-build lock first`);
  const { releases, errors } = planReleases(folder, data, lock, packageRoot);
  if (errors.length && !options.skipUnbuildable) throw new FolderError(errors.join('\n'));
  const repo = options.offline ? undefined : publishingRepo(folder.dir);
  const previous = new Map<string, Previous | undefined>();
  const rows: ReleaseRow[] = [];
  for (const rel of releases) {
    const found = repo ? await previousReleases(repo, rel.group, rel.ffmpeg) : {};
    // the build number counts within this FFmpeg version; what changed, and what disappeared, is judged against the
    // release this one follows on from: the newest of the same group and FFmpeg major
    const prev = found.sameBase;
    const follows = found.lastInMajor;
    previous.set(rel.base, follows);
    const reasons = follows && !follows.manifest ? [`${follows.tag} has no manifest.yml (made before ffmpeg-build)`] : changesSince(rel, follows?.manifest);
    rows.push({
      tag: `${rel.base}.${prev ? prev.build + 1 : 0}`,
      group: rel.group,
      ffmpeg: rel.ffmpeg,
      ...(follows ? { previous: follows.tag } : {}),
      due: reasons.length > 0,
      reasons,
      removals: removals(rel, follows?.manifest, folder, follows?.slices),
      targets: rel.targets.map((t) => ({ name: t.target.name, platform: t.target.platform, runner: t.runner, cacheKey: cacheKey(t.target.platform, t.facts) })),
    });
  }
  return { rows, plans: releases, previous };
}

/** Exit 1 when check fails or a release would drop something its last release had (the removal guard). */
export async function runReleases(folder: Folder, data: EngineData, options: { json?: boolean; due?: boolean; offline?: boolean } = {}): Promise<Result> {
  const checked = runFolderCheck(folder, data, { json: options.json === true });
  if (checked.exitCode) return checked;
  let rows: ReleaseRow[];
  try {
    rows = (await releaseRows(folder, data, options)).rows;
  } catch (e) {
    if (e instanceof FetchError) throw new FolderError(`couldn't read the last releases: ${e.message} (--offline treats every release as new)`);
    throw e;
  }
  // where they'd be published must be able to take them, before anything is built (and uploaded as a CI artifact)
  const repo = options.offline ? undefined : publishingRepo(folder.dir);
  const refused = await publishingProblems(folder, folder.targets.map((t) => ({ name: t.name, license: t.license })), repo, { strict: false });
  if (refused.length) {
    if (options.json) return { output: JSON.stringify({ error: refused.join('\n') }, null, 2), exitCode: 1 };
    return { output: refused.map((e) => `✗ ${e}`).join('\n'), exitCode: 1 };
  }
  const shown = options.due ? rows.filter((r) => r.due) : rows;
  const exitCode = shown.some((r) => r.removals.length) ? 1 : 0;
  if (options.json) return { output: JSON.stringify(shown, null, 2), exitCode };
  const out: string[] = [];
  for (const r of shown) {
    out.push(`${r.tag}${r.previous ? ` (last: ${r.previous})` : ''}: ${r.due ? 'due' : 'unchanged'}, ${r.targets.length} target${r.targets.length === 1 ? '' : 's'}`);
    for (const why of r.reasons) out.push(`  ${why}`);
    for (const e of r.removals) out.push(`  ✗ ${e}`);
  }
  return { output: out.join('\n') || 'no releases', exitCode };
}
