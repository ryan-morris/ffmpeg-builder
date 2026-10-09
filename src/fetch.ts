// `ffmpeg-build fetch`: a product takes a published build instead of building FFmpeg. The pin is one line,
// `owner/repo@tag`; the release's manifest.yml says which assets a target has and their sha256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { MANIFEST_FILE, parseManifest, type Manifest, type ManifestTarget } from './manifest.ts';
import { extractTarGz, mergeInto, UnsafeArchiveError } from './untar.ts';

export class FetchError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2 = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface Pin { repo: string; tag: string }
export const STAMP = '.ffmpeg-build-fetch';

export function parsePin(text: string): Pin {
  const m = /^\s*([\w.-]+\/[\w.-]+)@(\S+)\s*$/.exec(text);
  if (!m || m[1]!.split('/').some((part) => /^\.+$/.test(part))) throw new FetchError(`"${text.trim()}" is not a release pin; write it as owner/repo@tag, e.g. devenvy/ffmpeg@9.0.2.3`);
  return { repo: m[1]!, tag: m[2]! };
}

const api = () => (process.env.FFMPEG_BUILD_GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');
const token = () => process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

const local = (u: URL) => u.hostname === '127.0.0.1' || u.hostname === 'localhost';

async function get(url: string, accept: string): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !local(u)) throw new FetchError(`refusing to download over ${u.protocol} (${u.host}); only https`);
  const headers: Record<string, string> = { accept, 'user-agent': 'ffmpeg-build' };
  // the token is for the API; an asset URL on another host (or a redirect to one) never gets it
  if (token() && u.origin === new URL(api()).origin) headers.authorization = `Bearer ${token()}`;
  try {
    return await fetch(url, { headers, redirect: 'follow' });
  } catch (e) {
    throw new FetchError(`couldn't reach ${u.host}: ${(e as Error).message}`);
  }
}

async function json<T>(url: string, what: string): Promise<T> {
  const res = await get(url, 'application/vnd.github+json');
  if (res.status === 404) throw new FetchError(`${what} not found${token() ? '' : ' (a private repository needs GITHUB_TOKEN or GH_TOKEN)'}`);
  if (!res.ok) throw new FetchError(`${what}: GitHub answered ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new FetchError(`${what}: GitHub's answer was cut short or not JSON (${(e as Error).message})`);
  }
}

interface ReleaseAsset { name: string; url: string }
export interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

async function release(pin: Pin): Promise<Release> {
  return json<Release>(`${api()}/repos/${pin.repo}/releases/tags/${encodeURIComponent(pin.tag)}`, `release ${pin.repo}@${pin.tag}`);
}

async function download(pin: Pin, rel: Release, name: string): Promise<Buffer> {
  const a = rel.assets.find((x) => x.name === name);
  if (!a) throw new FetchError(`${pin.repo}@${pin.tag} has no asset ${name}`, 1);
  const res = await get(a.url, 'application/octet-stream');
  if (!res.ok) throw new FetchError(`downloading ${name}: GitHub answered ${res.status}`);
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new FetchError(`downloading ${name}: the connection dropped (${(e as Error).message})`);
  }
}

export async function readManifest(pin: Pin): Promise<{ release: Release; manifest: Manifest }> {
  const rel = await release(pin);
  const text = (await download(pin, rel, MANIFEST_FILE)).toString('utf8');
  try {
    return { release: rel, manifest: parseManifest(text, `${pin.repo}@${pin.tag} ${MANIFEST_FILE}`) };
  } catch (e) {
    throw new FetchError((e as Error).message);
  }
}

