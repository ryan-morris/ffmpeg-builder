// Old matrix profiles (and their lock) to ffmpeg-build.yml: every build becomes a target that builds exactly the same,
// and what targets share is factored into bases (common, then platform family, then license), deterministically.
import { pinWinner } from './choose.ts';
import { recipeForPin, type EngineData } from './engine-data.ts';
import type { FolderLock, Lock } from './lockfile.ts';
import { declined, type Profile } from './profile.ts';
import { planProfile } from './resolve.ts';
import { compareVersions } from './versions.ts';

export interface MigrateInput { profiles: Profile[]; data: EngineData; files: string[]; lock?: Lock }
export interface MigrateResult { text: string; lock?: Omit<FolderLock, 'engine'>; errors: string[] }

/** One target as written out: its own lists, before bases are factored. */
export interface Draft {
  name: string;
  profile: string;
  platform: string;
  license: string;
  ffmpeg: string;
  include: string[]; // in the profile's own order
  decline: string[];
  pin: Record<string, string>;
  patches: string[];
  tests: string[];
}

/** linux-x64 -> linux, linux-musl-x64 -> linux-musl, ios-sim-arm64 -> ios-sim, maccatalyst-arm64 -> maccatalyst. */
const family = (platform: string) => platform.replace(/-[^-]+$/, '');

/** Of a profile's FFmpeg series, the one written without a suffix: latest, else the highest. */
function newestSeries(series: string[]): string {
  if (series.includes('latest')) return 'latest';
  return [...series].sort((a, b) => compareVersions(a.includes('.') ? a : `${a}.0`, b.includes('.') ? b : `${b}.0`)).at(-1)!;
}

export function migrate(input: MigrateInput): MigrateResult {
  const { profiles, data } = input;
  const errors: string[] = [];
  const drafts: Draft[] = [];
  const folderPins: Record<string, string> = {};

  for (const p of profiles) {
    const locked = input.lock?.profiles[p.name];
    const versions = locked && p.ffmpeg.every((s) => locked.ffmpeg[s]) ? locked.ffmpeg : {};
    const plan = planProfile(p, data, versions);
    if (plan.errors.length) {
      errors.push(...plan.errors.map((e) => `${p.name}: ${e}`));
      continue;
    }
    const order = p.with.map((e) => e.name);
    const top = newestSeries(p.ffmpeg);
    for (const pin of p.pin.filter((x) => !x.cond)) {
      const target = recipeForPin(data, pin.name);
      const key = 'recipe' in target ? target.recipe : pin.name;
      if (folderPins[key] && folderPins[key] !== pin.version) errors.push(`can't migrate: ${key} is pinned to ${folderPins[key]} and ${pin.version} in different profiles; make them agree, then migrate again`);
      folderPins[key] = pin.version;
    }
    for (const c of plan.cells) {
      // today's asset variant: the profile when the folder has several, the license when the profile has several
      const variant = [...(profiles.length > 1 ? [p.name] : []), ...(p.license.length > 1 ? [c.cell.license] : [])].join('-') || c.cell.license;
      const suffix = c.cell.series === top ? '' : `-ffmpeg${c.cell.series}`;
      // a conditional pin that decides a library in this build becomes this target's pin
      const pin: Record<string, string> = {};
      for (const recipe of c.recipes) {
        const index = pinWinner(p, data, c.cell, recipe);
        if (index >= 0 && p.pin[index]!.cond) pin[recipe] = p.pin[index]!.version;
      }
      drafts.push({
        name: `${c.cell.platform}-${variant}${suffix}`,
        profile: p.name,
        platform: c.cell.platform,
        license: c.cell.license,
        ffmpeg: c.cell.series,
        include: [...c.options].sort((a, b) => rank(order, a) - rank(order, b) || a.localeCompare(b)),
        decline: [...new Set([...declined(p), ...c.removed])].sort((a, b) => rank(order, a) - rank(order, b) || a.localeCompare(b)),
        pin,
        patches: p.patches,
        tests: p.tests,
      });
    }
  }
  const names = new Map<string, number>();
  for (const d of drafts) names.set(d.name, (names.get(d.name) ?? 0) + 1);
  for (const [n, count] of names) if (count > 1) errors.push(`can't migrate: two builds would both be named ${n}; rename a profile, then migrate again`);
  errors.push(...pinConflicts(drafts, folderPins));

  const lock = input.lock ? consolidate(input.lock, profiles, errors) : undefined;
  if (errors.length) return { text: '', errors };
  const header = [
    `# ffmpeg-build.yml: made by \`ffmpeg-build migrate\`${input.files.length ? ` from ${input.files.join(', ')}` : ''}. Each target is one build`,
    ...EXPLAIN,
  ];
  return { text: renderFolder(drafts, folderPins, header), ...(lock ? { lock } : {}), errors };
}

