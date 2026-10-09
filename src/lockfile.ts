import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { formatIssues, name, text } from './schema/common.ts';
import { conditionShape, type Condition } from './schema/profile.ts';
import { displayPath } from './profile.ts';
import { parseYaml, YamlError } from './yaml.ts';

export const LOCK_FILE = 'ffmpeg.lock';

export interface LockedPin { name: string; version: string; cond?: Condition }
export interface LockedProfile { ffmpeg: Record<string, string>; libraries: Record<string, string>; pinned: LockedPin[] }
export interface Lock { engine: string; profiles: Record<string, LockedProfile> }

export class LockError extends Error {}

const RECOVER = 'ffmpeg.lock is written by ffmpeg-build: resolve the conflict, or delete it and run ffmpeg-build lock';

const pinnedEntry = z
  .record(name, z.strictObject({ ...conditionShape, version: text }))
  .refine((o) => Object.keys(o).length === 1, { error: 'each pinned entry names exactly one library' })
  .transform((o): LockedPin => {
    const [library, { version, ...cond }] = Object.entries(o)[0]!;
    return Object.keys(cond).length ? { name: library, version, cond: cond as Condition } : { name: library, version };
  });

const lockSchema = z.strictObject({
  engine: text,
  profiles: z
    .record(
      name,
      z.strictObject({
        ffmpeg: z.record(text, text),
        libraries: z.record(name, text).default({}),
        pinned: z.array(pinnedEntry).default([]),
      }),
    )
    .default({}),
});

export function parseLock(source: string, file: string): Lock {
  let raw: unknown;
  try {
    raw = parseYaml(source, file);
  } catch (e) {
    if (e instanceof YamlError) throw new LockError(`${e.message} (${RECOVER})`);
    throw e;
  }
  const parsed = lockSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new LockError(`${formatIssues(parsed.error).map((m) => `${file}: ${m}`).join('\n')}\n(${RECOVER})`);
  return parsed.data;
}

/** The lock at `path`, or undefined when there is none yet. */
export function readLock(path: string): Lock | undefined {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return parseLock(source, displayPath(path));
}

const HEADER = '# ffmpeg.lock - written only by `ffmpeg-build update` / `ffmpeg-build lock`. Do not edit.';
const plain = (v: string) => (/^[\w.+-]+$/.test(v) ? v : JSON.stringify(v));

function condText(cond: Condition): string {
  return Object.entries(cond)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: [${(v as string[]).map(plain).join(', ')}]`)
    .join(', ');
}

/** Fixed layout: profiles and libraries sorted, pins in profile order, so diffs show only real changes. */
export function formatLock(lock: Lock): string {
  const out = [HEADER, `engine: ${plain(lock.engine)}`];
  const profiles = Object.keys(lock.profiles).sort();
  out.push(profiles.length ? 'profiles:' : 'profiles: {}');
  for (const profile of profiles) {
    const p = lock.profiles[profile]!;
    out.push(`  ${profile}:`);
    out.push(`    ffmpeg: { ${Object.entries(p.ffmpeg).map(([series, v]) => `${JSON.stringify(series)}: ${plain(v)}`).join(', ')} }`);
    const libraries = Object.keys(p.libraries).sort();
    if (libraries.length) {
      out.push('    libraries:');
      for (const l of libraries) out.push(`      ${l}: ${plain(p.libraries[l]!)}`);
    }
    if (p.pinned.length) {
      out.push('    pinned:');
      for (const pin of p.pinned) out.push(`      - ${pin.name}: { version: ${plain(pin.version)}${pin.cond ? `, ${condText(pin.cond)}` : ''} }`);
    }
  }
  return `${out.join('\n')}\n`;
}

// ---- the folder lock (targets): one version per FFmpeg series and per library, shared by every target ----------

export interface FolderLock { engine: string; ffmpeg: Record<string, string>; libraries: Record<string, string> }

const folderLockSchema = z.strictObject({
  engine: text,
  ffmpeg: z.record(text, text).default({}),
  libraries: z.record(name, text).default({}),
});

export function parseFolderLock(source: string, file: string): FolderLock {
  let raw: unknown;
  try {
    raw = parseYaml(source, file);
  } catch (e) {
    if (e instanceof YamlError) throw new LockError(`${e.message} (${RECOVER})`);
    throw e;
  }
  if (raw && typeof raw === 'object' && 'profiles' in raw) {
    throw new LockError(`${file} predates targets (it has profiles:); run \`ffmpeg-build migrate\` to convert this folder`);
  }
  const parsed = folderLockSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new LockError(`${formatIssues(parsed.error).map((m) => `${file}: ${m}`).join('\n')}\n(${RECOVER})`);
  return parsed.data;
}

/** The folder lock at `path`, or undefined when there is none yet. */
export function readFolderLock(path: string): FolderLock | undefined {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return parseFolderLock(source, displayPath(path));
}

/** Fixed layout: series and libraries sorted, so diffs show only real changes. */
export function formatFolderLock(lock: FolderLock): string {
  const series = Object.keys(lock.ffmpeg).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const out = [HEADER, `engine: ${plain(lock.engine)}`, `ffmpeg: { ${series.map((s) => `${JSON.stringify(s)}: ${plain(lock.ffmpeg[s]!)}`).join(', ')} }`];
  const libraries = Object.keys(lock.libraries).sort();
  out.push(libraries.length ? 'libraries:' : 'libraries: {}');
  for (const l of libraries) out.push(`  ${l}: ${plain(lock.libraries[l]!)}`);
  return `${out.join('\n')}\n`;
}
