import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { expandPlatformPattern } from './platforms.ts';
import { formatIssues } from './schema/common.ts';
import { entry as entrySchema, profileSchema, type Condition, type Entry, type ProfileData } from './schema/profile.ts';
import { fmtEntry } from './text.ts';
import { isCommit, isRange } from './ranges.ts';
import { isFfmpegSeries, isVersionCondition } from './versions.ts';
import { parseYaml, YamlError } from './yaml.ts';

export interface Profile extends ProfileData {
  file: string;
  dir?: string; // the profile's folder (absolute) when loaded from a file: patches: paths are relative to it
}

/** Keys every profile has; a YAML file with none of them is something else (docker-compose.yml, ...). */
const PROFILE_MARKERS = ['name', 'ffmpeg', 'platforms', 'license'];

export type LoadResult = { ok: true; profile: Profile } | { ok: false; file: string; errors: string[] };

/** How a profile path is shown: relative to where the command runs (as typed), else as given. */
export function displayPath(path: string): string {
  const rel = relative(process.cwd(), resolve(path));
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path).replace(/\\/g, '/');
}

export function loadProfile(path: string): LoadResult {
  const file = displayPath(path);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, file, errors: ['file not found'] };
    if (code === 'EISDIR') return { ok: false, file, errors: ['this is a folder, not a profile file'] };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, file, errors: ["can't read this file (permission denied)"] };
    throw e;
  }
  const result = parseProfileText(text, file);
  if (result.ok) result.profile.dir = dirname(resolve(path));
  return result;
}

const START_REMOVED =
  'start: was removed: a profile now lists everything it builds. Delete the `start:` line. If it said `start: everything`, list what it should build in `with:` (`ffmpeg-build options` shows what there is).';

/** Whether a YAML file is meant as a profile (has any of name, ffmpeg, platforms, license), not some other YAML. */
export function looksLikeProfileFile(path: string): boolean {
  try {
    const raw = parseYaml(readFileSync(path, 'utf8'), path);
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && PROFILE_MARKERS.some((key) => key in (raw as object));
  } catch {
    return true; // unreadable YAML may well be a broken profile: let the command say what is wrong
  }
}

/**
 * The options a profile turns down outright: its `without:` entries with no condition. They are never suggested
 * (`profile missing`, update notes). A conditional `without:` only excludes some builds, so it doesn't count.
 */
export function declined(profile: Profile): Set<string> {
  return new Set(profile.without.filter((e) => !e.cond).map((e) => e.name));
}

export function parseProfileText(text: string, file: string): LoadResult {
  let raw: unknown;
  try {
    raw = parseYaml(text, file);
  } catch (e) {
    if (e instanceof YamlError) return { ok: false, file, errors: [e.line ? `line ${e.line}: ${e.reason}` : e.reason] };
    throw e;
  }
  const looksLikeProfile =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) && PROFILE_MARKERS.some((key) => key in (raw as object));
  if (!looksLikeProfile) return { ok: false, file, errors: [`this doesn't look like a profile: it has none of ${PROFILE_MARKERS.join(', ')}`] };
  // start: was the old way to opt into everything; one plain error, and the rest of the profile is still checked
  const removed: string[] = [];
  if ('start' in (raw as object)) {
    removed.push(START_REMOVED);
    raw = Object.fromEntries(Object.entries(raw as object).filter(([k]) => k !== 'start'));
  }
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, file, errors: [...removed, ...formatIssues(parsed.error, { '': `a profile has: ${Object.keys(profileSchema.shape).join(', ')}` })] };
  const profile: Profile = { ...parsed.data, file };
  const errors = [...removed, ...valueProblems(profile)];
  return errors.length ? { ok: false, file, errors } : { ok: true, profile };
}

/** What the schema can't express: series syntax, platform patterns, conditions, duplicates. */
function valueProblems(p: Profile): string[] {
  const errors: string[] = [];
  const badSeries = p.ffmpeg.filter((s) => !isFfmpegSeries(s));
  badSeries.forEach((s) => errors.push(`ffmpeg: "${s}" is not an FFmpeg series (use 9, 9.0 or latest)`));
  if (!badSeries.length) {
    if (p.ffmpeg.includes('latest') && p.ffmpeg.length > 1) errors.push('ffmpeg: latest can only be used on its own');
    else {
      p.ffmpeg.forEach((a, i) =>
        p.ffmpeg.slice(i + 1).forEach((b) => {
          if (a === b || b.startsWith(`${a}.`) || a.startsWith(`${b}.`)) errors.push(`ffmpeg: ${a} and ${b} overlap; list each FFmpeg series once`);
        }),
      );
    }
  }
  p.platforms.forEach((s, i) => {
    if (!expandPlatformPattern(s).length) errors.push(`platforms: "${s}" matches no platform`);
    if (p.platforms.indexOf(s) !== i) errors.push(`platforms: ${s} is listed twice`);
  });
  p.license.forEach((l, i) => {
    if (p.license.indexOf(l) !== i) errors.push(`license: ${l} is listed twice`);
  });
  const checkCondition = (where: string, cond: Condition | undefined) => {
    cond?.ffmpeg?.forEach((c) => {
      if (!isVersionCondition(c)) errors.push(`${where}: "${c}" is not a version condition (use 9, ">=8" or "<9.1")`);
    });
    cond?.platforms?.forEach((c) => {
      if (!expandPlatformPattern(c).length) errors.push(`${where}: "${c}" matches no platform`);
    });
  };
  p.with.forEach((e, i) => checkCondition(`with[${i}]`, e.cond));
  p.without.forEach((e, i) => checkCondition(`without[${i}]`, e.cond));
  p.pin.forEach((e, i) => checkCondition(`pin[${i}]`, e.cond));
  p.pin.forEach((e, i) => {
    if (!isRange(e.version) && !isCommit(e.version)) {
      errors.push(`pin[${i}]: "${e.version}" is not a version or range (use 4.3, 4.3.1, ~1.5.4, ^1.5.4 or ">=3.6 <4", or a full commit hash)`);
    }
  });
  // the same name with a different condition is a separate entry; the same entry twice is a slip
  const twice = (key: string, entries: { name: string; cond?: Condition; version?: string }[]) => {
    const seen = new Set<string>();
    for (const e of entries) {
      const id = JSON.stringify([e.name, e.cond ?? null, e.version ?? null]);
      if (seen.has(id)) errors.push(`${key}: ${fmtEntry(e)} is listed twice`);
      seen.add(id);
    }
  };
  twice('with', p.with);
  twice('without', p.without);
  twice('pin', p.pin);
  return errors;
}

/** One `with:`/`without:` item, read exactly as a profile reads it; undefined when it isn't one. */
export function parseEntry(raw: unknown): Entry | undefined {
  const parsed = entrySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
