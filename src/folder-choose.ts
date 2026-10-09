// Choosing versions for a folder of targets: one FFmpeg release per series and one version per library, shared by
// every target. Pins are constraints: a version must satisfy every pin that applies (the folder's, and each target's
// that builds the library), and every option's minimum. Nothing is picked per target.
import { pinFormProblem } from './check.ts';
import type { Mode, Row, Skipped, Upstreams } from './choose.ts';
import { alwaysBuilt, knownMajors, optionRecipe, optionsOf, recipeForPin, resolveName, type EngineData } from './engine-data.ts';
import type { FolderLock } from './lockfile.ts';
import { isCommit, satisfies } from './ranges.ts';
import { availability, planProfile, type Cell, type CellPlan } from './resolve.ts';
import { targetProfile, type Folder, type Target } from './targets.ts';
import { andList } from './text.ts';
import { compareVersions, inSeries, isVersion } from './versions.ts';

export interface FolderRow extends Row {
  targets?: string[]; // the targets that use it, when not all of them do
  newMinor?: { from: string; to: string; adds: string[]; missing: string[]; missingIn: Record<string, string[]> };
}
export interface FolderChoice { lock: Omit<FolderLock, 'engine'>; rows: FolderRow[]; missing: string[]; errors: string[] }

interface Constraint { range: string; source: string } // source: "folder pin" or "target <name>"
export interface Requirement { recipe: string; constraints: Constraint[]; min?: string; targets: string[] }

const majorOf = (v: string) => v.split('.')[0]!;
const minorOf = (v: string) => v.split('.').slice(0, 2).join('.');
const newest = (versions: readonly string[]) => [...versions].sort(compareVersions).at(-1);

export function chooseFolder(folder: Folder, data: EngineData, old: FolderLock | undefined, upstreams: Upstreams, mode: Mode): FolderChoice {
  const rows: FolderRow[] = [];
  const missing = new Set<string>();
  const errors: string[] = [];

  const ffmpeg = chooseFfmpegSeries(folder, data, old, upstreams, mode, rows, missing, errors);
  if (missing.size || errors.length) return { lock: { ffmpeg, libraries: {} }, rows, missing: [...missing], errors };

  const builds: { target: Target; cell: CellPlan }[] = [];
  for (const t of folder.targets) {
    const plan = planProfile(targetProfile(folder, t), data, { [t.ffmpeg]: ffmpeg[t.ffmpeg]! });
    if (plan.errors.length) errors.push(...plan.errors.map((e) => `${t.name}: ${e}`));
    else builds.push(...plan.cells.map((cell) => ({ target: t, cell })));
  }
  if (errors.length) return { lock: { ffmpeg, libraries: {} }, rows, missing: [...missing], errors };

  const requirements = collectLibraryRequirements(folder, data, builds, errors);
  const libraries: Record<string, string> = {};
  for (const req of requirements) {
    const before = old?.libraries[req.recipe];
    const pick = chooseLibraryVersion(data, req, before, upstreams, mode);
    if ('missing' in pick) {
      missing.add(req.recipe);
      continue;
    }
    if ('error' in pick) {
      errors.push(pick.error);
      continue;
    }
    libraries[req.recipe] = pick.version;
    const row: FolderRow = { what: req.recipe, to: pick.version };
    if (before) row.from = before;
    if (pick.skipped) row.skipped = pick.skipped;
    if (req.targets.length < folder.targets.length) row.targets = req.targets;
    rows.push(row);
  }
  return { lock: { ffmpeg, libraries }, rows, missing: [...missing].sort(), errors };
}

/**
 * Each series the targets build, chosen once. `latest` targets share one major; it moves to a newer major only if no
 * `latest` target would lose something it lists there.
 */