/**
 * One lock holds one version per library, and every pin that applies must hold for it. Old profiles could give a
 * library different pins in different builds; those can't all be met, so they are refused (equal pins are fine).
 */
function pinConflicts(drafts: Draft[], folderPins: Record<string, string>): string[] {
  const errors: string[] = [];
  const byRecipe = new Map<string, Map<string, string[]>>();
  for (const d of drafts) {
    for (const [recipe, version] of Object.entries(d.pin)) {
      const versions = byRecipe.get(recipe) ?? new Map<string, string[]>();
      versions.set(version, [...(versions.get(version) ?? []), d.name]);
      byRecipe.set(recipe, versions);
    }
  }
  for (const [recipe, versions] of byRecipe) {
    const all = folderPins[recipe] !== undefined && !versions.has(folderPins[recipe]!) ? [[folderPins[recipe]!, ['every other build']] as const, ...versions] : [...versions];
    if (all.length < 2) continue;
    const said = all.map(([v, who]) => `"${v}" for ${who.join(', ')}`);
    errors.push(`can't migrate: ${recipe} is pinned to ${said.slice(0, -1).join(', ')} and ${said.at(-1)}; one lock holds one version per library, so give them one pin, then migrate again`);
  }
  return errors;
}

const rank = (order: string[], name: string) => {
  const i = order.indexOf(name);
  return i < 0 ? order.length : i;
};

/** One version per series and per library across the profiles' lock entries, or an error naming the disagreement. */
function consolidate(lock: Lock, profiles: Profile[], errors: string[]): Omit<FolderLock, 'engine'> {
  const ffmpeg: Record<string, string> = {};
  const libraries: Record<string, string> = {};
  const owners = new Map<string, string>();
  const put = (into: Record<string, string>, kind: string, key: string, version: string, profile: string) => {
    const was = into[key];
    if (was && was !== version) {
      errors.push(`can't migrate: ${kind === 'ffmpeg' ? `FFmpeg ${key}` : key} is locked at ${was} for ${owners.get(`${kind}:${key}`)} and ${version} for ${profile}; make them agree (pin or update), then migrate again`);
      return;
    }
    into[key] = version;
    owners.set(`${kind}:${key}`, profile);
  };
  for (const p of profiles) {
    const entry = lock.profiles[p.name];
    if (!entry) continue;
    for (const [s, v] of Object.entries(entry.ffmpeg)) put(ffmpeg, 'ffmpeg', s, v, p.name);
    for (const [l, v] of Object.entries(entry.libraries)) put(libraries, 'lib', l, v, p.name);
    for (const pin of entry.pinned) put(libraries, 'lib', pin.name, pin.version, p.name);
  }
  return { ffmpeg, libraries };
}

/** The header lines after the first: what a folder file is. */
export const EXPLAIN = [
  '# (one platform, one license, one FFmpeg series); bases hold what targets share. `ffmpeg-build show <target>`',
  '# lists what a target gets and where each entry comes from.',
];

