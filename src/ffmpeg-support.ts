// What FFmpeg itself offers, read from its configure script, against what the engine's ffmpeg/<major>.yml says: the
// nightly support check (scripts/ffmpeg-support.ts, .github/workflows/ffmpeg-support.yml). Releases are pure data and
// are corrected from upstream's tags; new or changed options are reported for a person to decide.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { knownMajors, optionsOf, type EngineData } from './engine-data.ts';
import { compareVersions } from './versions.ts';

export type LicenseClass = 'gpl' | 'version3' | 'gplv3' | 'nonfree' | '';

/** configure's external and hwaccel library options, each with its licence class ('' for none). */
export function parseConfigure(text: string): Map<string, LicenseClass> {
  const lists = new Map<string, string[]>();
  for (const m of text.matchAll(/^([A-Z0-9_]+_LIST)="\n([\s\S]*?)^"/gm)) lists.set(m[1]!, m[2]!.split(/\s+/).filter(Boolean));
  const expand = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    return (lists.get(name) ?? []).flatMap((w) => (w.startsWith('$') ? expand(w.slice(1), seen) : [w]));
  };
  const classOf = new Map<string, LicenseClass>();
  for (const [list, cls] of [
    ['EXTERNAL_LIBRARY_GPL_LIST', 'gpl'], ['EXTERNAL_LIBRARY_NONFREE_LIST', 'nonfree'], ['EXTERNAL_LIBRARY_VERSION3_LIST', 'version3'],
    ['EXTERNAL_LIBRARY_GPLV3_LIST', 'gplv3'], ['HWACCEL_LIBRARY_NONFREE_LIST', 'nonfree'],
  ] as const) {
    for (const o of expand(list)) classOf.set(o, cls);
  }
  const all = ['EXTERNAL_LIBRARY_LIST', 'EXTERNAL_AUTODETECT_LIBRARY_LIST', 'HWACCEL_LIBRARY_LIST', 'HWACCEL_AUTODETECT_LIBRARY_LIST'].flatMap((l) => expand(l));
  return new Map([...new Set(all)].sort().map((o) => [o, classOf.get(o) ?? '']));
}

/** The configure names an engine option turns on: `--enable-<name>` flags of its own, its recipe's, or its name. */
export function configureNames(data: EngineData, major: string): Map<string, string> {
  const names = new Map<string, string>(); // configure name -> engine option
  for (const o of optionsOf(data, major).values()) {
    const recipe = o.libraries[0]?.name;
    const flags = o.configure ?? (recipe ? data.recipes.get(recipe)?.configure ?? [] : [`--enable-${o.name}`]);
    for (const f of flags) {
      const m = /^--enable-([a-z0-9_]+)$/.exec(f);
      if (m) names.set(m[1]!, o.name);
    }
  }
  return names;
}

export interface SupportReport {
  major: string;
  releases: { was: string[]; now: string[] };
  newOptions: { name: string; license: LicenseClass }[]; // in the newest release's configure, not in the previous one's
  gone: string[]; // engine options whose configure name the newest release no longer has
  reclassed: { option: string; data: string; configure: LicenseClass }[];
}

const DATA_CLASS: Record<LicenseClass, string[]> = { '': [''], gpl: ['gpl'], version3: ['version3'], gplv3: ['gpl', 'version3'], nonfree: ['nonfree'] };

/**
 * One major's report: its releases as upstream has them, and the newest release's configure against the previous
 * release's (new options) and against the engine's data (gone, reclassed).
 */
export function supportReport(data: EngineData, major: string, upstream: string[], newest: Map<string, LicenseClass>, previous: Map<string, LicenseClass> | undefined): SupportReport {
  const was = data.ffmpeg.get(major)?.releases ?? [];
  const now = upstream.filter((v) => v.split('.')[0] === major).sort(compareVersions);
  const names = configureNames(data, major);
  const newOptions = previous ? [...newest].filter(([n]) => !previous.has(n)).map(([name, license]) => ({ name, license })) : [];
  const gone = [...names].filter(([n]) => !newest.has(n) && /^lib/.test(n)).map(([, o]) => o);
  const reclassed: SupportReport['reclassed'] = [];
  for (const o of optionsOf(data, major).values()) {
    const configureName = [...names].find(([, opt]) => opt === o.name)?.[0];
    const cls = configureName ? newest.get(configureName) : undefined;
    if (cls === undefined || o.builtin) continue;
    const data = o.ffmpegLicense ?? '';
    if (!DATA_CLASS[cls].includes(data)) reclassed.push({ option: o.name, data: data || 'none', configure: cls });
  }
  return { major, releases: { was, now }, newOptions, gone: [...new Set(gone)].sort(), reclassed };
}

/** Rewrites ffmpeg/<major>.yml's `releases:` line in place (comments and everything else stay). */
export function writeReleases(dataRoot: string, major: string, releases: string[]): boolean {
  const file = join(dataRoot, 'ffmpeg', `${major}.yml`);
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/^releases: \[[^\]]*\]$/m, `releases: [${releases.join(', ')}]`);
  if (next === text) return false;
  writeFileSync(file, next);
  return true;
}

/** Markdown for the PR body or the run summary. */
export function formatSupport(reports: SupportReport[], newMajors: string[], applied = false): string {
  const out = ['# FFmpeg support check', ''];
  for (const r of reports) {
    out.push(`## FFmpeg ${r.major}`);
    const added = r.releases.now.filter((v) => !r.releases.was.includes(v));
    const dropped = r.releases.was.filter((v) => !r.releases.now.includes(v));
    out.push(added.length || dropped.length ? `- releases: ${[...added.map((v) => `+${v}`), ...dropped.map((v) => `-${v}`)].join(', ')} (${applied ? 'applied' : 'run with --write to apply'})` : '- releases: up to date');
    if (r.newOptions.length) out.push(`- **new in ${r.releases.now.at(-1)}** (a person decides; add a recipe and an option, or leave out): ${r.newOptions.map((o) => `\`${o.name}\`${o.license ? ` (${o.license})` : ''}`).join(', ')}`);
    if (r.gone.length) out.push(`- **gone from configure**, still in the data: ${r.gone.map((g) => `\`${g}\``).join(', ')}`);
    for (const c of r.reclassed) out.push(`- **licence class changed:** \`${c.option}\` is ${c.data} in the data, ${c.configure} in configure`);
    out.push('');
  }
  if (newMajors.length) out.push(`**New FFmpeg major${newMajors.length > 1 ? 's' : ''} ${newMajors.join(', ')}**: add ffmpeg/<major>.yml to support it (not done automatically).`, '');
  return `${out.join('\n')}\n`;
}

/** Majors upstream has that the engine's data doesn't. */
export function newMajors(data: EngineData, upstream: string[]): string[] {
  const known = new Set(knownMajors(data));
  const top = Math.max(...[...known].map(Number));
  return [...new Set(upstream.map((v) => v.split('.')[0]!))].filter((m) => !known.has(m) && Number(m) > top).sort((a, b) => Number(a) - Number(b));
}