function chooseFfmpegSeries(folder: Folder, data: EngineData, old: FolderLock | undefined, upstreams: Upstreams, mode: Mode, rows: FolderRow[], missing: Set<string>, errors: string[]): Record<string, string> {
  const ffmpeg: Record<string, string> = {};
  for (const series of [...new Set(folder.targets.map((t) => t.ffmpeg))].sort()) {
    const before = old?.ffmpeg[series];
    const allowed = (v: string) => isVersion(v) && (series === 'latest' ? data.ffmpeg.has(majorOf(v)) : inSeries(v, series));
    if (mode === 'keep' && before && allowed(before)) {
      ffmpeg[series] = before;
      rows.push({ what: `FFmpeg ${series}`, from: before, to: before });
      continue;
    }
    if (!upstreams.ffmpeg) {
      missing.add('ffmpeg');
      continue;
    }
    const all = [...upstreams.ffmpeg].sort(compareVersions);
    const top = all.at(-1);
    const newestIn = (s: string) => newest(all.filter((v) => inSeries(v, s)));
    let version: string | undefined;
    let skipped: Skipped | undefined;
    if (series !== 'latest') {
      version = newestIn(series);
      if (!version) {
        errors.push(`FFmpeg ${series}: no release found upstream`);
        continue;
      }
      if (top && compareVersions(top, version) > 0) skipped = { version: top, reason: `targets build ffmpeg: ${series}` };
    } else {
      let major = knownMajors(data).filter((m) => newestIn(m)).at(-1);
      if (!major) {
        errors.push('FFmpeg latest: no release of a major ffmpeg-build knows was found upstream');
        continue;
      }
      const was = before ? majorOf(before) : undefined;
      if (was && Number(major) > Number(was) && data.ffmpeg.has(was) && newestIn(was)) {
        const lost = folder.targets.filter((t) => t.ffmpeg === 'latest').flatMap((t) => lostOn(data, t, newestIn(was)!, newestIn(major!)!));
        if (lost.length) {
          skipped = { version: newestIn(major)!, reason: `${andList([...new Set(lost)])} wouldn't be available on FFmpeg ${major}` };
          major = was;
        }
      }
      version = newestIn(major)!;
      if (!skipped && top && compareVersions(top, version) > 0) skipped = { version: top, reason: `ffmpeg-build has no data for FFmpeg ${majorOf(top)} yet` };
    }
    ffmpeg[series] = version;
    const row: FolderRow = { what: `FFmpeg ${series}`, to: version };
    if (before) row.from = before;
    if (skipped) row.skipped = skipped;
    if (before && (series === 'latest' || /^\d+$/.test(series)) && majorOf(before) === majorOf(version) && minorOf(before) !== minorOf(version)) {
      row.newMinor = newMinorFindings(folder, data, series, before, version);
    }
    rows.push(row);
  }
  return ffmpeg;
}

/** What a new minor adds, and for each addition the targets on that series that neither list nor turn it down. */
function newMinorFindings(folder: Folder, data: EngineData, series: string, before: string, version: string): NonNullable<FolderRow['newMinor']> {
  const options = optionsOf(data, majorOf(version));
  const adds = [...options.values()]
    .filter((o) => o.since && compareVersions(o.since, before) > 0 && compareVersions(o.since, version) <= 0)
    .map((o) => o.name)
    .sort();
  const missingIn: Record<string, string[]> = {};
  for (const option of adds.filter((n) => !alwaysBuilt(options.get(n)!))) {
    const lacking = folder.targets
      .filter((t) => t.ffmpeg === series && ![...t.with, ...t.without].some((n) => resolveName(data, n) === option))
      .map((t) => t.name);
    if (lacking.length) missingIn[option] = lacking;
  }
  return { from: minorOf(before), to: minorOf(version), adds, missing: Object.keys(missingIn), missingIn };
}

/** Options target `t` lists that build on release `from` but nowhere on release `to`. */
function lostOn(data: EngineData, t: Target, from: string, to: string): string[] {
  const at = (version: string): Cell => ({ series: 'latest', major: majorOf(version), version, license: t.license, platform: t.platform });
  return t.with.flatMap((n) => {
    const option = resolveName(data, n);
    return option && !availability(data, at(from), option) && availability(data, at(to), option) ? [option] : [];
  });
}

