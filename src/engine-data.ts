import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { describePlatforms, expandPlatformPattern, expandPlatforms, platformMatches, PLATFORMS } from './platforms.ts';
import { formatIssues } from './schema/common.ts';
import { allowedBy, licenseTableSchema, tableFrom, type LicenseTable } from './licenses.ts';
import { isRange } from './ranges.ts';
import { inSeries } from './versions.ts';
import { ffmpegDataSchema, ffmpegSourceSchema, platformsSchema, recipeSchema, type Dep, type PlatformEntry, type FfmpegData, type FfmpegLicenseClass, type Recipe } from './schema/engine.ts';
import { LICENSES, type License } from './schema/profile.ts';
import { parseYaml, YamlError } from './yaml.ts';

export interface EngineData {
  root: string;
  ffmpeg: Map<string, FfmpegData>; // by major, ascending
  recipes: Map<string, Recipe>;
  licenses: LicenseTable; // licenses.yml
  platforms: Map<string, PlatformEntry>; // platforms.yml: the platforms that build, and how
  ffmpegSource: { git: string; tags: string; url: string; mirrors: string[] };
}

export class EngineDataError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`ffmpeg-build's own data has problems:\n${errors.map((e) => `  ${e}`).join('\n')}`);
    this.errors = errors;
  }
}

export interface OptionInfo {
  name: string;
  builtin: boolean;
  recipe?: string; // the option's library when it is the same on every platform
  libraries: Dep[]; // its library per platform (one entry without platforms when it is the same everywhere)
  since?: string;
  min?: string;
  ffmpegLicense?: FfmpegLicenseClass;
  platforms?: string[];
  group?: string;
  kind?: string; // for builtins: muxer, hwaccel, tls, ...
  configure?: string[];
}

