// Hashes of files and folders that are the same on every machine: what release planning compares, and what a build
// records for its patch sets (the two must agree, or bundle refuses the build).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const sha = (...parts: (string | Buffer)[]) => {
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
