import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { optionsOf, recipeForPin, resolveName, type EngineData } from './engine-data.ts';
import { describePlatforms, platformMatches } from './platforms.ts';
import type { LoadResult, Profile } from './profile.ts';
import { isCommit } from './ranges.ts';
import { conditionMatches, optionLicenses, planProfile, type Absence, type Cell, type CellPlan, type Variant } from './resolve.ts';
import { allowedBy } from './licenses.ts';
import { formatIssues, oneOrMany, text } from './schema/common.ts';
import { relativePath } from './schema/engine.ts';
import { LICENSES, type Condition, type Entry, type License } from './schema/profile.ts';
import { parseYaml, YamlError } from './yaml.ts';
import { andList, fmtEntry, fmtList, seriesLabel, unique } from './text.ts';
import { matchesVersionCondition } from './versions.ts';

export type Mark = '✓' | '-' | '✗';
export interface Line { mark: Mark; text: string; detail?: string[]; note?: string }
export interface Block { title?: string; lines: Line[] }
export interface ProfileReport { file: string; header: string; blocks: Block[]; problems: number }

type Reason = Absence | { kind: 'without' | 'conflict'; reason: string };
interface Ctx { profile: Profile; variants: Variant[]; platforms: string[]; target: boolean }

/** `versions`: the FFmpeg release to judge each series by (a folder's locked one), else the newest the data knows. */
export function checkProfile(loaded: LoadResult, data: EngineData, options: { target?: { header: string }; versions?: Record<string, string> } = {}): ProfileReport {
  if (!loaded.ok) return report(loaded.file, loaded.file, [{ lines: loaded.errors.map((text) => ({ mark: '✗', text })) }]);
  const profile = loaded.profile;
  const header = options.target?.header ?? `${profile.file}   (ffmpeg: ${fmtList(profile.ffmpeg)}, platforms: ${fmtList(profile.platforms)}, license: ${fmtList(profile.license)})`;
  const plan = planProfile(profile, data, options.versions ?? {});
  if (plan.errors.length) return report(profile.file, header, [{ lines: plan.errors.map((text) => ({ mark: '✗', text })) }]);
  const ctx: Ctx = { profile, variants: plan.variants, platforms: plan.platforms, target: Boolean(options.target) };
  return report(profile.file, header, [
    ...entryProblems(profile, data, plan.cells, ctx),
    ...patchProblems(profile, data, ctx),
    ...shipsProblems(data, ctx),
    ...withBlocks(profile, data, plan.cells, ctx),
    ...groupBlocks(data, plan.cells, ctx),
    ...leftOutBlocks(plan.cells),
  ]);
}

function report(file: string, header: string, blocks: Block[]): ProfileReport {
  const problems = blocks.flatMap((b) => b.lines).filter((l) => l.mark === '✗').length;
  return { file, header, blocks, problems };
}

function entryProblems(profile: Profile, data: EngineData, cells: CellPlan[], ctx: Ctx): Block[] {
  const lines: Line[] = [];
  const problem = (text: string, detail: string) => lines.push({ mark: '✗', text, detail: [detail] });
  const lists: [string, Entry[]][] = [['with', profile.with], ['without', profile.without]];
  for (const [key, entries] of lists) {
    for (const e of entries) {
      if (!resolveName(data, e.name)) problem(`${key}: ${fmtEntry(e)}`, `ffmpeg-build doesn't know "${e.name}". Use the name FFmpeg gives it, like nvenc, x265 or whisper.`);
      else if (e.cond && !anyCellMatches(e.cond, ctx)) problem(`${key}: ${fmtEntry(e)}`, neverReason(e.cond, ctx));
    }
  }
  profile.pin.forEach((p, i) => {
    const target = recipeForPin(data, p.name);
    if ('error' in target) return problem(`pin: ${p.name}`, target.error);
    if (p.cond && !anyCellMatches(p.cond, ctx)) return problem(`pin: ${fmtEntry(p)}`, neverReason(p.cond, ctx));
    const form = pinFormProblem(data, target.recipe, p.name, p.version);
    if (form) return problem(`pin: ${fmtEntry(p)}`, form);
    const builds = cells.filter((c) => conditionMatches(p.cond, c.cell) && c.recipes.includes(target.recipe));
    if (!builds.length) return problem(`pin: ${fmtEntry(p)}`, `${p.name} isn't in any build of this profile, so this pin never applies.`);
    // the first matching entry for a library wins, so a later one may never get a turn
    const earlier = profile.pin.slice(0, i).filter((q) => {
      const t = recipeForPin(data, q.name);
      return 'recipe' in t && t.recipe === target.recipe;
    });
    if (builds.every((c) => earlier.some((q) => conditionMatches(q.cond, c.cell)))) {
      problem(`pin: ${fmtEntry(p)}`, `an earlier pin for ${target.recipe} always comes first, so this one never applies.`);
    }
  });
  for (const w of profile.with.filter((e) => !e.cond)) {
    const option = resolveName(data, w.name);
    if (option && profile.without.some((x) => !x.cond && resolveName(data, x.name) === option)) {
      problem(`with: ${w.name} and without: ${w.name}`, `${w.name} is both added and removed everywhere; keep one of them.`);
    }
  }
  return lines.length ? [{ lines }] : [];
}

