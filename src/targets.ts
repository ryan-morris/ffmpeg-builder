// ffmpeg-build.yml: a folder's bases and targets. A target is exactly one build (one platform, one license, one
// FFmpeg series); its lists are its bases' merged in order, then its own. The resolver, check and build work on each
// target through targetProfile(), the single-build Profile they already understand.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLATFORMS } from './platforms.ts';
import type { Profile } from './profile.ts';
import { formatIssues } from './schema/common.ts';
import type { License } from './schema/profile.ts';
import { folderSchema } from './schema/targets.ts';
import { isFfmpegSeries } from './versions.ts';
import { parseYaml, YamlError } from './yaml.ts';

export const FOLDER_FILE = 'ffmpeg-build.yml';

export interface Target {
  name: string;
  platform: string;
  license: License;
  ffmpeg: string; // one series: 9, 9.0 or latest
  base: string[];
  with: string[]; // what the build gets, after its bases and its own lists
  without: string[]; // what it turns down (declined): never suggested, never built
  pin: Record<string, string>; // this target's version constraints
  patches: string[];
  tests: string[];
  releaseGroup?: string; // targets with the same group (and FFmpeg version) release together
  allowRemoval: string[]; // components it may lose since the last release
  origin: Map<string, string>; // name -> the layer (base or target name) that last included or declined it
}

export interface Folder {
  file: string; // as shown to the user
  dir: string; // absolute
  bases: Record<string, { with: string[]; without: string[]; pin: Record<string, string> }>;
  pin: Record<string, string>; // folder-wide version constraints
  notify: { newFfmpeg: boolean };
  allowRemoval: string[]; // components any target may lose since the last release
  privateRelease?: 'internal'; // releases go to a private repository: builds and their source only for those with access
  targets: Target[];
}

export type FolderResult = { ok: true; folder: Folder } | { ok: false; file: string; errors: string[] };

const BUILD_KEYS = ['platform', 'license', 'ffmpeg'];

export function loadFolder(dir: string): FolderResult {
  let text: string;
  try {
    text = readFileSync(join(dir, FOLDER_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, file: FOLDER_FILE, errors: [`no ${FOLDER_FILE} here: start one with \`ffmpeg-build init\``] };
    throw e;
  }
  return parseFolderText(text, dir);
}

/** The folder file's text, validated and merged; `dir` is where its patches: paths and lock live. */
export function parseFolderText(text: string, dir: string): FolderResult {
  const file = FOLDER_FILE;
  let raw: unknown;
  try {
    raw = parseYaml(text, file);
  } catch (e) {
    if (e instanceof YamlError) return { ok: false, file, errors: [e.line ? `line ${e.line}: ${e.reason}` : e.reason] };
    throw e;
  }
  // a base that names a build is a common slip; say so instead of "unknown key"
  const errors: string[] = [];
  const rawBases = (raw as { bases?: Record<string, unknown> } | null)?.bases;
  if (rawBases && typeof rawBases === 'object') {
    for (const [b, v] of Object.entries(rawBases)) {
      for (const k of BUILD_KEYS) {
        if (v && typeof v === 'object' && k in v) errors.push(`bases.${b}: ${k} belongs on a target, not a base (a base only holds with, without and pin)`);
      }
    }
  }
  if (errors.length) return { ok: false, file, errors };
  const parsed = folderSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, file, errors: formatIssues(parsed.error) };
  const data = parsed.data;

  const both = (label: string, layer: { with: string[]; without: string[] }) => {
    for (const n of layer.with) if (layer.without.includes(n)) errors.push(`${label}: ${n} is under both with: and without:; keep one`);
  };
  for (const [b, layer] of Object.entries(data.bases)) both(`bases.${b}`, layer);
  const targets: Target[] = [];
  for (const [t, d] of Object.entries(data.targets)) {
    const label = `targets.${t}`;
    if (!PLATFORMS.includes(d.platform)) errors.push(`${label}: platform ${d.platform} is not a platform ffmpeg-build knows`);
    if (!isFfmpegSeries(d.ffmpeg)) errors.push(`${label}: ffmpeg: ${d.ffmpeg} is not an FFmpeg series (write 9, 9.0 or latest)`);
    const unknown = d.base.filter((b) => !(b in data.bases));
    for (const b of unknown) errors.push(`${label}: base ${b} is not defined under bases:`);
    both(label, d);
    if (unknown.length) continue;
    // a later layer overwrites an earlier one, name by name: included, or declined
    const state = new Map<string, boolean>();
    const origin = new Map<string, string>();
    const layers: [string, { with: string[]; without: string[] }][] = [...d.base.map((b): [string, { with: string[]; without: string[] }] => [b, data.bases[b]!]), [t, d]];
    for (const [layerName, layer] of layers) {
      for (const n of layer.with) {
        state.set(n, true); // a name keeps its first place in the order, whatever layers change it
        origin.set(n, layerName);
      }
      for (const n of layer.without) {
        state.set(n, false);
        origin.set(n, layerName);
      }
    }
    targets.push({
      name: t,
      platform: d.platform,
      license: d.license,
      ffmpeg: d.ffmpeg,
      base: d.base,
      with: [...state].filter(([, inc]) => inc).map(([n]) => n),
      without: [...state].filter(([, inc]) => !inc).map(([n]) => n),
      pin: d.pin,
      patches: d.patches,
      tests: d.tests,
      ...(d['release-group'] ? { releaseGroup: d['release-group'] } : {}),
      allowRemoval: d['allow-removal'],
      origin,
    });
  }
  if (!Object.keys(data.targets).length) errors.push('targets: none defined; add one (a name with platform, license and ffmpeg)');
  if (errors.length) return { ok: false, file, errors };
  return {
    ok: true,
    folder: {
      file, dir: resolve(dir), bases: data.bases, pin: data.pin, notify: { newFfmpeg: data.notify?.['new-ffmpeg'] !== 'false' },
      allowRemoval: data['allow-removal'], ...(data['private-release'] ? { privateRelease: data['private-release'] } : {}), targets,
    },
  };
}

/** A build's artifact name: ffmpeg-<version>-<target>, dropping a `-ffmpeg<series>` suffix the version already says. */
export function artifactName(t: Target, version: string): string {
  const suffix = `-ffmpeg${t.ffmpeg}`;
  return `ffmpeg-${version}-${t.name.endsWith(suffix) ? t.name.slice(0, -suffix.length) : t.name}`;
}

/** A target as the single build the resolver, check and build understand. Pins stay out: they are folder constraints. */
export function targetProfile(folder: Folder, t: Target): Profile {
  return {
    file: `${folder.file} (${t.name})`,
    dir: folder.dir,
    name: t.name,
    ffmpeg: [t.ffmpeg],
    platforms: [t.platform],
    license: [t.license],
    with: t.with.map((n) => ({ name: n })),
    without: t.without.map((n) => ({ name: n })),
    pin: [],
    patches: t.patches,
    tests: t.tests,
  };
}
