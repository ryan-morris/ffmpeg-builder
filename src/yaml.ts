import { LineCounter, parseDocument } from 'yaml';

export class YamlError extends Error {
  readonly file: string;
  readonly line: number | undefined;
  readonly reason: string;

  constructor(file: string, line: number | undefined, reason: string) {
    super(line === undefined ? `${file}: ${reason}` : `${file}:${line}: ${reason}`);
    this.file = file;
    this.line = line;
    this.reason = reason;
  }
}

/**
 * Parse YAML keeping every scalar a string (the failsafe schema): `ffmpeg: 9.10` is "9.10",
 * never the number 9.1. Callers validate the shape with zod.
 */
export function parseYaml(text: string, file: string): unknown {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { schema: 'failsafe', lineCounter, prettyErrors: false, uniqueKeys: true });
  const error = doc.errors[0];
  if (error) {
    const reason = error.message.split('\n')[0]!.replace(/ at line \d+, column \d+:?$/, '');
    throw new YamlError(file, lineCounter.linePos(error.pos[0]).line, reason);
  }
  return doc.toJS() ?? null;
}