export function loadEngineData(root: string): EngineData {
  for (const dir of ['ffmpeg', 'recipes']) {
    if (!existsSync(join(root, dir))) throw new EngineDataError([`${root}: no ${dir}/ folder (is FFMPEG_BUILD_DATA right?)`]);
  }
  const errors: string[] = [];

  const ffmpeg = new Map<string, FfmpegData>();
  const yamlFiles = readdirSync(join(root, 'ffmpeg')).filter((f) => /\.ya?ml$/.test(f));
  for (const f of yamlFiles.filter((f) => !/^\d+\.yml$/.test(f) && f !== 'source.yml')) {
    errors.push(`ffmpeg/${f}: FFmpeg data files are named <major>.yml, like 9.yml`);
  }
  const ffmpegFiles = yamlFiles.filter((f) => /^\d+\.yml$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  if (!ffmpegFiles.length) errors.push('ffmpeg/: no <major>.yml files (like 9.yml)');
  for (const file of ffmpegFiles) {
    const label = `ffmpeg/${file}`;
    const data = parseFile(join(root, 'ffmpeg', file), label, ffmpegDataSchema, errors);
    if (!data) continue;
    if (`${data.major}.yml` !== file) errors.push(`${label}: major is ${data.major} but the file is named ${file}`);
    ffmpeg.set(file.replace(/\.yml$/, ''), data);
  }

  const source = parseFile(join(root, 'ffmpeg', 'source.yml'), 'ffmpeg/source.yml', ffmpegSourceSchema, errors);
  if (source) checkPattern('ffmpeg/source.yml', 'git-tags', source.versions['git-tags'], errors);

  const licenseFile = parseFile(join(root, 'licenses.yml'), 'licenses.yml', licenseTableSchema, errors);
  const licenses: LicenseTable = licenseFile ? tableFrom(licenseFile) : new Map();

  const platformFile = parseFile(join(root, 'platforms.yml'), 'platforms.yml', platformsSchema, errors);
  const platforms = new Map<string, PlatformEntry>();
  for (const [p, entry] of Object.entries(platformFile?.platforms ?? {})) {
    if (!PLATFORMS.includes(p)) errors.push(`platforms.yml: ${p} is not a platform ffmpeg-build knows`);
    platforms.set(p, { image: entry.image, setup: entry.setup, ...(entry.runner ? { runner: entry.runner } : {}), configure: entry.configure ?? [], ships: entry.ships ?? {} });
    for (const [file, { license: expr }] of Object.entries(entry.ships ?? {})) {
      const verdict = allowedBy(expr, licenses);
      if ('unknown' in verdict) errors.push(`platforms.yml: ${p} ships ${file} under "${verdict.unknown.join(', ')}", which is not in licenses.yml; add it there with the profile licenses it may be linked into`);
      if ('invalid' in verdict) errors.push(`platforms.yml: ${p} ships ${file} under "${expr}", which is not an SPDX expression this engine can read`);
    }
  }

  const recipes = new Map<string, Recipe>();
  const recipeDirs = readdirSync(join(root, 'recipes'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of recipeDirs) {
    const label = `recipes/${dir}/recipe.yml`;
    const recipe = parseFile(join(root, 'recipes', dir, 'recipe.yml'), label, recipeSchema, errors);
    if (!recipe) continue;
    if (recipe.name !== dir) errors.push(`${label}: name is ${recipe.name} but the folder is ${dir}`);
    for (const f of recipe['license-files'].filter((f) => f.recipe)) {
      if (!existsSync(join(root, 'recipes', dir, f.path))) errors.push(`${label}: license-files: recipes/${dir}/${f.path} is missing`);
    }
    recipes.set(dir, recipe);
  }

  crossCheck(ffmpeg, recipes, licenseFile ? licenses : undefined, errors);
  if (errors.length) throw new EngineDataError(errors);
  return { root, ffmpeg, recipes, licenses, platforms, ffmpegSource: { git: source!.git, tags: source!.versions['git-tags'], url: source!.url, mirrors: source!.mirrors } };
}

function parseFile<T extends z.ZodType>(path: string, label: string, schema: T, errors: string[]): z.output<T> | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'), label);
  } catch (e) {
    if (e instanceof YamlError) errors.push(e.message);
    else if ((e as NodeJS.ErrnoException).code === 'ENOENT') errors.push(`${label}: missing`);
    else throw e;
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  errors.push(...formatIssues(parsed.error).map((m) => `${label}: ${m}`));
  return undefined;
}

function crossCheck(ffmpeg: Map<string, FfmpegData>, recipes: Map<string, Recipe>, licenses: LicenseTable | undefined, errors: string[]): void {
  const checkPatterns = (label: string, patterns: readonly string[] | undefined) => {
    for (const p of patterns ?? []) if (!expandPlatformPattern(p).length) errors.push(`${label}: platform "${p}" matches no platform`);
  };
  for (const [major, data] of ffmpeg) {
    data.releases.forEach((r, i) => {
      if (!inSeries(r, major)) errors.push(`ffmpeg/${major}.yml: release ${r} is not an FFmpeg ${major} release`);
      if (data.releases.indexOf(r) !== i) errors.push(`ffmpeg/${major}.yml: release ${r} is listed twice`);
    });
    for (const [option, o] of Object.entries(data.options)) {
      const label = `ffmpeg/${major}.yml: options.${option}`;
      for (const d of o.needs ?? []) {
        const lib = recipes.get(d.name);
        if (!lib) {
          errors.push(`${label}: needs ${d.name}, but there is no recipes/${d.name}`);
          continue;
        }
        // a per-platform library must build wherever it is the option's library (and FFmpeg offers the option)
        if (!d.platforms) continue;
        const built = expandPlatforms(lib.platforms);
        const missing = expandPlatforms(d.platforms).filter((p) => (!o.platforms || platformMatches(p, o.platforms)) && !built.includes(p));
        if (missing.length) errors.push(`${label}: needs ${d.name}, which doesn't build for ${describePlatforms(missing)}`);
      }
      checkPatterns(label, o.platforms);
      for (const d of o.needs ?? []) checkPatterns(`${label}: needs ${d.name}`, d.platforms);
      // one library per platform: an unlimited one only alone, limited ones never on the same platform
      const needs = o.needs ?? [];
      const everywhere = needs.find((d) => !d.platforms);
      if (everywhere && needs.length > 1) {
        const other = needs.find((d) => d !== everywhere)!;
        errors.push(`${label}: needs ${everywhere.name} on every platform and ${other.name} on some; give ${everywhere.name} its platforms too`);
      }
      for (const [i, a] of needs.entries()) {
        for (const b of needs.slice(i + 1)) {
          if (!a.platforms || !b.platforms) continue;
          const both = expandPlatforms(a.platforms).filter((p) => platformMatches(p, b.platforms!));
          if (both.length) errors.push(`${label}: needs both ${a.name} and ${b.name} on ${describePlatforms(both)}; each platform gets one library`);
        }
      }
    }
  }
  for (const [dir, recipe] of recipes) {
    const label = `recipes/${dir}/recipe.yml`;
    for (const key of ['needs', 'uses'] as const) {
      for (const d of recipe[key]) {
        if (!recipes.has(d.name)) errors.push(`${label}: ${key} ${d.name}, but there is no recipes/${d.name}`);
        for (const p of d.platforms ?? []) if (!expandPlatformPattern(p).length) errors.push(`${label}: ${key} ${d.name}: platform "${p}" matches no platform`);
      }
    }
    // a dependency it needs must build wherever the recipe does and the dependency applies
    for (const d of recipe.needs) {
      const depRecipe = recipes.get(d.name);
      if (!depRecipe) continue; // already reported above
      const depPlatforms = expandPlatforms(depRecipe.platforms);
      const applies = expandPlatforms(recipe.platforms).filter((p) => !d.platforms || platformMatches(p, d.platforms));
      const missing = applies.filter((p) => !depPlatforms.includes(p));
      if (missing.length) errors.push(`${label}: needs ${d.name}, which doesn't build for ${describePlatforms(missing)}`);
    }
    checkPatterns(label, recipe.platforms);
    if (licenses) {
      const verdict = allowedBy(recipe.license, licenses);
      if ('unknown' in verdict) for (const id of verdict.unknown) errors.push(`${label}: license: "${id}" is not in licenses.yml; add it there with the profile licenses it may be linked into`);
      if ('invalid' in verdict) errors.push(`${label}: license: "${recipe.license}" is not an SPDX expression this engine can read`);
    }
    for (const key of Object.keys(recipe.notes ?? {})) {
      if (!isRange(key)) errors.push(`${label}: notes key "${key}" is not a version or range`);
    }
    const v = recipe.versions;
    if ('files' in v) checkPattern(label, 'files', v.files, errors);
    if ('git-tags' in v) checkPattern(label, 'git-tags', v['git-tags'], errors);
    for (const key of ['git-tags', 'git-branch'] as const) {
      if (key in v && !('repo' in v && v.repo) && !('git' in recipe.source)) {
        errors.push(`${label}: versions.${key} needs source.git or versions.repo to read from`);
      }
    }
    if (recipe.provides && ![...ffmpeg.values()].some((d) => d.options[recipe.provides!]?.needs?.some((n) => n.name === dir))) {
      errors.push(`${label}: provides ${recipe.provides}, but no FFmpeg option by that name needs ${dir}`);
    }
  }
  const cycle = findCycle(recipes);
  if (cycle) errors.push(`recipes: ${cycle.join(' -> ')} needs itself`);
}

/** A version regex must compile and have a ( ) group: group 1 is the version. */
function checkPattern(label: string, key: string, pattern: string, errors: string[]): void {
  try {
    if (new RegExp(`${pattern}|`).exec('')!.length < 2) errors.push(`${label}: versions.${key} needs a ( ) group around the version`);
  } catch (e) {
    errors.push(`${label}: versions.${key} is not a valid regex: ${(e as Error).message}`);
  }
}

export type VersionSource =
  | { kind: 'git-tags'; repo: string; pattern: RegExp }
  | { kind: 'listing'; url: string; pattern: RegExp }
  | { kind: 'git-branch'; repo: string; branch: string };

/** Where `recipe`'s versions come from. Engine data loading already checked every field used here. */
export function versionSource(data: EngineData, recipe: string): VersionSource {
  const r = data.recipes.get(recipe)!;
  const v = r.versions;
  if ('listing' in v) return { kind: 'listing', url: v.listing, pattern: new RegExp(v.files) };
  const repo = (v.repo ?? ('git' in r.source ? r.source.git : undefined))!;
  if ('git-branch' in v) return { kind: 'git-branch', repo, branch: v['git-branch'] };
  return { kind: 'git-tags', repo, pattern: new RegExp(v['git-tags']) };
}

export function ffmpegVersionSource(data: EngineData): VersionSource {
  return { kind: 'git-tags', repo: data.ffmpegSource.git, pattern: new RegExp(data.ffmpegSource.tags) };
}

function findCycle(recipes: Map<string, Recipe>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === 'done') return undefined;
    if (state.get(n) === 'visiting') return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 'visiting');
    stack.push(n);
    const r = recipes.get(n);
    for (const dep of [...(r?.needs ?? []), ...(r?.uses ?? [])].map((d) => d.name).sort()) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(n, 'done');
    return undefined;
  };
  for (const n of [...recipes.keys()].sort()) {
    const found = visit(n);
    if (found) return found;
  }
  return undefined;
}

