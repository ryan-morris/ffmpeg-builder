// update.yml and fetch-update.yml label their PR before starting its CI: the automerge job at the end of that CI
// merges only a labelled PR, so a label added after a quick CI run finished would leave the PR open.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRoot } from '../src/paths.ts';

describe('automerge', () => {
  for (const file of ['update.yml', 'fetch-update.yml']) {
    it(`${file} labels the PR before it starts the PR's CI`, () => {
      const text = readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8');
      const label = text.indexOf('--add-label');
      const dispatch = text.indexOf('gh workflow run');
      expect(label).toBeGreaterThan(-1);
      expect(dispatch).toBeGreaterThan(-1);
      expect(label).toBeLessThan(dispatch);
    });
  }
});
