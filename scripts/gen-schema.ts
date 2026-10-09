import { mkdirSync, writeFileSync } from 'node:fs';
import { folderJsonSchema } from '../src/schema/json-schema.ts';

mkdirSync(new URL('../schema/', import.meta.url), { recursive: true });
writeFileSync(new URL('../schema/ffmpeg-build.schema.json', import.meta.url), folderJsonSchema());
