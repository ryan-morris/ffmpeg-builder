// Step 6a's TypeScript side: licence files in recipe.yml and about.yml, the plan's legal data (governing texts,
// LICENSE-NOTICE.txt, patch sets, shipped files), and what build passes to the driver for SOURCE_OFFER.txt.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerRunArgs } from '../src/build/docker.ts';
import { GOVERNING_TEXTS, licenseNotice, makeBuildPlan, plannedPatches } from '../src/build/plan.ts';
import { publicRepoUrl, sourceIdentity } from '../src/commands/build.ts';
import { EngineDataError, loadEngineData } from '../src/engine-data.ts';
import type { LockedProfile } from '../src/lockfile.ts';
import { loadProfile, parseProfileText } from '../src/profile.ts';
import { packageRoot } from '../src/paths.ts';
import { planProfile } from '../src/resolve.ts';
import { parseFolderText, targetProfile } from '../src/targets.ts';
import { fixtureData, fixtureProfilesDir, writeEngine } from './helpers.ts';

const shipped = loadEngineData(packageRoot);
const folder = (() => {
  const r = parseFolderText(readFileSync(join(packageRoot, 'profiles', 'devenvy.yml'), 'utf8'), join(packageRoot, 'profiles'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.folder;
})();
/** A shipped target's one build, at the versions devenvy 9.0.2.3 shipped. */
const build = (name: string) => {
  const t = folder.targets.find((x) => x.name === name)!;
  return planProfile(targetProfile(folder, t), shipped, { '8': '8.1.3', '9': '9.0.2' }).cells[0]!;
};

function engineErrors(files: Record<string, string>): string[] {
  try {
    loadEngineData(writeEngine({ 'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions: {}\n', ...files }));
  } catch (e) {
    if (e instanceof EngineDataError) return e.errors;
    throw e;
  }
  return [];
}
const recipe = (files: string) => `name: a\nlicense: MIT\n${files}source: { git: https://example.com/a }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n`;

describe('license-files in recipe.yml', () => {
  it('is required, and every shipped recipe has it', () => {
    expect(engineErrors({ 'recipes/a/recipe.yml': recipe('license-files: []\n') })).toEqual(['recipes/a/recipe.yml: license-files: name at least one licence file']);
    for (const [name, r] of shipped.recipes) expect(r['license-files'].length, name).toBeGreaterThan(0);
  });

  it('takes paths in the source, or files kept beside recipe.yml', () => {
    const root = writeEngine({ 'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions: {}\n', 'recipes/a/recipe.yml': recipe('license-files: [COPYING, docs/FTL.TXT, { recipe: LICENSE }]\n'), 'recipes/a/LICENSE': 'MIT\n' });
    expect(loadEngineData(root).recipes.get('a')!['license-files']).toEqual([{ path: 'COPYING' }, { path: 'docs/FTL.TXT' }, { path: 'LICENSE', recipe: true }]);
    // header-only drops keep theirs beside the recipe
    expect(shipped.recipes.get('nv-codec')!['license-files']).toEqual([{ path: 'LICENSE', recipe: true }]);
    expect(shipped.recipes.get('libdrm')!['license-files']).toEqual([{ path: 'LICENSE', recipe: true }]);
  });

  it('needs a file beside recipe.yml to be there, and every path to stay inside its folder', () => {
    expect(engineErrors({ 'recipes/a/recipe.yml': recipe('license-files: [{ recipe: LICENSE }]\n') })).toEqual(['recipes/a/recipe.yml: license-files: recipes/a/LICENSE is missing']);
    for (const bad of ['../COPYING', '/COPYING', 'a/./b', 'a\\b']) {
      expect(engineErrors({ 'recipes/a/recipe.yml': recipe(`license-files: ["${bad.replace('\\', '\\\\')}"]\n`) })[0]).toMatch(/license-files\[0\]: expected a path in the source like COPYING/);
    }
  });
});

describe("the plan's legal data", () => {
  const dvr = (() => {
    const r = loadProfile(join(fixtureProfilesDir, 'dvr.yml'));
    if (!r.ok) throw new Error('dvr.yml');
    return r.profile;
  })();
  const data = fixtureData();
  const locked: LockedProfile = {
    ffmpeg: { '9': '9.1.0' },
    libraries: { dav1d: '1.5.4', libdrm: '2.4.134', libva: '2.24.1', mbedtls: '3.6.5', 'nv-codec': '13.0.19.1', opus: '1.6.1', srt: '1.5.8' },
    pinned: [],
  };
  const cell = planProfile(dvr, data, locked.ffmpeg).cells.find((c) => c.cell.platform === 'linux-x64')!;
  const plan = (release?: string) => makeBuildPlan({ profile: dvr, data, locked, cell, variant: 'dvr-linux', imageId: 'x', cacheDir: tmpdir(), ...(release ? { release } : {}) });

  it('names the governing texts as upstream picks them', () => {
    expect(GOVERNING_TEXTS).toEqual({
      gplv3: ['COPYING.GPLv3'], nonfree: ['COPYING.GPLv3'], gplv2: ['COPYING.GPLv2'],
      lgplv3: ['COPYING.LGPLv3', 'COPYING.GPLv3'], lgplv2: ['COPYING.LGPLv2.1', 'COPYING.GPLv2'],
    });
    expect(plan().legal).toMatchObject({ label: 'nonfree', governing: ['COPYING.GPLv3'] });
  });

  it("carries the target, licence, sources archive and (when given) the release, and each library's licence files", () => {
    expect(plan()).toMatchObject({ target: 'dvr-linux', license: 'nonfree', sourcesArchive: 'ffmpeg-9.1.0-sources.tar.gz' });
    expect(plan()).not.toHaveProperty('release');
    expect(plan('dvr-9.1.0.0').release).toBe('dvr-9.1.0.0');
    expect(plan().libraries.find((l) => l.name === 'dav1d')!.licenseFiles).toEqual([{ path: 'COPYING' }]);
    expect(plan().ships).toEqual([]);
  });

  it('reads the patch sets: their patches for the FFmpeg major, a hash of them, and their licence texts', () => {
    const [acme] = plan().patches;
    expect(acme).toEqual({ name: 'acme-muxer', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), files: [], licenses: [{ path: 'LICENSE', text: readFileSync(join(fixtureProfilesDir, 'patches', 'acme-muxer', 'LICENSE'), 'utf8') }] });
    const before = acme!.sha256;
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-patchset-'));
    execFileSync(process.execPath, ['-e', `require('fs').cpSync(${JSON.stringify(join(fixtureProfilesDir, 'patches'))}, ${JSON.stringify(join(dir, 'patches'))}, { recursive: true })`]);
    writeFileSync(join(dir, 'patches', 'acme-muxer', '9', '0001-more.patch'), 'diff\n');
    const more = plannedPatches({ ...dvr, dir }, '9')[0]!;
    expect(more.sha256).not.toBe(before);
    // the patches themselves travel in the plan, in name order (the README beside them doesn't)
    expect(more.files).toEqual([{ name: '0001-more.patch', text: 'diff\n' }]);
  });

  it('lists the notice of what a platform ships', () => {
    const android = build('android-arm64-lgplv3');
    expect(makeBuildPlan({ profile: targetProfile(folder, folder.targets.find((t) => t.name === 'android-arm64-lgplv3')!), data: shipped, locked: { ffmpeg: { '9': '9.0.2' }, libraries: Object.fromEntries(android.recipes.map((r) => [r, '1.0'])), pinned: [] }, cell: android, variant: 'android-arm64-lgplv3', imageId: 'x', cacheDir: tmpdir() }).ships)
      .toEqual([{ file: 'libc++_shared.so', notice: '${TOOLCHAIN}/NOTICE' }]);
  });
});

describe('LICENSE-NOTICE.txt', () => {
  it('says why a v3 build is v3: the libraries the v2 licence would not allow, and its TLS', () => {
    const text = licenseNotice(shipped, build('linux-x64-lgplv3'), 'linux-x64-lgplv3');
    expect(text).toContain('FFmpeg 9.0.2 — linux-x64 (linux-x64-lgplv3)');
    expect(text).toContain('EFFECTIVE LICENSE:  LGPLv3 (GNU Lesser General Public License, version 3)');
    expect(text).toContain('Governing license text: COPYING.LGPLv3 (plus COPYING.GPLv3, which it extends)');
    for (const part of ['openssl (Apache-2.0)', 'vulkan-loader (Apache-2.0)', 'opencore-amr (Apache-2.0)', 'vo-amrwbenc (Apache-2.0)']) expect(text).toContain(`  ${part}\n`);
    expect(text).not.toContain('  dav1d');
    expect(text).toContain('TLS is openssl (Apache-2.0).');
    expect(text).toContain('Corresponding source: see SOURCE_OFFER.txt in this directory.');
  });

  it('names the TLS member of a v2 build, the OS backend on Windows, or none', () => {
    const gplv2 = licenseNotice(shipped, build('linux-x64-gplv2'), 'linux-x64-gplv2');
    expect(gplv2).toContain('EFFECTIVE LICENSE:  GPLv2 (GNU General Public License, version 2)');
    expect(gplv2).toContain("This is a version 2 build: it doesn't use --enable-version3");
    expect(gplv2).toMatch(/TLS is gnutls \(LGPL-2\.1-or-later[^)]*\)\./);
    expect(licenseNotice(shipped, build('win-x64-gplv2'), 'win-x64-gplv2')).toContain("TLS is the operating system's schannel backend, which bundles no library.");
    const lgplv2 = licenseNotice(shipped, build('linux-x64-lgplv2'), 'linux-x64-lgplv2');
    expect(lgplv2).toContain('Governing license text: COPYING.LGPLv2.1 (plus COPYING.GPLv2, which it extends)');
    expect(lgplv2).toContain('This build has no TLS: no TLS library LGPLv2.1 allows is available for linux-x64.');
  });

  it('says a nonfree build may not be redistributed, and what makes it nonfree', () => {
    const data = fixtureData();
    const r = loadProfile(join(fixtureProfilesDir, 'dvr.yml'));
    if (!r.ok) throw new Error('dvr.yml');
    const cell = planProfile(r.profile, data, { '9': '9.1.0' }).cells.find((c) => c.cell.platform === 'linux-x64')!;
    const text = licenseNotice(data, cell, 'dvr');
    expect(text).toContain('EFFECTIVE LICENSE:  nonfree (not redistributable: configured with --enable-nonfree)');
    expect(text).toContain("Governing license text: COPYING.GPLv3, for FFmpeg's own code");
    expect(text).toContain('This build is NOT REDISTRIBUTABLE. It uses --enable-nonfree: it combines FFmpeg with code whose licence is\nincompatible with the GPL, so it may not be distributed to anyone. It is for internal use only.\n');
    // no version paragraph: nonfree is neither v3 nor v2
    expect(text).not.toMatch(/version3|version 3|version 2/);
  });

  it('names what makes a nonfree build nonfree', () => {
    const data = loadEngineData(writeEngine({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  libfdk-aac: { needs: fdk-aac, ffmpeg-license: nonfree }\n  dav1d: { needs: dav1d }\n',
      'licenses.yml': 'licenses:\n  BSD-2-Clause: all\n  FDK-AAC: [nonfree]\n',
      'recipes/fdk-aac/recipe.yml': "name: fdk-aac\nlicense: FDK-AAC\nsource: { git: https://example.com/fdk }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n",
      'recipes/dav1d/recipe.yml': "name: dav1d\nlicense: BSD-2-Clause\nsource: { git: https://example.com/dav1d }\nversions: { git-tags: '^(.*)$' }\nplatforms: all\n",
    }));
    const p = parseProfileText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: nonfree\nwith: [libfdk-aac, dav1d]\n', 't.yml');
    if (!p.ok) throw new Error(p.errors.join('\n'));
    const text = licenseNotice(data, planProfile(p.profile, data, { '9': '9.0.0' }).cells[0]!, 't');
    expect(text).toContain('The libraries that make it nonfree:\n  fdk-aac (FDK-AAC)\n');
    expect(text).not.toContain('dav1d (');
    expect(text).not.toContain('compatible with version 3');
  });

  it('says a build that could have had TLS has none, without claiming none is allowed', () => {
    const t = folder.targets.find((x) => x.name === 'linux-x64-lgplv3')!;
    const profile = { ...targetProfile(folder, t), with: targetProfile(folder, t).with.filter((w) => w.name !== 'openssl') };
    const cell = planProfile(profile, shipped, { '9': '9.0.2' }).cells[0]!;
    expect(cell.groups.tls).toBeUndefined();
    expect(licenseNotice(shipped, cell, 't')).toContain('\nThis build has no TLS library.\n');
  });
});

