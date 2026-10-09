import { z } from 'zod';

export const text = z.string({ error: 'expected text' }).min(1, { error: 'must not be empty' });
export const name = z.string({ error: 'expected a name' }).regex(/^[a-z0-9][a-z0-9._+-]*$/, {
  error: 'expected a lowercase name like x265 or whisper.cpp',
});
export const version = z.string({ error: 'expected a version' }).regex(/^\d+(\.\d+)*$/, { error: 'expected a version like 9.0.2' });
export const flag = z.enum(['true', 'false'], { error: 'expected true or false' }).transform((v) => v === 'true');

/** One value or a list of them; always a list after parsing. */
export function oneOrMany<T extends z.ZodType>(item: T, error: string) {
  return z.union([item, z.array(item).min(1)], { error }).transform((v) => (Array.isArray(v) ? v : [v]) as z.output<T>[]);
}

const KIND: Record<string, string> = { array: 'a list', object: 'keys and values', string: 'text', record: 'keys and values' };

/**
 * zod issues as plain "path: message" lines, e.g. "with[0].whisper.ffmpeg: expected ...". zod's own
 * wording ("Unrecognized key", "Invalid input: expected array, received object") never reaches users.
 * `keyHints` adds the allowed keys to an unknown-key message, by path ('' is the top level).
 */
export function formatIssues(error: z.ZodError, keyHints: Record<string, string> = {}): string[] {
  return error.issues.flatMap((issue) => {
    const where = issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '');
    const at = (message: string) => (where ? `${where}: ${message}` : message);
    if (issue.code === 'unrecognized_keys') {
      const hint = keyHints[where];
      return issue.keys.map((key) => at(`unknown key "${key}"${hint ? ` (${hint})` : ''}`));
    }
    if (issue.code === 'invalid_type' && issue.message.startsWith('Invalid input')) {
      return [at(`expected ${KIND[issue.expected] ?? issue.expected}`)];
    }
    return [at(issue.message)];
  });
}
