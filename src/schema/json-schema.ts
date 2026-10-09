import { z } from 'zod';
import { folderSchema } from './targets.ts';

/** The JSON Schema editors use to autocomplete and check ffmpeg-build.yml, generated from the CLI's own zod schema. */
export function folderJsonSchema(): string {
  const schema = allowNumbers(z.toJSONSchema(folderSchema, { io: 'input' }));
  const doc = { ...schema, title: 'ffmpeg-build.yml' };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Editors read YAML with the usual rules, so `ffmpeg: 9` and `nvenc: 13.0` reach the schema as
 * numbers, while the CLI reads every value as text. Free-text fields therefore also accept numbers;
 * fields with a fixed spelling (enums, patterns like `name`) stay text-only.
 */
function allowNumbers<T>(node: T): T {
  if (Array.isArray(node)) return node.map(allowNumbers) as T;
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = allowNumbers(value);
  if (out.type === 'string' && !('enum' in out) && !('pattern' in out)) out.type = ['string', 'number'];
  // a yes/no switch: editors read `true` as a boolean
  if (out.type === 'string' && JSON.stringify(out.enum) === '["true","false"]') {
    out.type = ['string', 'boolean'];
    out.enum = ['true', 'false', true, false];
  }
  return out as T;
}