// patches/<set>/about.yml: what a patch set is, under which licence (and the texts of it the archives carry,
// relative to the set's folder), for which FFmpeg majors
export const aboutSchema = z.strictObject({
  name: text,
  license: text,
  'license-files': z.array(relativePath, { error: 'expected a list of licence files in the patch folder, like [LICENSE]' }).min(1, { error: 'name at least one licence file' }),
  ffmpeg: oneOrMany(text, 'expected an FFmpeg major like 9, or a list of them'),
  configure: z.array(text).optional(),
});

/** Each patch set: its about.yml, its licence against the profile's, and its patches for every FFmpeg major built. */
function patchProblems(profile: Profile, data: EngineData, ctx: Ctx): Block[] {
  if (!profile.dir || !profile.patches.length) return [];
  const lines: Line[] = [];
  const problem = (p: string, message: string, detail?: string) =>
    lines.push({ mark: '✗', text: `patches: ${p}: ${message}`, ...(detail ? { detail: [detail] } : {}) });
  for (const p of profile.patches) {
    if (isAbsolute(p) || p.replaceAll('\\', '/').split('/').includes('..')) {
      problem(p, 'a patch set must be a folder inside this one (it goes into the release\'s sources archive at the same path)');
      continue;
    }
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(join(profile.dir, p, 'about.yml'), 'utf8'), `${p}/about.yml`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') problem(p, 'no about.yml there');
      else if (e instanceof YamlError) problem(p, e.message);
      else throw e;
      continue;
    }
    const parsed = aboutSchema.safeParse(raw);
    if (!parsed.success) {
      problem(p, `about.yml: ${formatIssues(parsed.error).join('; ')}`);
      continue;
    }
    const about = parsed.data;
    for (const f of about['license-files'].filter((f) => !existsSync(join(profile.dir!, p, f)))) problem(p, `about.yml: license-files: ${f} is not in the patch folder`);
    const notMajors = about.ffmpeg.filter((v) => !/^\d+$/.test(v));
    if (notMajors.length) {
      for (const v of notMajors) problem(p, `about.yml: ffmpeg: ${v} is not an FFmpeg major; write ${v.split('.')[0]}`);
      continue;
    }
    const verdict = allowedBy(about.license, data.licenses); // licenses.yml maps proprietary to nonfree
    if (!('allowed' in verdict)) {
      problem(p, `about.yml: license "${about.license}" is not in licenses.yml`);
    } else if (profile.license.some((l) => !verdict.allowed.includes(l))) {
      const allowed = verdict.allowed.join(', ') || 'none';
      problem(p, `${about.name} is \`license: ${about.license}\`; it can only be built with \`license: ${allowed}\``, `Fix: license: ${allowed}, or relicense the patch set.`);
    }
    const majors = unique(ctx.variants.map((v) => v.major));
    const undeclared = majors.filter((m) => !about.ffmpeg.includes(m));
    if (undeclared.length) {
      problem(p, `about.yml declares FFmpeg ${andList(about.ffmpeg)} only; this profile also builds FFmpeg ${andList(undeclared)}`);
    }
    for (const m of majors.filter((m) => about.ffmpeg.includes(m))) {
      if (!existsSync(join(profile.dir, p, m))) problem(p, `no patches for FFmpeg ${m} (add a ${m}/ folder)`);
    }
  }
  return lines.length ? [{ lines }] : [];
}