/** For each library some build needs: every pin that applies to it, the highest option minimum, and its targets. */
export function collectLibraryRequirements(folder: Folder, data: EngineData, builds: { target: Target; cell: CellPlan }[], errors: string[]): Requirement[] {
  const reqs = new Map<string, Requirement>();
  for (const { target, cell } of builds) {
    const options = optionsOf(data, cell.cell.major);
    for (const recipe of cell.recipes) {
      const req = reqs.get(recipe) ?? { recipe, constraints: [], targets: [] };
      if (!req.targets.includes(target.name)) req.targets.push(target.name);
      for (const [name, range] of Object.entries(target.pin)) {
        const pinned = recipeForPin(data, name);
        if ('recipe' in pinned && pinned.recipe === recipe) req.constraints.push({ range, source: `target ${target.name}` });
      }
      for (const o of cell.options) {
        const info = options.get(o);
        if (info && optionRecipe(info, cell.cell.platform) === recipe && info.min && (!req.min || compareVersions(info.min, req.min) > 0)) req.min = info.min;
      }
      reqs.set(recipe, req);
    }
  }
  // folder pins apply to every build of their library; one that matches no build is a mistake
  for (const [name, range] of Object.entries(folder.pin)) {
    const pinned = recipeForPin(data, name);
    if ('error' in pinned) {
      errors.push(`pin ${name}: ${pinned.error}`);
      continue;
    }
    const req = reqs.get(pinned.recipe);
    const form = pinFormProblem(data, pinned.recipe, name, range);
    if (form) errors.push(`pin ${name}: ${form}`);
    else if (!req) errors.push(`pin ${name}: no target builds ${pinned.recipe}; remove the pin`);
    else req.constraints.unshift({ range, source: 'folder pin' });
  }
  for (const t of folder.targets) {
    for (const [name, range] of Object.entries(t.pin)) {
      const pinned = recipeForPin(data, name);
      const form = 'error' in pinned ? undefined : pinFormProblem(data, pinned.recipe, name, range);
      if ('error' in pinned) errors.push(`targets.${t.name}: pin ${name}: ${pinned.error}`);
      else if (form) errors.push(`targets.${t.name}: pin ${name}: ${form}`);
      else if (!reqs.get(pinned.recipe)?.targets.includes(t.name)) errors.push(`targets.${t.name}: pin ${name}: this target doesn't build ${pinned.recipe}; remove the pin`);
    }
  }
  return [...reqs.values()].sort((a, b) => a.recipe.localeCompare(b.recipe));
}

/** One library's version: the newest upstream release meeting every constraint and the minimum (or the kept one). */
export function chooseLibraryVersion(data: EngineData, req: Requirement, before: string | undefined, upstreams: Upstreams, mode: Mode): { version: string; skipped?: Skipped } | { missing: true } | { error: string } {
  const branch = 'git-branch' in data.recipes.get(req.recipe)!.versions;
  const commits = [...new Set(req.constraints.map((c) => c.range))];
  if (branch && commits.length > 1) return { error: `${req.recipe}: pins name different commits (${describe(req.constraints)}); pin one commit` };
  const allowed = (v: string) =>
    branch
      ? commits.length ? v === commits[0] : isCommit(v)
      : isVersion(v) && req.constraints.every((c) => satisfies(v, c.range)) && (!req.min || compareVersions(v, req.min) >= 0);
  if (mode === 'keep' && before && allowed(before)) return { version: before };
  const found = upstreams.libraries.get(req.recipe);
  if (!found) return { missing: true };
  if ('commit' in found) {
    const version = commits[0] ?? found.commit;
    return commits.length && found.commit !== version ? { version, skipped: { version: found.commit, reason: `outside pin "${version}"` } } : { version };
  }
  const top = found.versions.at(-1)!;
  const version = newest(found.versions.filter(allowed));
  if (!version) {
    const why = [req.constraints.length ? describe(req.constraints) : '', req.min ? `FFmpeg's minimum ${req.min}` : ''].filter(Boolean).join(' and ');
    return { error: `${req.recipe}: no upstream version fits ${why} (newest upstream: ${top})` };
  }
  if (req.constraints.length && compareVersions(top, version) > 0) {
    const skipped: Skipped = { version: top, reason: `outside ${describe(req.constraints)}` };
    const note = Object.entries(data.recipes.get(req.recipe)!.notes ?? {}).find(([range]) => satisfies(top, range))?.[1];
    if (note) skipped.note = note;
    return { version, skipped };
  }
  return { version };
}

const describe = (constraints: Constraint[]) => constraints.map((c) => `\`${c.range}\` (${c.source})`).join(' and ');

/** Whether the folder's lock still fits its targets exactly: nothing missing, nothing extra, every pin met. */
export function folderLockMatches(folder: Folder, data: EngineData, lock: FolderLock | undefined): boolean {
  if (!lock) return false;
  const c = chooseFolder(folder, data, lock, { libraries: new Map() }, 'keep');
  const sorted = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return !c.missing.length && !c.errors.length && sorted(c.lock.ffmpeg) === sorted(lock.ffmpeg) && sorted(c.lock.libraries) === sorted(lock.libraries);
}
