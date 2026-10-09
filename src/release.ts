// Releases: which targets ship together, what each one is made of, and whether a release is due. A release is one
// release group at one resolved FFmpeg version; its tag is `[<group>-]<ffmpeg>.<build>`.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setupFiles } from './build/plan.ts';
import { versionInCell } from './choose.ts';
import type { EngineData } from './engine-data.ts';
import type { FolderLock } from './lockfile.ts';
import type { Manifest, ManifestTarget } from './manifest.ts';
import { packageVersion } from './paths.ts';
import { planProfile, type CellPlan } from './resolve.ts';
import { targetProfile, type Folder, type Target } from './targets.ts';

/** What a target's build is made of: if any of it differs from the last release, the release is due. */
export interface TargetFacts {
  ffmpeg: string;
  components: Record<string, string>;
  patches: { name: string; sha256: string }[];
  toolchain: string;
  definition: string;
  engine: string;
}

export interface PlannedTarget { target: Target; cell: CellPlan; facts: TargetFacts; runner: string }
export interface PlannedRelease { group: string; ffmpeg: string; base: string; targets: PlannedTarget[] }

/**
 * The iOS / Mac Catalyst framework builds of one licence ship as one xcframework bundle (bundle --apple): these four
 * slices, published as one entry named ios-<license> with platform ios.
 */
export const APPLE_SLICES = ['ios-arm64', 'ios-sim-arm64', 'maccatalyst-arm64', 'maccatalyst-x64'] as const;
export const isFrameworkPlatform = (platform: string) => /^(ios|maccatalyst)-/.test(platform);

/** What a release publishes: a target as it is, or a licence's framework slices as one ios-<license> entry. */
export interface PublishedTarget {
  name: string;
  platform: string;
  license: Target['license'];
  facts: TargetFacts;
  slices: PlannedTarget[]; // the builds behind it: one, or a licence's framework slices
  allowRemoval: string[];
}