/** What a platform's archives carry besides the libraries (Android's libc++_shared.so): allowed in each build's license. */
function shipsProblems(data: EngineData, ctx: Ctx): Block[] {
  const lines: Line[] = [];
  for (const platform of ctx.platforms) {
    for (const [file, { license: expr }] of Object.entries(data.platforms.get(platform)?.ships ?? {})) {
      const verdict = allowedBy(expr, data.licenses);
      if (!('allowed' in verdict)) continue; // engine data reports it
      for (const license of unique(ctx.variants.map((v) => v.license))) {
        if (!verdict.allowed.includes(license)) lines.push({ mark: '✗', text: `${platform} ships ${file} (${expr}), which ${license} doesn't allow` });
      }
    }
  }
  return lines.length ? [{ lines }] : [];
}

function anyCellMatches(cond: Condition, ctx: Ctx): boolean {
  return ctx.variants.some((v) => ctx.platforms.some((platform) => conditionMatches(cond, { ...v, platform })));
}

function neverReason(cond: Condition, ctx: Ctx): string {
  const { profile, variants, platforms } = ctx;
  if (cond.ffmpeg && !variants.some((v) => cond.ffmpeg!.some((c) => matchesVersionCondition(v.version, c)))) {
    return `This profile targets ffmpeg: ${fmtList(profile.ffmpeg)} only, so this entry can never apply.`;
  }
  if (cond.platforms && !platforms.some((p) => platformMatches(p, cond.platforms!))) {
    return `None of this profile's platforms match ${fmtList(cond.platforms)}, so this entry can never apply.`;
  }
  if (cond.license && !profile.license.some((l) => cond.license!.includes(l))) {
    return `This profile doesn't build ${fmtList(cond.license)}, so this entry can never apply.`;
  }
  return 'No build in this profile matches all of this condition, so this entry can never apply.';
}

function withBlocks(profile: Profile, data: EngineData, cells: CellPlan[], ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  profile.with.forEach((entry, index) => {
    const option = resolveName(data, entry.name);
    if (!option) return;
    // `with: x` plus `without: x`, both everywhere: already one problem in entryProblems
    if (!entry.cond && profile.without.some((x) => !x.cond && resolveName(data, x.name) === option)) return;
    const hits = cells.flatMap((plan) => plan.withResults.filter((r) => r.index === index).map((r) => ({ plan, absence: r.absence })));
    if (!hits.length) return; // the condition never applies: reported by entryProblems
    const present = hits.filter((h) => h.plan.options.includes(option)).map((h) => h.plan.cell);
    // where the profile's own `without` excludes it, that is the reason, whatever else would also keep it out
    const excluded = (cell: Cell): Reason | undefined =>
      profile.without.some((x) => resolveName(data, x.name) === option && conditionMatches(x.cond, cell)) ? { kind: 'without', reason: 'removed by without' } : undefined;
    const absent = hits
      .filter((h) => !h.plan.options.includes(option))
      .map((h) => ({ cell: h.plan.cell, reason: excluded(h.plan.cell) ?? h.absence ?? notChosen(h.plan, option, data) }));
    // a license that doesn't allow a listed entry is always an error: the profile asks for something it can't ship
    const licensed = groupReasons(absent.filter((a) => a.reason.kind === 'license'));
    // `without` is the profile's own exception: reported, never a failure of the entry it carves out of
    const removed = groupReasons(absent.filter((a) => a.reason.kind === 'without'));
    const missing = groupReasons(absent.filter((a) => a.reason.kind !== 'license' && a.reason.kind !== 'without'));
    // a platforms: or ffmpeg: condition asks for the entry wherever it matches; a license: limit is only compliance
    const required = Boolean(entry.cond?.platforms || entry.cond?.ffmpeg);
    const lines: Line[] = [];
    if (present.length) lines.push({ mark: '✓', text: `${required && !absent.length ? 'required and ' : ''}available on ${describeCells(present, ctx)}` });
    const fix = licensed.length ? [licenseFix(data, entry, option, profile, absent.filter((a) => a.reason.kind === 'license').map((a) => a.cell), ctx.target)] : [];
    lines.push(...licensed.map((m): Line => ({ mark: '✗', text: m.text, detail: fix })));
    if (required) lines.push(...missing.map((m): Line => ({ mark: '✗', text: `required here, but ${m.text}` })));
    // a group conflict is already a problem in the group's block, and a license one just above
    else if (!present.length && !licensed.length && !removed.length && !missing.some((m) => m.kind === 'conflict')) {
      lines.push({ mark: '✗', text: `${entry.name} would be in no build at all`, detail: missing.map((m) => m.text) });
    }
    else lines.push(...missing.map((m): Line => ({ mark: '-', text: m.text, note: 'reported, not an error' })));
    lines.push(...removed.map((m): Line => ({ mark: '-', text: m.text })));
    blocks.push({ title: `with: ${fmtEntry(entry)}`, lines });
  });
  return blocks;
}