/** The target `--target` names, or the only one on `--platform`. */
export function pickTarget(m: Manifest, sel: { target?: string; platform?: string }): ManifestTarget {
  const names = m.targets.map((t) => t.name).join(', ');
  if (sel.target) {
    const t = m.targets.find((x) => x.name === sel.target);
    if (!t) throw new FetchError(`release ${m.release} has no target ${sel.target} (it has ${names})`, 1);
    return t;
  }
  if (sel.platform) {
    const on = m.targets.filter((x) => x.platform === sel.platform);
    if (on.length === 1) return on[0]!;
    if (!on.length) throw new FetchError(`release ${m.release} has nothing for ${sel.platform} (it has ${names})`, 1);
    throw new FetchError(`release ${m.release} has ${on.length} targets for ${sel.platform}; name one with --target (${on.map((t) => t.name).join(', ')})`);
  }
  throw new FetchError('say what to fetch: --target <name> (or --platform <platform> when the release has one target for it)');
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Stamp { pin: string; target: string; dev: boolean; sha256: string[] }

function readStamp(path: string): Stamp | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Stamp;
  } catch {
    return undefined; // unreadable: treated as a folder fetch made, so it is replaced
  }
}

/**
 * Whether `out` may be replaced: it doesn't exist, is empty, or holds an earlier fetch. Never the current folder, one
 * of its parents or a root, whatever is in them.
 */
function checkOut(target: string): void {
  const cwd = resolve('.');
  const rel = relative(target, cwd);
  if (target === dirname(target) || rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new FetchError(`--out ${target} is this folder or one that holds it; fetch replaces --out whole, so name a folder of its own (e.g. --out ffmpeg)`);
  }
  if (!existsSync(target)) return;
  if (!statSync(target).isDirectory()) throw new FetchError(`--out ${target} is a file; name a folder`);
  if (readdirSync(target).length && !existsSync(join(target, STAMP))) {
    throw new FetchError(`--out ${target} already holds files fetch didn't put there; fetch replaces --out whole, so name an empty or new folder`);
  }
}

/**
 * Downloads a target's archives, checks them against the manifest, and unpacks them into `out` (runtime, plus dev
 * with `dev`). `out` is swapped in whole, so it holds exactly that release. A repeat run is a no-op: it trusts the
 * stamp and doesn't re-check the files.
 */