describe('the source repository SOURCE_OFFER.txt names', () => {
  it('is passed into the container', () => {
    const args = dockerRunArgs({ tag: 'img:1', recipes: 'r', engine: 'e', cache: 'c', out: 'o', plan: 'p', env: { FFMPEG_BUILD_SOURCE_REPO: 'https://example.com/r', FFMPEG_BUILD_SOURCE_REF: 'abc' } });
    expect(args.slice(0, 7)).toEqual(['run', '--rm', '--init', '-e', 'FFMPEG_BUILD_SOURCE_REPO=https://example.com/r', '-e', 'FFMPEG_BUILD_SOURCE_REF=abc']);
  });

  it('comes from FFMPEG_BUILD_SOURCE_REPO / _REF, else the folder\'s git remote and HEAD, without credentials', () => {
    expect(sourceIdentity(tmpdir(), { FFMPEG_BUILD_SOURCE_REPO: 'https://example.com/r', FFMPEG_BUILD_SOURCE_REF: 'abc' })).toEqual({ FFMPEG_BUILD_SOURCE_REPO: 'https://example.com/r', FFMPEG_BUILD_SOURCE_REF: 'abc' });
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-repo-'));
    expect(sourceIdentity(dir, {})).toEqual({}); // not a checkout: the offer's fallback wording
    const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    g('init', '-q');
    g('remote', 'add', 'origin', 'https://bot:s3cret@github.com/acme/media.git');
    writeFileSync(join(dir, 'ffmpeg-build.yml'), 'targets: {}\n');
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
    expect(sourceIdentity(dir, {})).toEqual({ FFMPEG_BUILD_SOURCE_REPO: 'https://github.com/acme/media', FFMPEG_BUILD_SOURCE_REF: g('rev-parse', 'HEAD') });
    // a change to a tracked file marks the commit -dirty; the build's own untracked output doesn't
    writeFileSync(join(dir, 'dist.tar.gz'), 'x');
    expect(sourceIdentity(dir, {}).FFMPEG_BUILD_SOURCE_REF).toBe(g('rev-parse', 'HEAD'));
    writeFileSync(join(dir, 'ffmpeg-build.yml'), 'targets: { a: { platform: linux-x64, license: lgplv3, ffmpeg: "9" } }\n');
    expect(sourceIdentity(dir, {}).FFMPEG_BUILD_SOURCE_REF).toBe(`${g('rev-parse', 'HEAD')}-dirty`);
    // a remote that is a folder on this machine is no repository a reader can open: the fallback wording
    g('remote', 'set-url', 'origin', dir);
    expect(sourceIdentity(dir, {})).not.toHaveProperty('FFMPEG_BUILD_SOURCE_REPO');
    g('remote', 'set-url', 'origin', 'file:///srv/git/media.git');
    expect(sourceIdentity(dir, {})).not.toHaveProperty('FFMPEG_BUILD_SOURCE_REPO');
    expect(publicRepoUrl('git@github.com:acme/media.git')).toBe('https://github.com/acme/media');
    expect(publicRepoUrl('ssh://git@example.com/acme/media.git')).toBe('ssh://example.com/acme/media');
  });
});