/** Bases (common, family, license) by intersection, then each target's own remainder; rendered as YAML text. */
export function renderFolder(drafts: Draft[], folderPins: Record<string, string>, header: string[]): string {
  const inter = (sets: string[][]) => (sets.length ? sets.reduce((acc, s) => acc.filter((x) => s.includes(x))) : []);
  const order = drafts[0]?.include ?? [];
  const sorted = (names: string[]) => [...names].sort((a, b) => rank(order, a) - rank(order, b) || a.localeCompare(b));
  const bases: [string, { with: string[]; without: string[] }][] = [];
  const common = drafts.length > 1 ? inter(drafts.map((d) => d.include)) : [];
  const commonDecline = drafts.length > 1 ? inter(drafts.map((d) => d.decline)) : [];
  if (common.length || commonDecline.length) bases.push(['common', { with: sorted(common), without: sorted(commonDecline) }]);
  const groups = (key: (d: Draft) => string) => {
    const by = new Map<string, Draft[]>();
    for (const d of drafts) by.set(key(d), [...(by.get(key(d)) ?? []), d]);
    return [...by].filter(([, ds]) => ds.length > 1).sort(([a], [b]) => a.localeCompare(b));
  };
  const familyBase = new Map<string, string[]>();
  for (const [fam, ds] of groups((d) => family(d.platform))) {
    const shared = inter(ds.map((d) => d.include)).filter((n) => !common.includes(n));
    if (shared.length) {
      bases.push([fam, { with: sorted(shared), without: [] }]);
      familyBase.set(fam, shared);
    }
  }
  const licenseBase = new Map<string, string[]>();
  for (const [lic, ds] of groups((d) => d.license)) {
    const shared = inter(ds.map((d) => d.include.filter((n) => !common.includes(n) && !(familyBase.get(family(d.platform)) ?? []).includes(n))));
    if (shared.length && drafts.some((d) => d.license !== lic)) {
      bases.push([lic, { with: sorted(shared), without: [] }]);
      licenseBase.set(lic, shared);
    }
  }

  const out = [...header];
  if (bases.length) {
    out.push('bases:');
    for (const [name, b] of bases) {
      out.push(`  ${name}:`);
      if (b.with.length) out.push(...wrapList('with', b.with, 4));
      if (b.without.length) out.push(...wrapList('without', b.without, 4));
    }
  }
  if (Object.keys(folderPins).length) {
    out.push('pin:');
    for (const [k, v] of Object.entries(folderPins).sort(([a], [b]) => a.localeCompare(b))) out.push(`  ${k}: ${JSON.stringify(v)}`);
  }
  out.push('targets:');
  for (const d of [...drafts].sort((a, b) => a.name.localeCompare(b.name))) {
    const base = [
      ...(common.length || commonDecline.length ? ['common'] : []),
      ...(familyBase.has(family(d.platform)) ? [family(d.platform)] : []),
      ...(licenseBase.has(d.license) ? [d.license] : []),
    ];
    const given = new Set([...(common), ...(familyBase.get(family(d.platform)) ?? []), ...(licenseBase.get(d.license) ?? [])]);
    const own = d.include.filter((n) => !given.has(n));
    const ownDecline = d.decline.filter((n) => !commonDecline.includes(n));
    out.push(`  ${d.name}:`);
    out.push(`    platform: ${d.platform}`, `    license: ${d.license}`, `    ffmpeg: ${JSON.stringify(d.ffmpeg)}`);
    if (base.length) out.push(`    base: [${base.join(', ')}]`);
    if (own.length) out.push(...wrapList('with', own, 4));
    if (ownDecline.length) out.push(...wrapList('without', ownDecline, 4));
    if (Object.keys(d.pin).length) out.push(`    pin: { ${Object.entries(d.pin).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')} }`);
    if (d.patches.length) out.push(`    patches: [${d.patches.join(', ')}]`);
    if (d.tests.length) out.push(`    tests: [${d.tests.join(', ')}]`);
    // each old profile released on its own, tagged with its name: it stays its own release group
    if (new Set(drafts.map((x) => x.profile)).size > 1) out.push(`    release-group: ${d.profile}`);
  }
  return `${out.join('\n')}\n`;
}

/** `key: [a, b, ...]` as a flow list wrapped at about 110 columns. */
function wrapList(key: string, items: string[], indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let line = `${pad}${key}: [`;
  const cont = ' '.repeat(line.length);
  items.forEach((item, i) => {
    const piece = `${item}${i < items.length - 1 ? ',' : ']'}`;
    if (line.length + piece.length + 1 > 110 && !line.endsWith('[')) {
      lines.push(line.trimEnd());
      line = cont;
    }
    line += line.endsWith('[') || line === cont ? piece : ` ${piece}`;
  });
  lines.push(line);
  return lines;
}
