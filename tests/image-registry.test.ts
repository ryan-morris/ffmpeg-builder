// Docker Hub limits anonymous pulls per address, and CI runners share addresses: a full run's builds get 429 Too Many
// Requests. Every image is pulled from a registry without that limit (Docker Hub's own images through mirror.gcr.io).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BINFMT } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

const registryOf = (image: string) => {
  const first = image.split('/')[0]!;
  return image.includes('/') && /[.:]/.test(first) ? first : 'docker.io';
};

describe('images', () => {
  it('come from registries without an anonymous pull limit', () => {
    const images = readdirSync(join(packageRoot, 'images')).flatMap((name) =>
      [...readFileSync(join(packageRoot, 'images', name, 'Dockerfile'), 'utf8').matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gm)].map((m) => `${name}: ${m[1]}`));
    const workflows = readdirSync(join(packageRoot, '.github', 'workflows')).flatMap((f) =>
      [...readFileSync(join(packageRoot, '.github', 'workflows', f), 'utf8').matchAll(/(\S+@sha256:[0-9a-f]{64})/g)].map((m) => `${f}: ${m[1]}`));
    const hub = [...images, ...workflows, `BINFMT: ${BINFMT}`].filter((x) => registryOf(x.split(': ')[1]!) === 'docker.io');
    expect(hub).toEqual([]);
  });
});
