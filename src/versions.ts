const VERSION = /^\d+(\.\d+)*$/;
const NUMBER = '(?:0|[1-9]\\d*)'; // no leading zeros: "09" and "9.00" are typos, not new versions
const CONDITION = new RegExp(`^(>=|<=|>|<|=)?\\s*(${NUMBER}(?:\\.${NUMBER})*)$`);
const SERIES = new RegExp(`^${NUMBER}(?:\\.${NUMBER})?$`);

export function isVersion(text: string): boolean {
  return VERSION.test(text);
}

function parts(version: string): number[] {
  if (!isVersion(version)) throw new Error(`not a version: ${version}`);
  return version.split('.').map(Number);
}

/** Compare dotted numbers: 9.10 > 9.9, and 9.0 == 9.0.0. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Compare `version` with a series ("8", "9.0") using only as many parts as the series has. */
function compareToSeries(version: string, series: string): number {
  return compareVersions(parts(version).slice(0, parts(series).length).join('.'), series);
}

export function inSeries(version: string, series: string): boolean {
  return compareToSeries(version, series) === 0;
}

/** What a profile's `ffmpeg:` may hold: a major ("9"), a minor ("9.0"), or "latest". */
export function isFfmpegSeries(text: string): boolean {
  return text === 'latest' || SERIES.test(text);
}

export function isVersionCondition(text: string): boolean {
  return CONDITION.test(text.trim());
}

/**
 * ">=8", "9.0", "<9.1". Series-aware: ">8" means 9 and above (not 8.1), "<=8" includes 8.1.3,
 * and a bare "9.0" means any 9.0.x.
 */
export function matchesVersionCondition(version: string, condition: string): boolean {
  const m = CONDITION.exec(condition.trim());
  if (!m) throw new Error(`not a version condition: ${condition}`);
  const c = compareToSeries(version, m[2]!);
  switch (m[1] ?? '=') {
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '<': return c < 0;
    default: return c === 0;
  }
}
