// manifest.yml: published with every release under that exact name. `fetch` reads it; `bundle` writes it.
import { stringify } from 'yaml';
import { z } from 'zod';
import { parseYaml, YamlError } from './yaml.ts';

const asset = z.strictObject({ name: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256') });
const target = z.strictObject({
  name: z.string(),
  platform: z.string(),
  license: z.string(),
  redistributable: z.enum(['true', 'false']),
  assets: z.strictObject({ runtime: asset, dev: asset }),
  toolchain: z.string(),
  components: z.record(z.string(), z.string()).default({}),
  patches: z.array(z.strictObject({ name: z.string(), sha256: z.string() })).default([]),
  'not-included': z.array(z.string()).default([]),
  definition: z.string(),
});
const manifestSchema = z.strictObject({
  release: z.string(),
  ffmpeg: z.string(),
  build: z.string().regex(/^\d+$/),
  engine: z.string(),
  group: z.string().optional(),
  targets: z.array(target).min(1),
  sources: asset,
});

export type Manifest = z.output<typeof manifestSchema>;
export type ManifestTarget = Manifest['targets'][number];
export const MANIFEST_FILE = 'manifest.yml';

export class ManifestError extends Error {}

export function parseManifest(text: string, file = MANIFEST_FILE): Manifest {
  let raw: unknown;
  try {
    raw = parseYaml(text, file);
  } catch (e) {
    if (e instanceof YamlError) throw new ManifestError(`${file}: not a manifest (${e.reason})`);
    throw e;
  }
  const r = manifestSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new ManifestError(`${file}: not a manifest (${issue.path.join('.') || 'top level'}: ${issue.message})`);
  }
  return r.data;
}

export function formatManifest(m: Manifest): string {
  const header = '# Published with every release under this name: `ffmpeg-build fetch` reads it. Checksums are sha256.\n';
  return header + stringify(m, { lineWidth: 0 });
}
