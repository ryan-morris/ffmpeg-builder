import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VersionSource } from './engine-data.ts';
import { compareVersions, isVersion } from './versions.ts';

const execFileAsync = promisify(execFile);

/** What upstream offers: release versions (ascending), or a branch's head commit. */
export type Found = { versions: string[] } | { commit: string };

/** An upstream that can't be read, or that has no matching versions. The message names what and where. */
export class UpstreamError extends Error {}

export class GitMissingError extends Error {
  constructor() {
    super('ffmpeg-build needs git to read upstream versions; install git and try again.');
  }
}

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never stop to ask for a password
    });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') throw new GitMissingError();
    const lines = (err.stderr ?? err.message).trim().split('\n');
    throw new Error(lines.find((l) => l.startsWith('fatal:')) ?? lines.at(-1) ?? 'git failed');
  }
}

export async function gitTags(repo: string): Promise<string[]> {
  const out = await git(['ls-remote', '--tags', '--refs', '--', repo]); // --refs: no ^{} lines; --: a URL is never an option
  return out.split('\n').flatMap((line) => {
    const ref = line.split('\t')[1]?.trim();
    return ref?.startsWith('refs/tags/') ? [ref.slice('refs/tags/'.length)] : [];
  });
}

export async function gitBranchHead(repo: string, branch: string): Promise<string> {
  const commit = (await git(['ls-remote', '--heads', '--', repo, `refs/heads/${branch}`])).split('\t')[0]?.trim();
  if (!commit) throw new Error(`no branch ${branch}`);
  return commit;
}

const MAX_PAGE = 5 * 1024 * 1024;

/** The last path part of every link on a page: `gmp-6.3.0.tar.xz`, or `4.0` for `/files/lame/4.0/`. */
export async function listingLinks(url: string): Promise<string[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (html.length > MAX_PAGE) throw new Error('page is larger than 5 MB; is this really a release listing?');
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => lastSegment(m[1]!));
}

function lastSegment(href: string): string {
  const path = href.split(/[?#]/)[0]!.replace(/\/+$/, '');
  const segment = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Group 1 of `pattern` for every name, keeping only numbers; unique, oldest first. Numbers separated by `_` or `-`
 * (expat's R_2_8_3, freetype's VER-2-14-3) are read as dotted; a recipe's ref rebuilds them with {version_}/{version-}.
 */
function versionsFrom(names: readonly string[], pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const raw = pattern.exec(name)?.[1];
    // only a version without dots uses _ or - as its separator; in 1.2.3-1 the dash is a suffix, not a part
    const v = raw && !raw.includes('.') ? raw.replace(/[_-]/g, '.') : raw;
    if (v && isVersion(v)) found.add(v);
  }
  return [...found].sort(compareVersions);
}

export async function withRetry<T>(fn: () => Promise<T>, delays: number[] = [250, 1000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GitMissingError || attempt >= delays.length) throw e;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** What upstream offers for one source. `what` names it in errors (a recipe, or "FFmpeg"). */
export async function findVersions(source: VersionSource, what: string, delays?: number[]): Promise<Found> {
  const where = source.kind === 'listing' ? source.url : source.repo;
  try {
    if (source.kind === 'git-branch') return { commit: await withRetry(() => gitBranchHead(source.repo, source.branch), delays) };
    const names = await withRetry(() => (source.kind === 'git-tags' ? gitTags(source.repo) : listingLinks(source.url)), delays);
    const versions = versionsFrom(names, source.pattern);
    if (!versions.length) throw new UpstreamError(`${what}: no versions found at ${where} matching ${source.pattern.source}`);
    return { versions };
  } catch (e) {
    if (e instanceof GitMissingError || e instanceof UpstreamError) throw e;
    throw new UpstreamError(`${what}: couldn't read ${where}: ${(e as Error).message}`);
  }
}

/** Run `fn` over `items`, at most `limit` at a time; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
