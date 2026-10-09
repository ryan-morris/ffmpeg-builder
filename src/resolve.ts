import { allowedLicenses, depsOn, knownMajors, licenseBlocker, optionRecipe, optionsOf, recipeForPin, resolveName, type EngineData } from './engine-data.ts';
import { expandPlatforms, platformMatches } from './platforms.ts';
import type { Profile } from './profile.ts';
import type { FfmpegLicenseClass } from './schema/engine.ts';
import { LICENSES, type Condition, type License } from './schema/profile.ts';
import { compareVersions, inSeries, matchesVersionCondition } from './versions.ts';

export interface Variant { series: string; major: string; version: string; license: License }
export interface Cell extends Variant { platform: string }
export interface Absence { kind: 'ffmpeg' | 'platform' | 'license'; reason: string }
export interface WithResult { index: number; option: string; absence?: Absence }
export interface Conflict { group: string; message: string }
export interface LeftOut { recipe: string; uses: string; kind: 'platform' | 'license'; reason: string } // a `uses` piece this build can't have
export interface CellPlan {
  cell: Cell;
  options: string[]; // what this build includes, sorted
  recipes: string[]; // libraries, dependencies first
  pins: Record<string, string>; // library -> pinned version ("13.0"), first matching pin entry wins
  groups: Record<string, string | undefined>; // e.g. { tls: 'openssl' }; undefined when none is in
  withResults: WithResult[]; // every `with` entry whose condition matches this cell
  removed: string[]; // taken out by `without`
  leftOut: LeftOut[];
  conflicts: Conflict[];
}
export interface ProfilePlan { variants: Variant[]; platforms: string[]; cells: CellPlan[]; errors: string[] }

export const LICENSE_ALLOWS: Record<FfmpegLicenseClass, License[]> = {
  gpl: ['gplv2', 'gplv3', 'nonfree'],
  version3: ['lgplv3', 'gplv3', 'nonfree'],
  nonfree: ['nonfree'],
};
const LICENSE_TEXT: Record<FfmpegLicenseClass, string> = {
  gpl: 'is GPL-only',
  version3: 'needs version 3 (lgplv3, gplv3 or nonfree)',
  nonfree: 'is nonfree-only: it needs license: nonfree',
};

export function conditionMatches(cond: Condition | undefined, cell: Cell): boolean {
  if (!cond) return true;
  if (cond.ffmpeg && !cond.ffmpeg.some((c) => matchesVersionCondition(cell.version, c))) return false;
  if (cond.platforms && !platformMatches(cell.platform, cond.platforms)) return false;
  if (cond.license && !cond.license.includes(cell.license)) return false;
  return true;
}

/**
 * The profile licenses `option` may be built into: FFmpeg's own class, and its library's licence with what it needs
 * on `platform` (on every platform when none is given).
 */
export function optionLicenses(data: EngineData, major: string, option: string, platform?: string): License[] {
  const info = optionsOf(data, major).get(option);
  const byClass = info?.ffmpegLicense ? LICENSE_ALLOWS[info.ffmpegLicense] : [...LICENSES];
  if (!info?.libraries.length) return byClass;
  if (platform) {
    const lib = optionRecipe(info, platform);
    return lib ? byClass.filter((l) => allowedLicenses(data, lib, platform).includes(l)) : []; // no library there
  }
  // no platform: what every library of the option allows
  return byClass.filter((l) => info.libraries.every((d) => allowedLicenses(data, d.name).includes(l)));
}

/** Why `option` can't be in this cell's build, or undefined when it can. */
export function availability(data: EngineData, cell: Cell, option: string): Absence | undefined {
  const info = optionsOf(data, cell.major).get(option);
  if (!info) {
    const later = knownMajors(data).find((m) => Number(m) > Number(cell.major) && optionsOf(data, m).has(option));
    const since = later ? (optionsOf(data, later).get(option)!.since ?? `${later}.0`) : undefined;
    return { kind: 'ffmpeg', reason: since ? `FFmpeg added ${option} in ${since}` : `FFmpeg ${cell.major} doesn't offer ${option}` };
  }
  if (info.since && compareVersions(cell.version, info.since) < 0) return { kind: 'ffmpeg', reason: `FFmpeg added ${option} in ${info.since}` };
  if (info.ffmpegLicense && !LICENSE_ALLOWS[info.ffmpegLicense].includes(cell.license)) {
    return { kind: 'license', reason: `${option} ${LICENSE_TEXT[info.ffmpegLicense]} (FFmpeg's own classification)` };
  }
  if (info.platforms && !platformMatches(cell.platform, info.platforms)) return { kind: 'platform', reason: `FFmpeg doesn't support ${option} there` };
  // engine data guarantees a recipe's needs build wherever the recipe does, so the recipe decides
  const lib = optionRecipe(info, cell.platform);
  if (info.libraries.length && !lib) return { kind: 'platform', reason: `ffmpeg-build has no library for ${option} there` };
  if (lib && !platformMatches(cell.platform, data.recipes.get(lib)!.platforms)) {
    return { kind: 'platform', reason: `the ${lib} recipe doesn't build there` };
  }
  if (lib) {
    const blocker = licenseBlocker(data, lib, cell.license, cell.platform);
    if (blocker) return { kind: 'license', reason: blocker };
  }
  return undefined;
}

