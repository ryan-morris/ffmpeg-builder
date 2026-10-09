// The read-only commands on a folder of targets (ffmpeg-build.yml): check, plan, show, targets.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { join } from 'node:path';
import { checkProfile, type ProfileReport } from '../check.ts';
import { recipeForPin, resolveName, type EngineData } from '../engine-data.ts';
import { collectLibraryRequirements, folderLockMatches } from '../folder-choose.ts';
import { formatPlan, formatReport, planJson, problemLines } from '../format.ts';
import { LOCK_FILE, readFolderLock, type FolderLock, type LockedProfile } from '../lockfile.ts';
import { availability, planProfile, type CellPlan } from '../resolve.ts';
import { addTo, missingByTarget, removeFrom, targetsReached } from '../folder-edit.ts';
import { initFolder, shippedFolder, type Selection } from '../folder-init.ts';
import { editFile } from '../profile-edit.ts';
import { looksLikeProfileFile } from '../profile.ts';
import { FOLDER_FILE, loadFolder, targetProfile, type Folder, type Target } from '../targets.ts';

type Result = { output: string; exitCode: number };

/** A usage problem with the folder or a target name: exit 2. */
export class FolderError extends Error {}

/** Whether `dir` holds a folder file (the targets format). */
export function hasFolder(dir = '.'): boolean {
  return existsSync(join(dir, FOLDER_FILE));
}

/** Whether this folder's ffmpeg-build.yml is really an old matrix profile (a profile's keys and no targets:). */
export function oldFormatFolderFile(dir = '.'): boolean {
  if (!hasFolder(dir)) return false;
  try {
    const raw = parseDocument(readFileSync(join(dir, FOLDER_FILE), 'utf8'), { schema: 'failsafe' }).toJSON() as unknown;
    return typeof raw === 'object' && raw !== null && !('targets' in raw) && ['name', 'platforms', 'license'].some((k) => k in raw);
  } catch {
    return false;
  }
}

/** The old matrix profiles in a folder: *.yml files with a profile's keys (ffmpeg-build.yml only when it is one). */
export function oldProfiles(dir = '.'): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.ya?ml$/.test(d.name) && (d.name === FOLDER_FILE ? oldFormatFolderFile(dir) : looksLikeProfileFile(join(dir, d.name))))
    .map((d) => d.name)
    .sort();
}

/** The folder's ffmpeg-build.yml, loaded and checked for shape; without one, old profiles here get the migrate hint. */
export function openFolder(dir = '.'): Folder {
  if (!hasFolder(dir) || oldFormatFolderFile(dir)) {
    const old = oldProfiles(dir);
    if (old.length) {
      throw new FolderError(
        `${old.join(', ')} ${old.length > 1 ? 'are old matrix profiles' : 'is an old matrix profile'}: ffmpeg-build now reads ${FOLDER_FILE}, one target per build. Run \`ffmpeg-build migrate\` here to convert (the old files are kept as *.old).`,
      );
    }
  }
  const r = loadFolder(dir);
  if (!r.ok) throw new FolderError([`${r.file}:`, ...r.errors.map((e) => `  ✗ ${e}`)].join('\n'));
  return r.folder;
}

const header = (t: Target, lock?: FolderLock) =>
  `target ${t.name} (${t.platform}, ${t.license}, FFmpeg ${t.ffmpeg}${lock?.ffmpeg[t.ffmpeg] ? `: ${lock.ffmpeg[t.ffmpeg]}` : ''})`;

const pick = (folder: Folder, name?: string): Target[] => {
  if (!name) return folder.targets;
  const t = folder.targets.find((x) => x.name === name);
  if (!t) throw new FolderError(`no target ${name} in ${FOLDER_FILE} (targets: ${folder.targets.map((x) => x.name).join(', ')})`);
  return [t];
};

/** A target's locked FFmpeg release, as planProfile takes it (none: the newest the data knows). */
const lockedVersion = (t: Target, lock?: FolderLock): Record<string, string> => (lock?.ffmpeg[t.ffmpeg] ? { [t.ffmpeg]: lock.ffmpeg[t.ffmpeg]! } : {});

/** The pins that bind a target's libraries (the folder's, then its own), by library: `13.0`, or `13.0 and ~13.0.19`. */
function pinsOf(folder: Folder, t: Target, data: EngineData, cell: CellPlan): Record<string, string> {
  const by: Record<string, string[]> = {};
  for (const [name, range] of [...Object.entries(folder.pin), ...Object.entries(t.pin)]) {
    const pinned = recipeForPin(data, name);
    if ('recipe' in pinned && cell.recipes.includes(pinned.recipe)) (by[pinned.recipe] ??= []).push(range);
  }
  return Object.fromEntries(Object.entries(by).map(([recipe, ranges]) => [recipe, ranges.join(' and ')]));
}

/** The one build of a target, at its locked FFmpeg release when the lock has it (else the newest the data knows). */
function buildOf(folder: Folder, t: Target, data: EngineData, lock?: FolderLock): CellPlan | undefined {
  return planProfile(targetProfile(folder, t), data, lockedVersion(t, lock)).cells[0];
}

