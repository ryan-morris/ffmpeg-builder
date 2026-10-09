// `ffmpeg-build init`: a new ffmpeg-build.yml from the shipped targets the selection names, with bases factored afresh
// for just those targets (one target gets no bases at all).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPLAIN, renderFolder, type Draft } from './migrate.ts';
import { packageRoot } from './paths.ts';
import { platformMatches } from './platforms.ts';
import { LICENSES, type License } from './schema/profile.ts';
import { EditError } from './profile-edit.ts';
import { parseFolderText, type Folder } from './targets.ts';
import { compareVersions } from './versions.ts';

export interface Selection { license?: License[]; platforms?: string[]; ffmpeg?: string[]; empty?: boolean }

/** --license, --platforms and --ffmpeg as typed: comma lists, licenses checked. */
export function selectionFrom(opts: { license?: string; platforms?: string; ffmpeg?: string }): Selection {
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const sel: Selection = {};
  if (opts.license) {
    const licenses = list(opts.license);
    const unknown = licenses.filter((l) => !(LICENSES as readonly string[]).includes(l));
    if (unknown.length) throw new EditError(`--license: ${unknown.join(', ')} is not a license; use ${LICENSES.join(', ')}`);
    sel.license = licenses as License[];
  }
  if (opts.platforms) sel.platforms = list(opts.platforms);
  if (opts.ffmpeg) sel.ffmpeg = list(opts.ffmpeg);
  return sel;
}

/** profiles/<name>.yml, the shipped targets file. */
export function shippedFolder(name: string): Folder {
  let text: string;
  try {
    text = readFileSync(join(packageRoot, 'profiles', `${name}.yml`), 'utf8');
  } catch {
    throw new EditError(`there is no shipped targets file ${name}; use --from devenvy`);
  }
  const r = parseFolderText(text, join(packageRoot, 'profiles'));
  if (!r.ok) throw new EditError(`profiles/${name}.yml is not a targets file (${r.errors[0]}); use --from devenvy`);
  return r.folder;
}

const orList = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : items[0]!);

/** The folder file's text for the shipped targets `sel` names: newest FFmpeg series unless --ffmpeg says otherwise. */
export function initFolder(shipped: Folder, sel: Selection, from = 'devenvy'): string {
  const series = [...new Set(shipped.targets.map((t) => t.ffmpeg))].sort((a, b) => compareVersions(`${a}.0`, `${b}.0`));
  const newest = series.at(-1)!;
  const wanted = sel.ffmpeg ?? [newest];
  const unknown = wanted.filter((s) => s !== 'latest' && !series.includes(s));
  if (unknown.length) throw new EditError(`no shipped target builds FFmpeg ${unknown.join(', ')}; they build ${orList([...series, 'latest'])}`);
  const platforms = [...new Set(shipped.targets.map((t) => t.platform))];
  if (sel.platforms) {
    const none = sel.platforms.filter((p) => !platforms.some((x) => platformMatches(x, [p])));
    if (none.length) throw new EditError(`no shipped target is on ${none.join(', ')}; the shipped platforms are ${platforms.sort().join(', ')}`);
  }
  const chosen = shipped.targets.filter(
    (t) =>
      (wanted.includes(t.ffmpeg) || (wanted.includes('latest') && t.ffmpeg === newest)) &&
      (!sel.license || sel.license.includes(t.license as License)) &&
      (!sel.platforms || platformMatches(t.platform, sel.platforms)),
  );
  if (!chosen.length) throw new EditError('no shipped target matches that selection; `ffmpeg-build targets` in a folder made with plain `ffmpeg-build init` lists them all');
  const drafts: Draft[] = chosen.map((t) => ({
    name: t.name,
    profile: from,
    platform: t.platform,
    license: t.license,
    // `latest` stands in for the newest series when asked for, unless that series was asked for too
    ffmpeg: t.ffmpeg === newest && wanted.includes('latest') && !wanted.includes(newest) ? 'latest' : t.ffmpeg,
    include: sel.empty ? [] : t.with,
    decline: sel.empty ? [] : t.without,
    pin: sel.empty ? {} : t.pin,
    patches: [],
    tests: [],
  }));
  const header = [`# ffmpeg-build.yml: made by \`ffmpeg-build init\` from the shipped ${from} targets. Each target is one build`, ...EXPLAIN];
  return renderFolder(drafts, sel.empty ? {} : shipped.pin, header);
}
