import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root: the folder holding package.json, ffmpeg/, recipes/ (works from src/ and dist/). */
export const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Where ffmpeg/ and recipes/ are read from. FFMPEG_BUILD_DATA overrides it (tests, engine development). */
export function dataRoot(): string {
  return process.env.FFMPEG_BUILD_DATA ?? packageRoot;
}

export function packageVersion(): string {
  return (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;
}