// FFmpeg builds these whatever a profile says, so they are never profile entries
const ALWAYS_BUILT = new Set(['muxer', 'demuxer', 'filter']);

/** A part of FFmpeg itself that every build has (a muxer, demuxer or filter), not something a profile lists. */
export function alwaysBuilt(option: OptionInfo): boolean {
  return option.builtin && option.kind !== undefined && ALWAYS_BUILT.has(option.kind);
}

export function knownMajors(data: EngineData): string[] {
  return [...data.ffmpeg.keys()];
}

const optionCache = new WeakMap<EngineData, Map<string, Map<string, OptionInfo>>>();

/** Every option FFmpeg <major> offers, with its group falling back to the option's recipe's. */
export function optionsOf(data: EngineData, major: string): Map<string, OptionInfo> {
  let byMajor = optionCache.get(data);
  if (!byMajor) optionCache.set(data, (byMajor = new Map()));
  const cached = byMajor.get(major);
  if (cached) return cached;
  const result = new Map<string, OptionInfo>();
  for (const [name, o] of Object.entries(data.ffmpeg.get(major)?.options ?? {})) {
    const libraries = o.needs ?? [];
    const single = libraries.length === 1 && !libraries[0]!.platforms ? libraries[0]!.name : undefined;
    const recipe = single ? data.recipes.get(single) : undefined;
    result.set(name, {
      name,
      builtin: o.builtin === true,
      ...(single ? { recipe: single } : {}),
      libraries,
      since: o.since,
      min: o.min,
      ffmpegLicense: o['ffmpeg-license'],
      platforms: o.platforms,
      group: o.group ?? recipe?.group,
      ...(o.kind ? { kind: o.kind } : {}),
      ...(o.configure ? { configure: o.configure } : {}),
    });
  }
  byMajor.set(major, result);
  return result;
}

