import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findVersions, gitBranchHead, gitTags, listingLinks, mapLimit, UpstreamError, withRetry } from '../src/upstream.ts';
import { makeGitRepo, serveListing } from './upstream-helpers.ts';

const noWait = [0, 0];

describe('git upstreams', () => {
  const repo = makeGitRepo(['v1.5.4', 'v1.6.0-rc1', 'v1.10.0', 'latest', 'debian/1.5'], { annotated: ['v1.10.0'], branches: ['stable'] });

  it('lists tag names without the ^{} lines of annotated tags', async () => {
    expect((await gitTags(repo.url)).sort()).toEqual(['debian/1.5', 'latest', 'v1.10.0', 'v1.5.4', 'v1.6.0-rc1']);
  });

  it('keeps only dotted-number versions, newest last', async () => {
    const pattern = /^v(.*)$/; // deliberately loose: rc and junk captures must still be dropped
    expect(await findVersions({ kind: 'git-tags', repo: repo.url, pattern }, 'x', noWait)).toEqual({ versions: ['1.5.4', '1.10.0'] });
  });

  it("reads a branch's head commit", async () => {
    expect(await gitBranchHead(repo.url, 'stable')).toBe(repo.head);
    expect(await findVersions({ kind: 'git-branch', repo: repo.url, branch: 'stable' }, 'x', noWait)).toEqual({ commit: repo.head });
  });

  it('names the library and the place when nothing matches', async () => {
    await expect(findVersions({ kind: 'git-tags', repo: repo.url, pattern: /^release-(\d+)$/ }, 'dav1d', noWait)).rejects.toThrow(
      `dav1d: no versions found at ${repo.url} matching ^release-(\\d+)$`,
    );
  });

  it('names the library and the place when the repo is unreachable', async () => {
    const missing = `${repo.url}-missing`;
    const run = findVersions({ kind: 'git-tags', repo: missing, pattern: /^v(.*)$/ }, 'srt', noWait);
    await expect(run).rejects.toThrow(UpstreamError);
    await expect(run).rejects.toThrow(`srt: couldn't read ${missing}: `);
  });

  it('never reads a repo URL as a git option', async () => {
    await expect(findVersions({ kind: 'git-tags', repo: '--upload-pack=echo', pattern: /^v(.*)$/ }, 'x', noWait)).rejects.toThrow("x: couldn't read --upload-pack=echo: ");
  });

  it('fails on a missing branch', async () => {
    await expect(findVersions({ kind: 'git-branch', repo: repo.url, branch: 'nope' }, 'x264', noWait)).rejects.toThrow(/x264: couldn't read .*no branch nope/);
  });
});

describe('listing pages', () => {
  let server: Awaited<ReturnType<typeof serveListing>>;
  beforeAll(async () => {
    server = await serveListing({
      '/gnu/': '<a href="gmp-6.2.1.tar.xz">gmp-6.2.1.tar.xz</a> <a href="gmp-6.3.0.tar.xz?x=1">x</a> <a href="gmp-6.3.0.tar.xz.sig">sig</a>',
      '/huge/': `<a href="1.0">${'x'.repeat(6 * 1024 * 1024)}</a>`,
      '/sf/': "<a href='/projects/lame/files/lame/3.100/'>3.100</a><a href=\"/projects/lame/files/lame/4.0/\">4.0</a><a href=\"/about\">about</a>",
    });
  });
  afterAll(() => server.close());

  it('reads the last path part of every link', async () => {
    expect(await listingLinks(`${server.url}/sf/`)).toEqual(['3.100', '4.0', 'about']);
  });

  it('finds versions in GNU-style and folder-style listings', async () => {
    expect(await findVersions({ kind: 'listing', url: `${server.url}/gnu/`, pattern: /^gmp-(\d+\.\d+\.\d+)\.tar\.xz$/ }, 'gmp', noWait)).toEqual({ versions: ['6.2.1', '6.3.0'] });
    expect(await findVersions({ kind: 'listing', url: `${server.url}/sf/`, pattern: /^(\d+\.\d+)$/ }, 'lame', noWait)).toEqual({ versions: ['3.100', '4.0'] });
  });

  it('refuses a listing page larger than 5 MB', async () => {
    await expect(listingLinks(`${server.url}/huge/`)).rejects.toThrow('page is larger than 5 MB');
  });

  it('names the page on an HTTP error', async () => {
    await expect(findVersions({ kind: 'listing', url: `${server.url}/gone/`, pattern: /(.*)/ }, 'lame', noWait)).rejects.toThrow(`lame: couldn't read ${server.url}/gone/: HTTP 404`);
  });
});

describe('retries and limits', () => {
  it('retries twice, then gives up', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error('blip'); }, noWait)).rejects.toThrow('blip');
    expect(calls).toBe(3);
    let tries = 0;
    expect(await withRetry(async () => (++tries < 3 ? Promise.reject(new Error('blip')) : 'ok'), noWait)).toBe('ok');
  });

  it('runs at most `limit` at a time and keeps the order', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (n === 3) throw new Error('three');
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([10, 20, 'x', 40, 50]);
  });
});

describe('tags with other separators', () => {
  it('reads versions written with _ or - (expat R_2_8_3, freetype VER-2-14-3) as dotted', async () => {
    const repo = makeGitRepo(['R_2_8_3', 'R_2_7_1', 'VER-2-14-3']);
    expect(await findVersions({ kind: 'git-tags', repo: repo.url, pattern: /^R_(\d+_\d+_\d+)$/ }, 'expat', noWait)).toEqual({ versions: ['2.7.1', '2.8.3'] });
    expect(await findVersions({ kind: 'git-tags', repo: repo.url, pattern: /^VER-(\d+-\d+-\d+)$/ }, 'freetype', noWait)).toEqual({ versions: ['2.14.3'] });
  });
});

describe('review fixes (recipes)', () => {
  it('only reads _ or - as separators when the version has no dots (1.2.3-1 is not 1.2.3.1)', async () => {
    const repo = makeGitRepo(['v1.2.3', 'v1.2.3-1']);
    expect(await findVersions({ kind: 'git-tags', repo: repo.url, pattern: /^v(\d+\.\d+\.\d+(?:-\d+)?)$/ }, 'x', noWait)).toEqual({ versions: ['1.2.3'] });
  });

  it("keeps libvpl's 2.x line, not the old oneVPL 2023.x tags", async () => {
    const { versionSource, loadEngineData } = await import('../src/engine-data.ts');
    const { packageRoot } = await import('../src/paths.ts');
    const source = versionSource(loadEngineData(packageRoot), 'libvpl');
    const repo = makeGitRepo(['v2.16.0', 'v2.17.0', 'v2023.4.0']);
    expect(await findVersions({ ...source, repo: repo.url } as typeof source, 'libvpl', noWait)).toEqual({ versions: ['2.16.0', '2.17.0'] });
  });
});