const sha = (...parts: (string | Buffer)[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
};

/** Every file under `dir`, sorted, with its path relative to `dir`. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return out;
}

/** A hash of every file of a folder (names and contents), stable across machines. */
export function treeHash(dir: string): string {
  return sha(...filesUnder(dir).flatMap((f) => [relative(dir, f).replaceAll('\\', '/'), readFileSync(f)]));
}

/**
 * The toolchain as defined, before any image is built: the image folder (or the host for native builds), the driver,
 * and the platform's setup with the helpers it sources. The same on every machine, unlike a built image's ID.
 */
export function toolchainDefinition(engineRoot: string, data: EngineData, platform: string): string {
  const entry = data.platforms.get(platform)!;
  const image = entry.image === 'macos' ? 'macos' : treeHash(join(engineRoot, 'images', entry.image));
  const setup = setupFiles(engineRoot, entry.setup).flatMap((f) => [relative(engineRoot, f).replaceAll('\\', '/'), readFileSync(f)]);
  return sha(image, readFileSync(join(engineRoot, 'platforms', 'driver.sh')), JSON.stringify(entry), ...setup);
}

/** The runner a platform builds on in CI (platforms.yml `runner:`). */
export const runnerOf = (data: EngineData, platform: string) => data.platforms.get(platform)?.runner ?? 'ubuntu-24.04';

/** The facts of one target's build, at the lock's versions. */
export function targetFacts(folder: Folder, t: Target, data: EngineData, lock: FolderLock, engineRoot: string): { cell: CellPlan; facts: TargetFacts } | { error: string } {
  const version = lock.ffmpeg[t.ffmpeg];
  if (!version) return { error: `ffmpeg.lock has no FFmpeg ${t.ffmpeg}; run ffmpeg-build lock` };
  if (!data.platforms.has(t.platform)) return { error: `${t.platform} doesn't build yet (platforms.yml has no entry for it)` };
  const profile = targetProfile(folder, t);
  const cell = planProfile(profile, data, { [t.ffmpeg]: version }).cells[0];
  if (!cell) return { error: `${t.name} plans no build; run ffmpeg-build check` };
  const locked = { ffmpeg: lock.ffmpeg, libraries: lock.libraries, pinned: [] };
  const components = Object.fromEntries([...cell.recipes].sort().map((r) => [r, versionInCell(profile, data, locked, cell.cell, r) ?? '?']));
  const patches = t.patches.map((p) => ({ name: p.replace(/^patches\//, ''), sha256: treeHash(join(folder.dir, p)) }));
  // what the target asks for, resolved: the same lists from different bases are the same definition
  const definition = sha(JSON.stringify({ platform: t.platform, license: t.license, ffmpeg: t.ffmpeg, with: [...t.with].sort(), without: [...t.without].sort(), pin: { ...folder.pin, ...t.pin }, tests: t.tests }));
  return { cell, facts: { ffmpeg: version, components, patches, toolchain: toolchainDefinition(engineRoot, data, t.platform), definition, engine: packageVersion() } };
}

/** The folder's releases: its targets grouped by release group and resolved FFmpeg version. */
export function planReleases(folder: Folder, data: EngineData, lock: FolderLock, engineRoot: string): { releases: PlannedRelease[]; errors: string[] } {
  const errors: string[] = [];
  const by = new Map<string, PlannedRelease>();
  for (const t of folder.targets) {
    const r = targetFacts(folder, t, data, lock, engineRoot);
    if ('error' in r) {
      errors.push(`${t.name}: ${r.error}`);
      continue;
    }
    const group = t.releaseGroup ?? '';
    const base = `${group ? `${group}-` : ''}${r.facts.ffmpeg}`;
    const rel = by.get(base) ?? { group, ffmpeg: r.facts.ffmpeg, base, targets: [] };
    rel.targets.push({ target: t, cell: r.cell, facts: r.facts, runner: runnerOf(data, t.platform) });
    by.set(base, rel);
  }
  return { releases: [...by.values()].sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true })), errors };
}

/**
 * The release's published targets, in the order they first appear. A licence's framework slices become one entry:
 * components and patches are the slices' union (one lock, so one version each), toolchain and definition a hash of the
 * slices' own, so a change to any slice is a change to the entry.
 */
export function publishedTargets(rel: PlannedRelease): PublishedTarget[] {
  const out: (PublishedTarget | string)[] = [];
  const frameworks = new Map<string, PlannedTarget[]>();
  for (const p of rel.targets) {
    if (!isFrameworkPlatform(p.target.platform)) {
      out.push({ name: p.target.name, platform: p.target.platform, license: p.target.license, facts: p.facts, slices: [p], allowRemoval: p.target.allowRemoval });
      continue;
    }
    if (!frameworks.has(p.target.license)) out.push(p.target.license);
    frameworks.set(p.target.license, [...(frameworks.get(p.target.license) ?? []), p]);
  }
  return out.map((o): PublishedTarget => {
    if (typeof o !== 'string') return o;
    const slices = [...frameworks.get(o)!].sort((a, b) => a.target.platform.localeCompare(b.target.platform));
    const components = Object.assign({}, ...slices.map((s) => s.facts.components)) as Record<string, string>;
    const patches = new Map(slices.flatMap((s) => s.facts.patches).map((x) => [x.name, x]));
    return {
      name: `ios-${o}`, platform: 'ios', license: slices[0]!.target.license, slices,
      facts: {
        ffmpeg: slices[0]!.facts.ffmpeg, engine: slices[0]!.facts.engine,
        components: Object.fromEntries(Object.keys(components).sort().map((k) => [k, components[k]!])),
        patches: [...patches.values()].sort((a, b) => a.name.localeCompare(b.name)),
        toolchain: sha(...slices.map((s) => `${s.target.platform} ${s.facts.toolchain}`)),
        definition: sha(...slices.map((s) => `${s.target.platform} ${s.facts.definition}`)),
      },
      allowRemoval: [...new Set(slices.flatMap((s) => s.target.allowRemoval))],
    };
  });
}

/** Why a release differs from its last published manifest; empty when it doesn't. */
export function changesSince(rel: PlannedRelease, previous: Manifest | undefined): string[] {
  if (!previous) return ['never released'];
  const why: string[] = [];
  const was = new Map(previous.targets.map((t) => [t.name, t]));
  const published = publishedTargets(rel);
  for (const { name, facts } of published) {
    const p = was.get(name);
    if (!p) {
      why.push(`${name}: new`);
      continue;
    }
    const diff = factDiff(facts, p, previous);
    if (diff.length) why.push(`${name}: ${diff.join(', ')}`);
  }
  for (const name of was.keys()) if (!published.some((t) => t.name === name)) why.push(`${name}: removed`);
  return why;
}

function factDiff(now: TargetFacts, was: ManifestTarget, m: Manifest): string[] {
  const out: string[] = [];
  if (now.ffmpeg !== m.ffmpeg) out.push(`FFmpeg ${m.ffmpeg} -> ${now.ffmpeg}`);
  if (now.engine !== m.engine) out.push(`engine ${m.engine} -> ${now.engine}`);
  if (now.toolchain !== was.toolchain) out.push('toolchain');
  if (now.definition !== was.definition) out.push('definition');
  const names = new Set([...Object.keys(now.components), ...Object.keys(was.components)]);
  for (const n of [...names].sort()) {
    if (now.components[n] !== was.components[n]) out.push(`${n} ${was.components[n] ?? '-'} -> ${now.components[n] ?? '-'}`);
  }
  if (JSON.stringify(now.patches) !== JSON.stringify(was.patches)) out.push('patches');
  return out;
}

/**
 * The always-on guard: a component a target had in the last release that it no longer has stops the release, unless
 * the target (or the folder) allows that removal.
 */
export function removals(rel: PlannedRelease, previous: Manifest | undefined, folder: Folder): string[] {
  if (!previous) return [];
  const errors: string[] = [];
  for (const { name, facts, allowRemoval } of publishedTargets(rel)) {
    const was = previous.targets.find((t) => t.name === name);
    if (!was) continue;
    const allowed = new Set([...folder.allowRemoval, ...allowRemoval]);
    for (const c of Object.keys(was.components)) {
      if (!(c in facts.components) && !allowed.has(c)) {
        errors.push(`${name}: ${c} was in ${previous.release} and is gone now; if that is intended, add allow-removal: [${c}] to the target`);
      }
    }
  }
  return errors;
}
