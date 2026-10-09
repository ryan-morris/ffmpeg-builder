import { z } from 'zod';
import { LICENSES, type License } from './schema/profile.ts';

/** SPDX licence id -> the profile licenses a library under it may be linked into (licenses.yml). */
export type LicenseTable = Map<string, License[]>;

const license = z.enum(LICENSES, { error: `expected one of ${LICENSES.join(', ')}` });
export const licenseTableSchema = z.strictObject({
  licenses: z.record(
    z.string().min(1),
    z.union([z.literal('all'), z.array(license).min(1)], { error: 'expected all, or a list of profile licenses' }),
  ),
});

export function tableFrom(raw: z.output<typeof licenseTableSchema>): LicenseTable {
  return new Map(Object.entries(raw.licenses).map(([id, v]) => [id, v === 'all' ? [...LICENSES] : v]));
}

export type Verdict = { allowed: License[] } | { unknown: string[] } | { invalid: string };

/**
 * The profile licenses an SPDX expression allows: OR is either side's builds, AND only builds both sides allow,
 * `X WITH exception` is that entry of the table when it has one, else X. Unknown licence ids and unreadable expressions are reported, not guessed.
 */
export function allowedBy(expression: string, table: LicenseTable): Verdict {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const unknown: string[] = [];
  const atom = (): Set<License> => {
    const t = tokens[i++];
    if (t === undefined || t === ')' || t === 'AND' || t === 'OR' || t === 'WITH') throw new Error('invalid');
    if (t === '(') {
      const inner = or();
      if (tokens[i++] !== ')') throw new Error('invalid');
      return inner;
    }
    let id = t;
    if (tokens[i] === 'WITH') {
      const exception = tokens[i + 1];
      if (exception === undefined) throw new Error('invalid');
      i += 2;
      // an exception the table names is its own entry (LLVM's makes Apache-2.0 GPLv2-compatible); otherwise it
      // doesn't change where the licence may go
      if (table.has(`${t} WITH ${exception}`)) id = `${t} WITH ${exception}`;
    }
    const allowed = table.get(id);
    if (!allowed) unknown.push(id);
    return new Set(allowed ?? []);
  };
  const and = (): Set<License> => {
    let set = atom();
    while (tokens[i] === 'AND') {
      i++;
      const next = atom();
      set = new Set([...set].filter((l) => next.has(l)));
    }
    return set;
  };
  const or = (): Set<License> => {
    let set = and();
    while (tokens[i] === 'OR') {
      i++;
      set = new Set([...set, ...and()]);
    }
    return set;
  };
  try {
    const result = or();
    if (i !== tokens.length) throw new Error('invalid');
    return unknown.length ? { unknown } : { allowed: LICENSES.filter((l) => result.has(l)) };
  } catch {
    return { invalid: expression };
  }
}