/** Problems of the folder as a whole, the lock included: what stops any build. */
export function folderErrors(folder: Folder, data: EngineData, lock: FolderLock | undefined): string[] {
  return folderProblems(folder, data, lock, true);
}

/** Problems of the folder as a whole: pins that match no build, and (when it must match) a lock that no longer fits. */
function folderProblems(folder: Folder, data: EngineData, lock: FolderLock | undefined, lockMustMatch: boolean): string[] {
  const errors: string[] = [];
  const builds = folder.targets.flatMap((t) => {
    const cell = buildOf(folder, t, data, lock);
    return cell ? [{ target: t, cell }] : [];
  });
  collectLibraryRequirements(folder, data, builds, errors);
  if (lock && lockMustMatch && !errors.length && !folderLockMatches(folder, data, lock)) errors.push(`${LOCK_FILE} doesn't match the targets; run ffmpeg-build lock`);
  return errors;
}

export function runFolderCheck(folder: Folder, data: EngineData, options: { target?: string; json?: boolean; ignoreLock?: boolean } = {}): Result {
  // the lock's FFmpeg releases are what the targets are judged by, even when lock/update is about to rewrite it
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const reports: ProfileReport[] = [];
  const general = options.target ? [] : folderProblems(folder, data, lock, !options.ignoreLock);
  if (general.length) reports.push({ file: folder.file, header: folder.file, blocks: [{ lines: general.map((text) => ({ mark: '✗', text })) }], problems: general.length });
  for (const t of pick(folder, options.target)) {
    reports.push(checkProfile({ ok: true, profile: targetProfile(folder, t) }, data, { target: { header: header(t, lock) }, versions: lockedVersion(t, lock) }));
  }
  const exitCode = reports.some((r) => r.problems) ? 1 : 0;
  return { output: options.json ? JSON.stringify(reports, null, 2) : reports.map(formatReport).join('\n\n'), exitCode };
}

export function runFolderPlan(folder: Folder, data: EngineData, options: { target?: string; json?: boolean } = {}): Result {
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const locked: LockedProfile | undefined = lock ? { ffmpeg: lock.ffmpeg, libraries: lock.libraries, pinned: [] } : undefined;
  const texts: string[] = [];
  const json: unknown[] = [];
  let exitCode = 0;
  for (const t of pick(folder, options.target)) {
    const profile = targetProfile(folder, t);
    const report = checkProfile({ ok: true, profile }, data, { target: { header: header(t, lock) }, versions: lockedVersion(t, lock) });
    if (report.problems) {
      exitCode = 1;
      if (options.json) json.push({ target: t.name, problems: problemLines(report) });
      else texts.push(formatReport(report));
      continue;
    }
    const plan = planProfile(profile, data, lockedVersion(t, lock));
    for (const c of plan.cells) c.pins = pinsOf(folder, t, data, c);
    if (options.json) json.push({ target: t.name, ...planJson(profile, plan, data, locked) });
    else texts.push(formatPlan(profile, plan, data, locked));
  }
  return { output: options.json ? JSON.stringify(json, null, 2) : texts.join('\n\n'), exitCode };
}

/** What one target gets: each entry with the layer that put it there, what it turns down, and its libraries. */
export function runShow(folder: Folder, data: EngineData, name: string, json = false): Result {
  const [t] = pick(folder, name);
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const cell = buildOf(folder, t!, data, lock);
  const entries = [
    ...t!.with.map((n) => {
      const option = resolveName(data, n);
      const absence = cell && option ? availability(data, cell.cell, option) : undefined;
      return { name: n, label: n, from: t!.origin.get(n)!, included: true, ...(absence ? { notBuilt: absence.reason } : {}) };
    }),
    ...t!.without.map((n) => ({ name: n, label: `not ${n}`, from: `${t!.origin.get(n)}: without`, included: false })),
  ];
  const libraries = (cell?.recipes ?? []).map((r) => (lock?.libraries[r] ? `${r} ${lock.libraries[r]}` : r));
  if (json) return { output: JSON.stringify({ target: t!.name, platform: t!.platform, license: t!.license, ffmpeg: t!.ffmpeg, entries, libraries, leftOut: cell?.leftOut ?? [] }, null, 2), exitCode: 0 };
  const width = Math.max(...entries.map((e) => e.label.length)) + 1;
  const out = [header(t!, lock)];
  for (const e of entries) out.push(`  ${e.label.padEnd(width)}(${e.from})${'notBuilt' in e && e.notBuilt ? `   ✗ ${e.notBuilt}` : ''}`);
  if (libraries.length) out.push(`  libraries: ${libraries.join(', ')}`);
  for (const l of cell?.leftOut ?? []) out.push(`  - ${l.recipe} without ${l.uses}: ${l.reason}`);
  return { output: out.join('\n'), exitCode: 0 };
}

