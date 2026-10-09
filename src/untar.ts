// Unpacks a .tar.gz safely, without a system tar (whose flavour and path handling differ per OS). Every entry must stay
// inside the destination: names are checked as text, nothing is ever written through a link, and a symlink may only
// point down or sideways (no `..`), so no chain of links can lead out. Handles ustar, GNU long names and pax records.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export class UnsafeArchiveError extends Error {}

interface Entry { name: string; type: 'file' | 'dir' | 'symlink' | 'hardlink'; data: Buffer; mode: number; link: string }

/** Archives larger than this unpacked are refused (FFmpeg's biggest archive is a few hundred MB). */
const MAX_UNPACKED = 4 * 1024 ** 3;

const text = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
/** A tar number: octal text, or base-256 when the top bit of the first byte is set (GNU, for sizes over 8 GB). */
function num(b: Buffer): number {
  if (b[0]! & 0x80) return b.subarray(1).reduce((n, byte) => n * 256 + byte, b[0]! & 0x7f);
  return parseInt(text(b).trim() || '0', 8);
}

/** The archive's entries, in order. */
export function readTarGz(gz: Buffer): Entry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED });
  } catch (e) {
    throw new UnsafeArchiveError(`not a readable .tar.gz (${(e as Error).message})`);
  }
  const entries: Entry[] = [];
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = pax.size ? Number(pax.size) : num(h.subarray(124, 136));
    const flag = String.fromCharCode(h[156]!);
    if (at + 512 + size > tar.length) throw new UnsafeArchiveError('the archive is cut short');
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (flag === 'L') { longName = text(data); continue; }
    if (flag === 'K') { longLink = text(data); continue; }
    if (flag === 'x') { pax = parsePax(data); continue; }
    if (flag === 'g') continue;
    const prefix = text(h.subarray(345, 500));
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${text(h.subarray(0, 100))}` : text(h.subarray(0, 100)));
    const link = pax.linkpath ?? longLink ?? text(h.subarray(157, 257));
    longName = longLink = undefined;
    pax = {};
    const type = flag === '5' ? 'dir' : flag === '2' ? 'symlink' : flag === '1' ? 'hardlink' : flag === '0' || flag === '\0' || flag === '7' ? 'file' : undefined;
    if (!type) throw new UnsafeArchiveError(`unsupported entry ${name} (type ${flag})`);
    entries.push({ name, type, data: Buffer.from(data), mode: num(h.subarray(100, 108)), link });
  }
  return entries;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < data.length; ) {
    const space = data.indexOf(0x20, at);
    const len = parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!len) break;
    const record = data.subarray(space + 1, at + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

/** Where `name` lands under `dest` (undefined for the folder itself), or an error when it would land outside. */
function inside(dest: string, name: string): string | undefined {
  if (name.includes('\\')) throw new UnsafeArchiveError(`${name}: a backslash in a name`);
  const clean = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (clean === '' || clean === '.') return undefined;
  if (isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) throw new UnsafeArchiveError(`${name}: an absolute path`);
  if (clean.split('/').includes('..')) throw new UnsafeArchiveError(`${name}: a .. in its path`);
  const path = normalize(join(dest, clean));
  const rel = relative(dest, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new UnsafeArchiveError(`${name}: outside the archive's folder`);
  return path;
}

/** Refuses a path any of whose folders under `dest` is a link: nothing is ever written through one. */
function noLinkOnTheWay(dest: string, path: string, name: string): void {
  for (let d = dirname(path); d.length > dest.length; d = dirname(d)) {
    let isLink = false;
    try {
      isLink = lstatSync(d).isSymbolicLink();
    } catch {
      continue; // not made yet
    }
    if (isLink) throw new UnsafeArchiveError(`${name}: goes through a link`);
  }
}

/**
 * Unpacks into `dest` (created). Links are made last, after every file; a symlink may not contain `..` or be absolute,
 * a hard link must name a file of the archive. Where the OS refuses a symlink, the file is copied instead.
 */
export function extractTarGz(gz: Buffer, dest: string): void {
  const entries = readTarGz(gz);
  mkdirSync(dest, { recursive: true });
  const links: { path: string; name: string; target: string; hard: boolean }[] = [];
  for (const e of entries) {
    const path = inside(dest, e.name);
    if (!path) {
      if (e.type === 'dir') continue;
      throw new UnsafeArchiveError(`${e.name || '(empty name)'}: not a file name`);
    }
    noLinkOnTheWay(dest, path, e.name);
    if (e.type === 'dir') {
      mkdirSync(path, { recursive: true });
      continue;
    }
    if (e.type === 'symlink') {
      if (isAbsolute(e.link) || e.link.includes('\\') || e.link.split('/').includes('..')) throw new UnsafeArchiveError(`${e.name}: a link that leaves its folder (${e.link})`);
      links.push({ path, name: e.name, target: e.link, hard: false });
      continue;
    }
    if (e.type === 'hardlink') {
      links.push({ path, name: e.name, target: inside(dest, e.link) ?? dest, hard: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, e.data);
    if (e.mode & 0o111) chmodSync(path, 0o755);
  }
  for (const l of links) {
    mkdirSync(dirname(l.path), { recursive: true });
    noLinkOnTheWay(dest, l.path, l.name);
    if (l.hard) {
      // a hard link becomes a copy of a regular file the archive already wrote, reached without passing a link
      noLinkOnTheWay(dest, l.target, l.name);
      let isFile = false;
      try {
        const st = lstatSync(l.target);
        isFile = st.isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new UnsafeArchiveError(`${l.name}: a hard link to something that isn't a file of the archive`);
      copyFileSync(l.target, l.path);
      continue;
    }
    try {
      symlinkSync(l.target, l.path);
    } catch {
      // Windows without symlink rights: copy the file it names, when that is a plain file of the archive
      const resolved = join(dirname(l.path), l.target);
      try {
        if (lstatSync(resolved).isFile()) copyFileSync(resolved, l.path);
      } catch {
        // a dangling link: nothing to copy
      }
    }
  }
}

/**
 * Moves everything in `from` into `into` (both unpacked by extractTarGz), refusing any path that would pass through a
 * link of `into`; a file already in `into` is kept.
 */
export function mergeInto(from: string, into: string): void {
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, e.name);
      const dst = join(into, relative(from, src));
      noLinkOnTheWay(into, dst, relative(from, src));
      if (e.isDirectory() && !e.isSymbolicLink()) {
        mkdirSync(dst, { recursive: true });
        walk(src);
        continue;
      }
      if (existsSync(dst) || isLink(dst)) continue;
      renameSync(src, dst);
    }
  };
  walk(from);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