/** The option a `with` / `without` name refers to. Profiles use FFmpeg's option names (nvenc, whisper, x265). */
export function resolveName(data: EngineData, name: string): string | undefined {
  return [...data.ffmpeg.values()].some((d) => name in d.options) ? name : undefined;
}

/** The library a `pin` refers to: a library (recipe) name, or the library behind an FFmpeg option name. */
export function recipeForPin(data: EngineData, name: string): { recipe: string } | { error: string } {
  if (data.recipes.has(name)) return { recipe: name };
  const option = resolveName(data, name);
  if (!option) return { error: `ffmpeg-build doesn't know "${name}".` };
  const names = [...new Set([...data.ffmpeg.values()].flatMap((d) => (d.options[option]?.needs ?? []).map((n) => n.name)))];
  if (names.length === 1) return { recipe: names[0]! };
  if (names.length > 1) return { error: `${name} uses a different library per platform (${names.join(', ')}); pin the library by its name.` };
  return { error: `${name} is part of FFmpeg itself; there is no library version to pin.` };
}

/** The library `option` builds on `platform` (its only one, when no platform is given and there is one). */
export function optionRecipe(info: OptionInfo, platform?: string): string | undefined {
  if (!platform) return info.recipe;
  return info.libraries.find((d) => !d.platforms || platformMatches(platform, d.platforms))?.name;
}

/** The `needs` or `uses` names of a recipe that apply on `platform` (all of them when no platform is given). */
export function depsOn(recipe: Recipe, key: 'needs' | 'uses', platform?: string): string[] {
  return recipe[key].filter((d) => !platform || !d.platforms || platformMatches(platform, d.platforms)).map((d) => d.name);
}

/** The libraries `roots` need, dependencies first: every `needs` that applies on `platform` (all when none given). */
export function buildOrder(data: EngineData, roots: readonly string[], platform?: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (r: string) => {
    if (seen.has(r)) return;
    seen.add(r);
    const recipe = data.recipes.get(r);
    for (const dep of (recipe ? depsOn(recipe, 'needs', platform) : []).sort()) visit(dep);
    order.push(r);
  };
  [...roots].sort().forEach(visit);
  return order;
}

/**
 * Why `recipe` can't be linked into a `license` build (itself, or anything it needs), or undefined when it can. The
 * text names the cause only ("openssl is Apache-2.0"), so one cause reads the same for every license it blocks.
 */
export function licenseBlocker(data: EngineData, recipe: string, license: License, platform?: string): string | undefined {
  // the recipe itself first, then what it needs
  const blocked = buildOrder(data, [recipe], platform).reverse().find((r) => {
    const verdict = allowedBy(data.recipes.get(r)!.license, data.licenses);
    return !('allowed' in verdict) || !verdict.allowed.includes(license);
  });
  if (!blocked) return undefined;
  const expr = data.recipes.get(blocked)!.license;
  return blocked === recipe ? `${recipe} is ${expr}` : `${recipe} needs ${blocked} (${expr})`;
}

/** The profile licenses `recipe` (with everything it needs) may be linked into. */
export function allowedLicenses(data: EngineData, recipe: string, platform?: string): License[] {
  return LICENSES.filter((l) => !licenseBlocker(data, recipe, l, platform));
}
