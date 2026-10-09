import { renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Upstreams } from '../choose.ts';
import { ffmpegVersionSource, versionSource, type EngineData } from '../engine-data.ts';
import { displayPath } from '../profile.ts';
import { isCommit } from '../ranges.ts';
import { findVersions, GitMissingError, mapLimit, UpstreamError } from '../upstream.ts';

export class UpstreamFailure extends Error {
  readonly failures: string[];

  constructor(failures: string[]) {
    const ffmpegDown = failures.some((f) => f.startsWith('FFmpeg:'));
    super(
      `Couldn't read every upstream, so nothing was written:\n${failures.map((f) => `  ${f}`).join('\n')}` +
        (ffmpegDown ? "\nThe libraries weren't checked, because which builds need them depends on the FFmpeg version." : ''),
    );
    this.failures = failures;
  }
}

/** A file that couldn't be written; nothing was changed. */
export class WriteError extends Error {}

export type Fetch = (keys: readonly string[], into: Upstreams) => Promise<void>;

/** Fills `into` with what upstream offers for `keys` ('ffmpeg' or recipe names), 8 at a time. */
export function upstreamFetcher(data: EngineData): Fetch {
  const failed = new Map<string, string>(); // asked once per run: a second profile gets the same answer, not another wait
  return async (keys, into) => {
    const known = keys.filter((k) => failed.has(k)).map((k) => failed.get(k)!);
    const todo = keys.filter((k) => !failed.has(k) && (k === 'ffmpeg' ? !into.ffmpeg : !into.libraries.has(k)));
    const results = await mapLimit(todo, 8, (k) =>
      k === 'ffmpeg' ? findVersions(ffmpegVersionSource(data), 'FFmpeg') : findVersions(versionSource(data, k), k),
    );
    const failures: string[] = [...known];
    results.forEach((result, i) => {
      const key = todo[i]!;
      if (result.status === 'rejected') {
        if (result.reason instanceof GitMissingError) throw result.reason;
        const message = result.reason instanceof UpstreamError ? result.reason.message : `${key}: ${String(result.reason)}`;
        failed.set(key, message);
        failures.push(message);
      } else if (key === 'ffmpeg') {
        into.ffmpeg = 'versions' in result.value ? result.value.versions : [];
      } else {
        into.libraries.set(key, result.value);
      }
    });
    if (failures.length) throw new UpstreamFailure(failures);
  };
}

export const shortVersion = (v: string) => (isCommit(v) ? v.slice(0, 12) : v);

/** Write every file to `<path>.tmp`, then rename them all into place; if any write fails, remove the temp files. */
export function stageAndSwap(writes: { path: string; text: string }[]): void {
  const staged: string[] = [];
  for (const w of writes) {
    try {
      writeFileSync(`${w.path}.tmp`, w.text);
      staged.push(`${w.path}.tmp`);
    } catch (e) {
      for (const tmp of staged) rmSync(tmp, { force: true });
      const code = (e as NodeJS.ErrnoException).code;
      const why = code === 'ENOENT' ? "its folder doesn't exist" : code === 'EACCES' || code === 'EPERM' ? 'permission denied' : (e as Error).message;
      throw new WriteError(`Couldn't write ${displayPath(w.path)}: ${why}. Nothing was written.`);
    }
  }
  for (const w of writes) renameSync(`${w.path}.tmp`, w.path);
}
