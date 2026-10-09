// lock / update / outdated on a folder of targets: one ffmpeg.lock for the folder, one version per library.
import { join } from 'node:path';
import type { Mode, Upstreams } from '../choose.ts';
import type { EngineData } from '../engine-data.ts';
import { chooseFolder, type FolderChoice, type FolderRow } from '../folder-choose.ts';
import { formatFolderLock, LOCK_FILE, readFolderLock, type FolderLock } from '../lockfile.ts';
import { packageVersion } from '../paths.ts';
import type { Folder } from '../targets.ts';
import { compareVersions } from '../versions.ts';
import { FetchError } from '../fetch.ts';
import { runFolderCheck } from './folder.ts';
import { releaseRows } from './releases.ts';
import { shortVersion, stageAndSwap, upstreamFetcher, UpstreamFailure, type Fetch } from './versions.ts';

type Result = { output: string; exitCode: number };

/** Choose, look up whatever is still missing, choose again: FFmpeg first, then the libraries the builds use. */
async function chooseWithLookups(folder: Folder, data: EngineData, old: FolderLock | undefined, mode: Mode, upstreams: Upstreams, fetch: Fetch): Promise<FolderChoice> {
  for (let round = 0; round < 4; round++) {
    const choice = chooseFolder(folder, data, old, upstreams, mode);
    if (!choice.missing.length) return choice;
    await fetch(choice.missing, upstreams);
  }
  throw new Error('ffmpeg-build: versions still missing after four lookups (this is a bug)');
}

/** The one line for an FFmpeg major newer than every series the targets build (when the folder wants it). */
function newMajorNote(folder: Folder, choice: FolderChoice, upstreams: Upstreams): string | undefined {
  if (!folder.notify.newFfmpeg || !upstreams.ffmpeg?.length) return undefined;
  const top = [...upstreams.ffmpeg].sort(compareVersions).at(-1)!;
  // a `latest` target moves to a new major by itself (or says why it can't), so only numbered series count
  const built = Object.entries(choice.lock.ffmpeg).filter(([series]) => series !== 'latest').map(([, v]) => Number(v.split('.')[0]));
  const topMajor = Number(top.split('.')[0]);
  if (!built.length || topMajor <= Math.max(...built)) return undefined;
  return `FFmpeg ${topMajor} is out; your targets build ${[...new Set(built)].sort((a, b) => a - b).join(', ')} (add targets for ${topMajor}, or use ffmpeg: latest)`;
}

const fold = (folder: Folder, r: FolderRow) => (r.targets && r.targets.length < folder.targets.length ? r.targets.join(', ') : '');

