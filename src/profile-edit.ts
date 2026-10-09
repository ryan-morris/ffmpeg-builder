// The text-splicing edits behind the `profile` commands: an edit splices ffmpeg-build.yml's own text at the YAML nodes'
// source ranges, so only the lines it adds or removes change; comments and layout everywhere else stay byte-for-byte.
// Every edit is checked before it is written (the result must still be a valid folder file).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDocument, type Document, type Node } from 'yaml';
import { parseFolderText } from './targets.ts';

export class EditError extends Error {}

export function documentOf(text: string): Document {
  const doc = parseDocument(text, { schema: 'failsafe' });
  if (doc.errors.length) throw new EditError(`can't edit this file: it isn't valid YAML (${doc.errors[0]!.message.split('\n')[0]})`);
  return doc;
}

/** Reads `file`, edits its text, and writes it back only when the result is still a valid folder file. */
export function editFile(file: string, edit: (text: string) => string): string {
  const before = readFileSync(file, 'utf8');
  const after = edit(before);
  const check = parseFolderText(after, dirname(resolve(file)));
  if (!check.ok) throw new EditError(`not saved: the edited file would have problems:\n${check.errors.map((e) => `  ${e}`).join('\n')}`);
  if (after !== before) writeFileSync(file, after);
  return after;
}

// ---- text splicing ---------------------------------------------------------------------------------------------

export interface Splice { from: number; to: number; text: string }

export function applySplices(text: string, splices: Splice[]): string {
  let out = text;
  for (const sp of [...splices].sort((x, y) => y.from - x.from || y.to - x.to)) out = out.slice(0, sp.from) + sp.text + out.slice(sp.to);
  return out;
}

export const range = (n: unknown): [number, number, number] => (n as Node).range!;
export const lineStart = (text: string, i: number) => text.lastIndexOf('\n', i - 1) + 1;
/** Just past the newline ending the line that holds `i` (or the end of the text). */
export const lineEnd = (text: string, i: number) => {
  const n = text.indexOf('\n', i);
  return n === -1 ? text.length : n + 1;
};
/** The whole lines a block-list item takes, its trailing comment included. */
export const itemLines = (text: string, item: unknown): Splice => ({ from: lineStart(text, range(item)[0]), to: lineEnd(text, range(item)[1] - 1), text: '' });

const plainValue = (v: string) => (/^[A-Za-z0-9][A-Za-z0-9_.*+-]*$/.test(v) ? v : JSON.stringify(v));
export const flowList = (values: readonly string[]) => `[${values.map(plainValue).join(', ')}]`;