/** `versions` (series → exact version, e.g. from ffmpeg.lock) overrides the newest release in the engine data. */
export function variantsOf(profile: Profile, data: EngineData, versions: Record<string, string> = {}): { variants: Variant[]; errors: string[] } {
  const majors = knownMajors(data);
  const variants: Variant[] = [];
  const errors: string[] = [];
  for (const series of profile.ffmpeg) {
    const locked = versions[series];
    const major = series === 'latest' ? (locked?.split('.')[0] ?? majors.at(-1) ?? '?') : series.split('.')[0]!;
    const ff = data.ffmpeg.get(major);
    if (!ff) {
      errors.push(`ffmpeg: ${series}: ffmpeg-build has no data for FFmpeg ${major} (it knows ${majors.join(', ')})`);
      continue;
    }
    const version = locked ?? [...ff.releases].filter((r) => series === 'latest' || inSeries(r, series)).sort(compareVersions).at(-1);
    if (!version) {
      errors.push(`ffmpeg: ${series}: no FFmpeg ${series} release is known yet`);
      continue;
    }
    for (const license of profile.license) variants.push({ series, major, version, license });
  }
  return { variants, errors };
}

export function resolveCell(profile: Profile, data: EngineData, cell: Cell): CellPlan {
  const options = optionsOf(data, cell.major);
  const selected = new Set<string>(); // only what `with:` lists: the code adds nothing by itself
  const withResults: WithResult[] = [];
  profile.with.forEach((entry, index) => {
    if (!conditionMatches(entry.cond, cell)) return;
    const option = resolveName(data, entry.name);
    if (!option) return; // unknown names are reported by check
    const absence = availability(data, cell, option);
    withResults.push(absence ? { index, option, absence } : { index, option });
    if (!absence) selected.add(option);
  });

  const removed: string[] = [];
  for (const entry of profile.without) {
    if (!conditionMatches(entry.cond, cell)) continue;
    const option = resolveName(data, entry.name);
    if (!option) continue;
    if (selected.delete(option)) removed.push(option);
  }

  const groups: Record<string, string | undefined> = {};
  const conflicts: Conflict[] = [];
  const groupNames = [...new Set([...options.values()].flatMap((o) => (o.group ? [o.group] : [])))].sort();
  for (const group of groupNames) {
    // FFmpeg takes one member of a group per build; the profile picks it, and two are a conflict, never a choice
    const members = [...selected].filter((n) => options.get(n)!.group === group).sort();
    if (members.length > 1) conflicts.push({ group, message: `${members.join(' and ')} are both in this build, but FFmpeg uses one ${group} per build` });
    groups[group] = members.length === 1 ? members[0] : undefined;
  }

  const chosenOptions = [...selected].sort();
  const { order: recipes, leftOut } = cellBuildOrder(data, cell, chosenOptions.flatMap((n) => optionRecipe(options.get(n)!, cell.platform) ?? []));

  const pins: Record<string, string> = {};
  for (const entry of profile.pin) {
    if (!conditionMatches(entry.cond, cell)) continue;
    const target = recipeForPin(data, entry.name);
    if ('recipe' in target && recipes.includes(target.recipe) && !(target.recipe in pins)) pins[target.recipe] = entry.version;
  }
  return { cell, options: chosenOptions, recipes, pins, groups, withResults, removed, conflicts, leftOut };
}

/** The libraries a build needs, dependencies first: every `needs`, and each `uses` its license and platform allow. */
export function cellBuildOrder(data: EngineData, cell: Cell, roots: readonly string[]): { order: string[]; leftOut: LeftOut[] } {
  const order: string[] = [];
  const leftOut: LeftOut[] = [];
  const seen = new Set<string>();
  const visit = (r: string) => {
    if (seen.has(r)) return;
    seen.add(r);
    const recipe = data.recipes.get(r)!;
    for (const dep of depsOn(recipe, 'needs', cell.platform).sort()) visit(dep);
    for (const use of depsOn(recipe, 'uses', cell.platform).sort()) {
      if (!platformMatches(cell.platform, data.recipes.get(use)!.platforms)) {
        leftOut.push({ recipe: r, uses: use, kind: 'platform', reason: `${use} doesn't build there` });
        continue;
      }
      const blocker = licenseBlocker(data, use, cell.license, cell.platform);
      if (blocker) leftOut.push({ recipe: r, uses: use, kind: 'license', reason: blocker });
      else visit(use);
    }
    order.push(r);
  };
  [...roots].sort().forEach(visit);
  return { order, leftOut };
}

export function planProfile(profile: Profile, data: EngineData, versions: Record<string, string> = {}): ProfilePlan {
  const { variants, errors } = variantsOf(profile, data, versions);
  const platforms = expandPlatforms(profile.platforms);
  const cells = errors.length ? [] : variants.flatMap((v) => platforms.map((platform) => resolveCell(profile, data, { ...v, platform })));
  return { variants, platforms, cells, errors };
}