/** The update PR text: new-minor callouts, the new-major note, and one table for the folder. */
export function formatFolderSummary(folder: Folder, choice: FolderChoice, note?: string): string {
  const out = ['# ffmpeg: update ffmpeg.lock', '', '_Written by `ffmpeg-build update`. Only `ffmpeg.lock` changed._'];
  for (const r of choice.rows.filter((x) => x.newMinor)) {
    const m = r.newMinor!;
    out.push('', `## ⚠ New FFmpeg minor: ${m.from} -> ${m.to}`, `Targets on \`ffmpeg: ${r.what.replace(/^FFmpeg /, '')}\` move to it. To stay on ${m.from}.x, write \`ffmpeg: "${m.from}"\` on them.`);
    const shown = (a: string) => (m.missingIn[a] ? `\`${a}\` (not in ${m.missingIn[a]!.join(', ')}: \`ffmpeg-build profile add ${a} --to <base or target>\`)` : `\`${a}\``);
    if (m.adds.length) out.push(`- new: ${m.adds.map(shown).join(', ')}`);
  }
  if (note) out.push('', `## ${note}`);
  const changes = choice.rows.filter((r) => r.from !== r.to);
  if (!changes.length) out.push('', 'Nothing to update.');
  else out.push('', '| | from | to | targets |', '|---|---|---|---|');
  for (const r of changes) {
    const who = fold(folder, r);
    out.push(`| ${r.what} | ${r.from ? shortVersion(r.from) : '-'} | ${r.newMinor ? `**${r.to}**` : shortVersion(r.to)} |${who ? ` ${who} ` : ' '}|`);
  }
  const skipped = choice.rows.filter((r) => r.skipped);
  if (skipped.length) {
    out.push('', '### Not applied');
    for (const r of skipped) out.push(`- **${r.what === r.what.replace(/^FFmpeg /, '') ? r.what : 'FFmpeg'} ${shortVersion(r.skipped!.version)}**: ${r.skipped!.reason}${r.skipped!.note ? ` - ${r.skipped!.note}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Removals since each release's last published one. When the last releases can't be read (no repository known, no
 * token, offline), that is a note, not a stop: bundle checks again, strictly, before anything is published.
 */
async function removalGuard(folder: Folder, data: EngineData, lock: FolderLock): Promise<{ errors: string[]; notes: string[] }> {
  try {
    // targets that can't build yet have no releases to compare with
    const { rows } = await releaseRows(folder, data, { lock, skipUnbuildable: true });
    return { errors: rows.flatMap((r) => r.removals), notes: [] };
  } catch (e) {
    if (e instanceof FetchError) return { errors: [], notes: [`note: couldn't read the last releases to check for removals (${e.message})`] };
    throw e;
  }
}

/** `lock` (keep) and `update`: check every target, choose for the folder, write ffmpeg.lock only if all went well. */
export async function runFolderLockOrUpdate(folder: Folder, data: EngineData, options: { mode: Mode; summary?: string }, fetch: Fetch = upstreamFetcher(data)): Promise<Result> {
  const checked = runFolderCheck(folder, data, { ignoreLock: true });
  if (checked.exitCode) return { output: `${checked.output}\n\nNothing was written.`, exitCode: 1 };
  const lockPath = join(folder.dir, LOCK_FILE);
  const old = readFolderLock(lockPath);
  const upstreams: Upstreams = { libraries: new Map() };
  let choice: FolderChoice;
  try {
    choice = await chooseWithLookups(folder, data, old, options.mode, upstreams, fetch);
  } catch (e) {
    if (e instanceof UpstreamFailure) return { output: e.message, exitCode: 2 };
    throw e;
  }
  if (choice.errors.length) return { output: [folder.file, ...choice.errors.map((e) => `  ✗ ${e}`), '', 'Nothing was written.'].join('\n'), exitCode: 1 };
  const lock: FolderLock = { engine: packageVersion(), ...choice.lock };
  // the removal guard: nothing a target had in its last release may disappear unless the folder allows it
  const guard = await removalGuard(folder, data, lock);
  if (guard.errors.length) return { output: [folder.file, ...guard.errors.map((e) => `  ✗ ${e}`), '', 'Nothing was written.'].join('\n'), exitCode: 1 };
  const text = formatFolderLock(lock);
  const changed = !old || formatFolderLock(old) !== text;
  const writes = changed ? [{ path: lockPath, text }] : [];
  if (options.summary) writes.push({ path: options.summary, text: formatFolderSummary(folder, choice, newMajorNote(folder, choice, upstreams)) });
  stageAndSwap(writes);
  return { output: [`${LOCK_FILE}: ${changed ? 'updated' : 'no changes'}`, ...guard.notes].join('\n'), exitCode: 0 };
}

/** What update would do, read-only. */
export async function runFolderOutdated(folder: Folder, data: EngineData, options: { json?: boolean } = {}, fetch: Fetch = upstreamFetcher(data)): Promise<Result> {
  const checked = runFolderCheck(folder, data, { ignoreLock: true, json: options.json === true });
  if (checked.exitCode) return checked;
  const old = readFolderLock(join(folder.dir, LOCK_FILE));
  const upstreams: Upstreams = { libraries: new Map() };
  let choice: FolderChoice;
  try {
    choice = await chooseWithLookups(folder, data, old, 'update', upstreams, fetch);
  } catch (e) {
    if (e instanceof UpstreamFailure) return { output: options.json ? JSON.stringify({ error: e.message }, null, 2) : e.message, exitCode: 2 };
    throw e;
  }
  if (choice.errors.length) return { output: [folder.file, ...choice.errors.map((e) => `  ✗ ${e}`)].join('\n'), exitCode: 1 };
  const note = newMajorNote(folder, choice, upstreams);
  if (options.json) return { output: JSON.stringify({ rows: choice.rows, ...(note ? { note } : {}) }, null, 2), exitCode: 0 };
  const from = (r: FolderRow) => (r.from ? shortVersion(r.from) : '-');
  const w = Math.max(...choice.rows.map((r) => r.what.length)) + 3;
  const fw = Math.max(...choice.rows.map((r) => from(r).length)) + 3;
  const out = [folder.file];
  for (const r of choice.rows) {
    const change = r.from === r.to ? 'up to date' : `-> ${shortVersion(r.to)}`;
    const who = fold(folder, r);
    out.push(`  ${r.what.padEnd(w)}${from(r).padEnd(fw)}${change}${who ? `   (${who})` : ''}`);
    const indent = `  ${''.padEnd(w)}`;
    if (r.newMinor) {
      const lacking = Object.entries(r.newMinor.missingIn).map(([o, ts]) => `${o} not in ${ts.join(', ')}`);
      out.push(`${indent}new FFmpeg minor ${r.newMinor.to}${r.newMinor.adds.length ? ` (adds ${r.newMinor.adds.join(', ')}${lacking.length ? `; ${lacking.join('; ')}` : ''})` : ''}`);
    }
    if (r.skipped) out.push(`${indent}${shortVersion(r.skipped.version)} exists - ${r.skipped.reason}${r.skipped.note ? ` (${r.skipped.note})` : ''}`);
  }
  if (note) out.push('', note);
  const anyChange = choice.rows.some((r) => r.from !== r.to);
  out.push('', anyChange ? 'Run `ffmpeg-build update` to apply (writes ffmpeg.lock only).' : 'Everything is up to date.');
  return { output: out.join('\n'), exitCode: 0 };
}