function groupBlocks(data: EngineData, cells: CellPlan[], ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  for (const group of unique(cells.flatMap((c) => Object.keys(c.groups))).sort()) {
    const conflicted = cells.some((c) => c.conflicts.some((x) => x.group === group));
    if (!conflicted && !cells.some((c) => c.groups[group])) continue;
    const members = unique(
      ctx.variants
        .flatMap((v) => [...optionsOf(data, v.major).values()].filter((o) => o.group === group))
        .map((o) => o.name)
        .sort(),
    );
    const perVariant = ctx.variants.map((v) => {
      const byPick = new Map<string, string[]>();
      for (const c of cells.filter((c) => c.cell.series === v.series && c.cell.license === v.license)) {
        const pick = c.groups[group] ?? (c.conflicts.some((x) => x.group === group) ? 'more than one' : 'none');
        byPick.set(pick, [...(byPick.get(pick) ?? []), c.cell.platform]);
      }
      return { v, text: [...byPick].map(([pick, ps]) => `${describePlatforms(ps)}: ${pick}`).join('     ') };
    });
    const lines: Line[] = perVariant.every((p) => p.text === perVariant[0]!.text)
      ? [{ mark: '✓', text: perVariant[0]!.text }]
      : perVariant.map((p): Line => ({ mark: '✓', text: `FFmpeg ${seriesLabel(p.v)}, ${p.v.license}:  ${p.text}` }));
    const conflicts = groupReasons(
      cells.flatMap((c) => c.conflicts.filter((x) => x.group === group).map((x) => ({ cell: c.cell, reason: { kind: 'conflict' as const, reason: x.message } }))),
    );
    lines.push(...conflicts.map((c): Line => ({ mark: '✗', text: c.text })));
    blocks.push({ title: `${members.join(' / ')}  (${group} - one per build)`, lines });
  }
  return blocks;
}

/** `uses` pieces a build leaves out (srt without mbedTLS on lgplv2): reported, never an error. */
function leftOutBlocks(cells: CellPlan[]): Block[] {
  const byWhat = new Map<string, { recipe: string; uses: string; kind: 'platform' | 'license'; reason: string; cells: Cell[] }>();
  for (const c of cells) {
    for (const l of c.leftOut) {
      const key = `${l.recipe}\u0000${l.uses}\u0000${l.reason}`;
      const item = byWhat.get(key) ?? { ...l, cells: [] };
      item.cells.push(c.cell);
      byWhat.set(key, item);
    }
  }
  if (!byWhat.size) return [];
  const lines = [...byWhat.values()].map((l): Line => {
    const where = l.kind === 'platform'
      ? describePlatforms(unique(l.cells.map((c) => c.platform)))
      : unique(l.cells.map((c) => c.license)).join(', ');
    return { mark: '-', text: `${l.recipe} without ${l.uses} on ${where}: ${l.reason}` };
  });
  return [{ title: 'optional parts left out', lines }];
}

