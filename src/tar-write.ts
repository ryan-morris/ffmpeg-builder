// Writes a .tar.gz without a system tar: ustar headers, a pax record for a path longer than ustar holds, files
// streamed through gzip. Entries are written in the order given, with a fixed mtime, so the same input gives the same
// archive.
import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';

export type TarEntry = { path: string; file: string } | { path: string; text: string };

const MTIME = 0o14000000000; // 2014-12-03, any fixed date: the archive doesn't depend on when it was made

function header(name: string, size: number, mode: number, type: '0' | 'x'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 100);
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${MTIME.toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

/** A pax record "<len> path=<value>\n", where <len> counts itself. */
function paxPath(path: string): Buffer {
  const body = ` path=${path}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len = Buffer.byteLength(`${len}${body}`);
  return Buffer.from(`${len}${body}`);
}

/** Writes `entries` (regular files) to `out` as a gzipped tar. */
export async function writeTarGz(out: string, entries: TarEntry[]): Promise<void> {
  const gz = createGzip({ level: 9 });
  const done = new Promise<void>((resolve, reject) => {
    const sink = createWriteStream(out);
    sink.on('finish', resolve).on('error', reject);
    gz.on('error', reject).pipe(sink);
  });
  const write = (b: Buffer) => new Promise<void>((resolve) => (gz.write(b) ? resolve() : gz.once('drain', resolve)));
  for (const e of entries) {
    const data = 'file' in e ? readFileSync(e.file) : Buffer.from(e.text);
    const mode = 'file' in e && statSync(e.file).mode & 0o111 ? 0o755 : 0o644;
    if (Buffer.byteLength(e.path) > 100) {
      const pax = paxPath(e.path);
      await write(Buffer.concat([header('PaxHeader', pax.length, 0o644, 'x'), pax, pad(pax.length)]));
    }
    await write(Buffer.concat([header(e.path, data.length, mode, '0'), data, pad(data.length)]));
  }
  gz.end(Buffer.alloc(1024));
  await done;
}
