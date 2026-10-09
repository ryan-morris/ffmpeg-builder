import { compareVersions, inSeries, isVersion } from './versions.ts';

// One comparator: an optional operator glued to a dotted-number version.
const COMPARATOR = /^(>=|<=|>|<|=|~|\^)?(\d+(?:\.\d+)*)$/;

/** Compare only as many parts as `target` has, so `>1.2` means "above every 1.2.x". */
function seriesCompare(version: string, target: string): number {
  return compareVersions(version.split('.').slice(0, target.split('.').length).join('.'), target);
}

function comparatorMatches(version: string, comparator: string): boolean {
  const [, op = '', target = ''] = COMPARATOR.exec(comparator)!;
  const parts = target.split('.');
  switch (op) {
    case '~':
      return compareVersions(version, target) >= 0 && inSeries(version, parts.slice(0, Math.min(parts.length, 2)).join('.'));
    case '^': {
      const firstNonZero = parts.findIndex((p) => Number(p) !== 0);
      const keep = firstNonZero === -1 ? parts.length : firstNonZero + 1;
      return compareVersions(version, target) >= 0 && inSeries(version, parts.slice(0, keep).join('.'));
    }
    case '>=': return seriesCompare(version, target) >= 0;
    case '>': return seriesCompare(version, target) > 0;
    case '<=': return seriesCompare(version, target) <= 0;
    case '<': return seriesCompare(version, target) < 0;
    default: return seriesCompare(version, target) === 0;
  }
}

/** `a || b` → [[a], [b]]; `>=3.6 <4` → [['>=3.6', '<4']]. */
function alternatives(range: string): string[][] {
  return range.split('||').map((set) => set.trim().split(/\s+/).filter(Boolean));
}

/** npm's range syntax over dotted numbers of any length: 4.3, 4.3.1, ~1.5.4, ^1.5.4, ">=3.6 <4", "4.3 || 4.5". */
export function isRange(text: string): boolean {
  return alternatives(text).every((set) => set.length > 0 && set.every((c) => COMPARATOR.test(c)));
}

export function satisfies(version: string, range: string): boolean {
  if (!isVersion(version) || !isRange(range)) return false;
  return alternatives(range).some((set) => set.every((c) => comparatorMatches(version, c)));
}

/** A full git commit hash, as `git ls-remote` prints it. */
export function isCommit(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}