/**
 * The `license:` limit that fixes an entry some of the profile's licenses don't allow: the licenses it is allowed in
 * on every FFmpeg version and platform where it was blocked, within the entry's own limit and the profile's licenses.
 */
function licenseFix(data: EngineData, entry: Entry, option: string, profile: Profile, blocked: Cell[], target = false): string {
  // the licenses allowed in every build where it was blocked (each FFmpeg version and platform it is in)
  const builds = unique(blocked.filter((c) => optionsOf(data, c.major).has(option)).map((c) => `${c.major}\u0000${c.platform}`));
  const allowed = builds.reduce((acc, b) => {
    const [m, p] = b.split('\u0000') as [string, string];
    return acc.filter((l) => optionLicenses(data, m, option, p).includes(l));
  }, [...LICENSES] as License[]);
  // a target is one build with one license: the entry goes, or the target is for another license
  if (target) return allowed.length ? `Remove it from this target (it needs license: ${orList(allowed)})` : 'Remove it from this target (no license allows it here)';
  const usable = profile.license.filter((l) => allowed.includes(l) && (!entry.cond?.license || entry.cond.license.includes(l)));
  return usable.length
    ? `Limit this entry with \`license: [${usable.join(', ')}]\``
    : `Remove it, or add a license it allows: ${allowed.join(', ') || 'none'}`;
}

const orList = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);

/** Why an available option isn't in a build: `without`, or another group member was chosen. */
function notChosen(plan: CellPlan, option: string, data: EngineData): Reason {
  if (plan.removed.includes(option)) return { kind: 'without', reason: 'removed by without' };
  const group = optionsOf(data, plan.cell.major).get(option)?.group;
  return { kind: 'conflict', reason: group ? `more than one ${group} in this build` : 'not selected' };
}

function groupReasons(items: { cell: Cell; reason: Reason }[]): { kind: Reason['kind']; text: string }[] {
  const groups = new Map<string, { reason: Reason; cells: Cell[] }>();
  for (const { cell, reason } of items) {
    const key = `${reason.kind}\u0000${reason.reason}`;
    const g = groups.get(key) ?? { reason, cells: [] };
    g.cells.push(cell);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ reason, cells }) => ({ kind: reason.kind, text: reasonText(reason, cells) }));
}

function reasonText(reason: Reason, cells: Cell[]): string {
  const platforms = describePlatforms(unique(cells.map((c) => c.platform)));
  switch (reason.kind) {
    case 'ffmpeg':
      return `FFmpeg ${andList(unique(cells.map(seriesLabel)))}: ${reason.reason}`;
    case 'license':
      return `${unique(cells.map((c) => c.license)).join(', ')}: ${reason.reason}`;
    case 'without':
      return `${reason.reason} on ${platforms}`;
    case 'conflict':
      return `${platforms}: ${reason.reason}`;
    case 'platform':
      return `not on ${platforms}: ${reason.reason}`;
  }
}

function describeCells(cells: Cell[], ctx: Ctx): string {
  const parts = [`FFmpeg ${andList(unique(cells.map(seriesLabel)))}`, describePlatforms(unique(cells.map((c) => c.platform)))];
  const licenses = unique(cells.map((c) => c.license));
  if (licenses.length < ctx.profile.license.length) parts.push(licenses.join(', '));
  return parts.join(', ');
}

/** Whether a pin's form suits how its library is released: a commit for a branch-following library, else a version. */
export function pinFormProblem(data: EngineData, recipe: string, name: string, version: string): string | undefined {
  const released = data.recipes.get(recipe)!.versions;
  if ('git-branch' in released && !isCommit(version)) return `${name} has no releases (it follows the ${released['git-branch']} branch), so pin it to a full commit hash.`;
  if (!('git-branch' in released) && isCommit(version)) return `${name} has releases, so pin a version or range like 1.5 or ~1.5.4, not a commit.`;
  return undefined;
}