/** Which targets get `name`, and why the others don't. */
export function runShowHas(folder: Folder, data: EngineData, name: string, json = false): Result {
  const option = resolveName(data, name);
  if (!option) throw new FolderError(`ffmpeg-build doesn't know "${name}". Use the name FFmpeg gives it, like nvenc, x265 or whisper.`);
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const rows = folder.targets.map((t) => {
    if (t.without.includes(name)) return { target: t.name, has: false, why: `turned down by ${t.origin.get(name)}` };
    if (!t.with.includes(name)) return { target: t.name, has: false, why: 'not listed' };
    const cell = buildOf(folder, t, data, lock);
    const absence = cell ? availability(data, cell.cell, option) : undefined;
    return absence ? { target: t.name, has: false, why: `listed by ${t.origin.get(name)}, but ${absence.reason}` } : { target: t.name, has: true, why: `${t.origin.get(name)}` };
  });
  if (json) return { output: JSON.stringify(rows, null, 2), exitCode: 0 };
  return { output: rows.map((r) => `${r.target}: ${r.has ? 'yes' : 'no'} (${r.why})`).join('\n'), exitCode: 0 };
}

/** The targets, for people and CI matrices: name, platform, license, FFmpeg series and its locked release. */
export function runTargets(folder: Folder, json = false): Result {
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const rows = folder.targets.map((t) => ({
    name: t.name, platform: t.platform, license: t.license, ffmpeg: t.ffmpeg,
    ...(lock?.ffmpeg[t.ffmpeg] ? { version: lock.ffmpeg[t.ffmpeg] } : {}),
  }));
  if (json) return { output: JSON.stringify(rows, null, 2), exitCode: 0 };
  return { output: rows.map((r) => `${r.name}   ${r.platform}, ${r.license}, FFmpeg ${r.ffmpeg}${r.version ? ` (${r.version})` : ''}`).join('\n'), exitCode: 0 };
}

/** `profile add|remove <names> --to|--from <base or target>`: edit the file, then check every target the edit reaches. */
export function runFolderEdit(action: 'add' | 'remove', names: string[], layer: string, data: EngineData): Result {
  const unknown = names.filter((n) => !resolveName(data, n));
  if (unknown.length) throw new FolderError(unknown.map((n) => `ffmpeg-build doesn't know "${n}". Use the name FFmpeg gives it, like nvenc, x265 or whisper.`).join('\n'));
  const path = join('.', FOLDER_FILE);
  const before = readFileSync(path, 'utf8');
  const after = editFile(path, (text) => (action === 'add' ? addTo(text, layer, names) : removeFrom(text, layer, names)));
  if (after === before) {
    return { output: `nothing changed: ${layer} ${action === 'add' ? 'already has' : "doesn't have"} ${names.join(', ')}`, exitCode: 0 };
  }
  const folder = openFolder();
  const reached = targetsReached(folder, layer);
  const reports = reached.map((name) => runFolderCheck(folder, data, { target: name }));
  const lines = [`${action === 'add' ? 'added' : 'removed'} ${names.join(', ')} ${action === 'add' ? 'to' : 'from'} ${layer}${reached.length ? ` (reaches ${reached.join(', ')})` : ''}`];
  // a target's own without: still wins over what its base now gives it
  for (const n of action === 'add' ? names : []) {
    const declining = folder.targets.filter((t) => reached.includes(t.name) && t.without.includes(n)).map((t) => t.name);
    if (declining.length) lines.push(`  ${n} stays out of ${declining.join(', ')}: ${declining.length > 1 ? 'they turn' : 'it turns'} it down (without:)`);
  }
  return { output: [...lines, '', ...reports.map((r) => r.output)].join('\n'), exitCode: reports.some((r) => r.exitCode) ? 1 : 0 };
}

/** What targets could add but don't list or turn down; exit 1 when there is any. */
export function runFolderMissing(folder: Folder, data: EngineData, options: { target?: string; json?: boolean } = {}): Result {
  if (options.target) pick(folder, options.target);
  const found = missingByTarget(folder, data, options.target);
  if (options.json) return { output: JSON.stringify(Object.fromEntries(found), null, 2), exitCode: found.size ? 1 : 0 };
  if (!found.size) return { output: 'nothing missing', exitCode: 0 };
  const out = ['could be added (`ffmpeg-build profile add <name> --to <base or target>`; `without:` turns one down for good):'];
  for (const [option, targets] of found) out.push(`  ${option}: ${targets.join(', ')}`);
  return { output: out.join('\n'), exitCode: 1 };
}

/** `init`: write ffmpeg-build.yml from the shipped targets the selection names (never over an existing one), then check it. */
export function runFolderInit(sel: Selection, from: string, data: EngineData): Result {
  if (hasFolder()) throw new FolderError(`${FOLDER_FILE} already exists here; edit it with \`ffmpeg-build profile add --to\` / \`remove --from\``);
  writeFileSync(FOLDER_FILE, initFolder(shippedFolder(from), sel, from));
  const folder = openFolder();
  const report = runFolderCheck(folder, data);
  return { output: [`wrote ${FOLDER_FILE}: ${folder.targets.map((t) => t.name).join(', ')}`, '', report.output].join('\n'), exitCode: report.exitCode };
}