export async function fetchRelease(pinText: string, sel: { target?: string; platform?: string; dev?: boolean }, out: string): Promise<string> {
  const pin = parsePin(pinText);
  const target = resolve(out);
  const stage = join(dirname(target), `.${basename(target)}.fetching`);
  const old = join(dirname(target), `.${basename(target)}.old`);
  // a run that died between the two renames left the only copy in .old: put it back first
  if (existsSync(old) && !existsSync(target)) renameSync(old, target);
  checkOut(target);
  const { release: rel, manifest } = await readManifest(pin);
  const t = pickTarget(manifest, sel);
  const assets = [t.assets.runtime, ...(sel.dev ? [t.assets.dev] : [])];
  const stamp: Stamp = { pin: `${pin.repo}@${pin.tag}`, target: t.name, dev: sel.dev === true, sha256: assets.map((a) => a.sha256) };
  const was = readStamp(join(target, STAMP));
  if (was && was.pin === stamp.pin && was.target === stamp.target && was.dev === stamp.dev) {
    if (JSON.stringify(was.sha256) !== JSON.stringify(stamp.sha256)) {
      throw new FetchError(`${stamp.pin} changed since it was fetched (its checksums differ); release tags must not be reused`, 1);
    }
    return `${out}: already ${t.name} from ${stamp.pin}`;
  }
  const files: Buffer[] = [];
  for (const a of assets) {
    const data = await download(pin, rel, a.name);
    if (sha256(data) !== a.sha256) throw new FetchError(`${a.name}: checksum mismatch (expected ${a.sha256}, got ${sha256(data)}); nothing was unpacked`, 1);
    files.push(data);
  }
  try {
    rmSync(stage, { recursive: true, force: true });
    // each archive unpacks on its own, then merges: one archive's links can never be followed by the other's entries
    files.forEach((data, i) => extractTarGz(data, i ? `${stage}.${i}` : stage));
    for (let i = 1; i < files.length; i++) {
      mergeInto(`${stage}.${i}`, stage);
      rmSync(`${stage}.${i}`, { recursive: true, force: true });
    }
    writeFileSync(join(stage, STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(old, { recursive: true, force: true });
    if (existsSync(target)) renameSync(target, old);
    renameSync(stage, target);
    rmSync(old, { recursive: true, force: true });
  } catch (e) {
    for (let i = 0; i < files.length; i++) rmSync(i ? `${stage}.${i}` : stage, { recursive: true, force: true });
    if (e instanceof UnsafeArchiveError) throw new FetchError(`refusing to unpack ${t.name}: ${e.message}`, 1);
    throw new FetchError(`couldn't unpack ${t.name} into ${out}: ${(e as Error).message}`);
  }
  return `${out}: ${t.name} from ${stamp.pin}${sel.dev ? ' (with the dev archive)' : ''}`;
}

/** Every release of a repository, every page of them. */
export async function listReleases(repo: string): Promise<Release[]> {
  const all: Release[] = [];
  for (let page = 1; ; page++) {
    const list = await json<Release[]>(`${api()}/repos/${repo}/releases?per_page=100&page=${page}`, `releases of ${repo}`);
    all.push(...list);
    if (list.length < 100) return all;
  }
}

/** `<group>-<ffmpeg>.<build>` or `<ffmpeg>.<build>`: the group, the FFmpeg version and the build number. */
export function parseTag(tag: string): { group: string; ffmpeg: string; build: number } | undefined {
  const m = /^(?:(.+)-)?(\d+\.\d+(?:\.\d+)?)\.(\d+)$/.exec(tag);
  return m ? { group: m[1] ?? '', ffmpeg: m[2]!, build: Number(m[3]) } : undefined;
}

const versionKey = (v: { ffmpeg: string; build: number }) => {
  const parts = v.ffmpeg.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, v.build];
};
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/**
 * `fetch --update`: the newest published release of the same group and FFmpeg major that has the target. Drafts and
 * prereleases are skipped. Rewrites the pin file; returns what changed (for a PR body), or undefined when current.
 */
export async function updatePin(pinFile: string, sel: { target?: string; platform?: string }): Promise<string | undefined> {
  let text: string;
  try {
    text = readFileSync(pinFile, 'utf8');
  } catch {
    throw new FetchError(`can't read the pin file ${pinFile}`);
  }
  const pin = parsePin(text);
  const now = parseTag(pin.tag);
  if (!now) throw new FetchError(`${pin.tag} isn't a release tag ffmpeg-build made (<ffmpeg>.<build> or <group>-<ffmpeg>.<build>)`);
  const { manifest } = await readManifest(pin);
  const target = pickTarget(manifest, sel).name;
  const candidates: { tag: string; key: number[] }[] = [];
  for (const r of await listReleases(pin.repo)) {
    const t = parseTag(r.tag_name);
    if (r.draft || r.prerelease || !t || t.group !== now.group || t.ffmpeg.split('.')[0] !== now.ffmpeg.split('.')[0]) continue;
    if (newer(versionKey(t), versionKey(now))) candidates.push({ tag: r.tag_name, key: versionKey(t) });
  }
  candidates.sort((a, b) => (newer(a.key, b.key) ? -1 : newer(b.key, a.key) ? 1 : 0));
  for (const c of candidates) {
    const next = { repo: pin.repo, tag: c.tag };
    let m: Manifest;
    try {
      m = (await readManifest(next)).manifest;
    } catch (e) {
      if (e instanceof FetchError) continue; // a release without a readable manifest isn't one to move to
      throw e;
    }
    if (!m.targets.some((t) => t.name === target)) continue;
    writeFileSync(pinFile, `${next.repo}@${next.tag}\n`);
    return `FFmpeg build ${pin.tag} -> ${next.tag} (${target}, ${pin.repo})`;
  }
  return undefined;
}

/** Whether a repository is private, as the GitHub API says (a token is needed to see a private one at all). */
export async function repoIsPrivate(repo: string): Promise<boolean> {
  return (await json<{ private: boolean }>(`${api()}/repos/${repo}`, `repository ${repo}`)).private;
}

/** Whether FFmpeg version `a` is at least `b` (as three parts: 9.0 is 9.0.0). */
export function ffmpegAtLeast(a: string, b: string): boolean {
  return !newer(versionKey({ ffmpeg: b, build: 0 }), versionKey({ ffmpeg: a, build: 0 }));
}
