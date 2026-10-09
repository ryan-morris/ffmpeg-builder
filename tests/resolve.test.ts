import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfile, parseProfileText, type Profile } from '../src/profile.ts';
import { availability, cellBuildOrder, conditionMatches, planProfile, resolveCell, variantsOf, type Cell } from '../src/resolve.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { fixtureData, fixtureProfilesDir, writeEngine } from './helpers.ts';

const data = fixtureData();
function profile(text: string): Profile {
  const r = parseProfileText(text, 't.yml');
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.profile;
}
function fixture(name: string): Profile {
  const r = loadProfile(join(fixtureProfilesDir, name));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.profile;
}
const cell = (over: Partial<Cell> = {}): Cell => ({ series: '9', major: '9', version: '9.1.0', license: 'gplv3', platform: 'linux-x64', ...over });
const base = 'name: t\nplatforms: all\n';

describe('variants', () => {
  it('picks the newest release in each series, times each license', () => {
    const { variants, errors } = variantsOf(profile(`${base}ffmpeg: [8, "9.0"]\nlicense: [lgplv3, gplv2]\n`), data);
    expect(errors).toEqual([]);
    expect(variants).toEqual([
      { series: '8', major: '8', version: '8.1.3', license: 'lgplv3' },
      { series: '8', major: '8', version: '8.1.3', license: 'gplv2' },
      { series: '9.0', major: '9', version: '9.0.2', license: 'lgplv3' },
      { series: '9.0', major: '9', version: '9.0.2', license: 'gplv2' },
    ]);
  });

  it('maps latest to the newest major the engine knows', () => {
    expect(variantsOf(profile(`${base}ffmpeg: latest\nlicense: gplv3\n`), data).variants[0]).toMatchObject({ series: 'latest', major: '9', version: '9.1.0' });
  });

  it('says which FFmpeg majors it knows', () => {
    expect(variantsOf(profile(`${base}ffmpeg: [4, 9.7]\nlicense: gplv3\n`), data).errors).toEqual([
      'ffmpeg: 4: ffmpeg-build has no data for FFmpeg 4 (it knows 8, 9)',
      'ffmpeg: 9.7: no FFmpeg 9.7 release is known yet',
    ]);
  });
});

describe('conditions', () => {
  it('ANDs keys and ORs values', () => {
    const c = cell({ version: '8.1.3', series: '8', major: '8', platform: 'win-x64' });
    expect(conditionMatches(undefined, c)).toBe(true);
    expect(conditionMatches({ ffmpeg: ['>=8'], platforms: ['linux-x64', 'win-*'] }, c)).toBe(true);
    expect(conditionMatches({ ffmpeg: ['>=9'], platforms: ['win-*'] }, c)).toBe(false);
    expect(conditionMatches({ license: ['lgplv3', 'gplv3'] }, c)).toBe(true);
    expect(conditionMatches({ license: ['nonfree'] }, c)).toBe(false);
  });
});

describe('availability', () => {
  it('explains why something is missing', () => {
    expect(availability(data, cell(), 'x265')).toBeUndefined();
    expect(availability(data, cell({ license: 'lgplv3' }), 'x265')).toEqual({ kind: 'license', reason: "x265 is GPL-only (FFmpeg's own classification)" });
    expect(availability(data, cell({ license: 'gplv3' }), 'fdk-aac')).toEqual({ kind: 'license', reason: "fdk-aac is nonfree-only: it needs license: nonfree (FFmpeg's own classification)" });
    expect(availability(data, cell({ series: '9.0', version: '9.0.2' }), 'whep')).toEqual({ kind: 'ffmpeg', reason: 'FFmpeg added whep in 9.1.0' });
    expect(availability(data, cell({ series: '8', major: '8', version: '8.1.3' }), 'whep')).toEqual({ kind: 'ffmpeg', reason: 'FFmpeg added whep in 9.1.0' });
    expect(availability(data, cell({ platform: 'osx-arm64' }), 'nvenc')).toEqual({ kind: 'platform', reason: "FFmpeg doesn't support nvenc there" });
    expect(availability(data, cell({ platform: 'win-arm64' }), 'nvenc')).toEqual({ kind: 'platform', reason: "the nv-codec recipe doesn't build there" });
    expect(availability(data, cell({ platform: 'android-arm64' }), 'vaapi')).toEqual({ kind: 'platform', reason: "the libva recipe doesn't build there" });
  });
});

describe('resolveCell', () => {
  it('builds exactly what dvr asks for, libraries dependencies-first', () => {
    const plan = resolveCell(fixture('dvr.yml'), data, cell({ license: 'nonfree' }));
    expect(plan.options).toEqual(['dav1d', 'nvenc', 'opus', 'srt', 'vaapi']);
    expect(plan.recipes).toEqual(['dav1d', 'libdrm', 'libva', 'nv-codec', 'opus', 'mbedtls', 'srt']);
    expect(plan.groups).toEqual({ tls: undefined });
    expect(plan.withResults.map((r) => r.option)).toEqual(['nvenc', 'vaapi', 'srt', 'dav1d', 'opus']);
    expect(plan.pins).toEqual({ 'nv-codec': '13.0' });
  });

  it('applies pins per build: first matching entry wins, only for libraries in the build', () => {
    const p = fixture('playback.yml');
    expect(resolveCell(p, data, cell({ license: 'nonfree', platform: 'win-arm64' })).pins).toEqual({ dav1d: '1.5' }); // no nvenc on win-arm64
    expect(resolveCell(p, data, cell({ license: 'nonfree' })).pins).toEqual({ 'nv-codec': '13.0' });
    const ordered = profile(`${base}ffmpeg: 9\nlicense: gplv3\nwith: [dav1d]\npin:\n  - dav1d: { version: "1.4", platforms: [linux-*] }\n  - dav1d: "1.5"\n`);
    expect(resolveCell(ordered, data, cell()).pins).toEqual({ dav1d: '1.4' });
    expect(resolveCell(ordered, data, cell({ platform: 'win-x64' })).pins).toEqual({ dav1d: '1.5' });
  });

  it('keeps the TLS the profile lists, per platform', () => {
    const p = fixture('playback.yml');
    const pick = (platform: string) => resolveCell(p, data, cell({ license: 'nonfree', platform })).groups.tls;
    expect(pick('linux-x64')).toBe('openssl');
    expect(pick('win-x64')).toBe('schannel');
    expect(pick('osx-arm64')).toBe('securetransport');
    expect(pick('maccatalyst-arm64')).toBe('openssl');
    const linux = resolveCell(p, data, cell({ license: 'nonfree' }));
    expect(linux.options).toContain('openssl');
    expect(linux.options).not.toContain('gnutls');
    expect(linux.options).not.toContain('fdk-aac'); // not listed, so not built
  });

  it('builds nothing that is not listed, and lets without remove a listed one', () => {
    expect(resolveCell(profile(`${base}ffmpeg: 9\nlicense: gplv3\nwith: [dav1d]\n`), data, cell()).options).toEqual(['dav1d']);
    const removed = resolveCell(profile(`${base}ffmpeg: 9\nlicense: gplv3\nwith: [gnutls, dav1d]\nwithout: [gnutls]\n`), data, cell());
    expect(removed.options).toEqual(['dav1d']);
    expect(removed.removed).toEqual(['gnutls']);
    expect(removed.groups.tls).toBeUndefined();
  });

  it('keeps both members of one group in a build, and reports the conflict', () => {
    const plan = resolveCell(profile(`${base}ffmpeg: 9\nlicense: gplv3\nwith: [openssl, gnutls]\n`), data, cell());
    expect(plan.conflicts).toEqual([{ group: 'tls', message: 'gnutls and openssl are both in this build, but FFmpeg uses one tls per build' }]);
    expect(plan.groups.tls).toBeUndefined();
  });

  it('applies `with` only where its condition matches', () => {
    const p = profile(`${base}ffmpeg: [8, 9]\nlicense: gplv3\nwith:\n  - whisper: { ffmpeg: ">=9" }\n`);
    const plan = planProfile(p, data);
    const whisperOn = (series: string) => plan.cells.filter((c) => c.cell.series === series && c.options.includes('whisper')).length;
    expect(whisperOn('8')).toBe(0);
    expect(whisperOn('9')).toBe(15);
  });

  it('records `with` entries that are not available instead of selecting them', () => {
    const plan = resolveCell(profile(`${base}ffmpeg: 9\nlicense: lgplv3\nwith: [x265]\n`), data, cell({ license: 'lgplv3' }));
    expect(plan.options).toEqual([]);
    expect(plan.withResults).toEqual([{ index: 0, option: 'x265', absence: { kind: 'license', reason: "x265 is GPL-only (FFmpeg's own classification)" } }]);
  });
});

describe('planProfile', () => {
  it('has one cell per variant and platform', () => {
    const plan = planProfile(fixture('playback.yml'), data);
    expect(plan.variants).toHaveLength(2);
    expect(plan.platforms).toHaveLength(15);
    expect(plan.cells).toHaveLength(30);
    expect(plan.errors).toEqual([]);
  });
});

describe('optional pieces (uses)', () => {
  const srtOnly = (license: string) => profile(`name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [srt]\n`);

  it('builds an optional piece where the license allows it, and says where it is left out', () => {
    const v2 = planProfile(srtOnly('gplv2'), data, { '9': '9.0.2' }).cells[0]!;
    expect(v2.recipes).toEqual(['mbedtls', 'srt']); // mbedTLS is Apache-2.0 OR GPL-2.0-or-later
    expect(v2.leftOut).toEqual([]);
    const lgplv2 = planProfile(srtOnly('lgplv2'), data, { '9': '9.0.2' }).cells[0]!;
    expect(lgplv2.recipes).toEqual(['srt']);
    expect(lgplv2.leftOut).toEqual([
      { recipe: 'srt', uses: 'mbedtls', kind: 'license', reason: 'mbedtls is Apache-2.0 OR GPL-2.0-or-later' },
    ]);
  });
});

describe('dependencies per platform', () => {
const platformEngine = (cPlatforms = 'all', cLicense = 'MIT') => {
  const recipe = (name: string, extra = '') =>
    `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n${extra}`;
  return loadEngineData(writeEngine({
    'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a }\n',
    'recipes/a/recipe.yml': recipe('a', 'needs: [b, { c: { platforms: [win-*] } }]\n'),
    'recipes/b/recipe.yml': recipe('b'),
    'recipes/c/recipe.yml': recipe('c').replace('license: MIT', `license: ${cLicense}`).replace('platforms: all', `platforms: ${cPlatforms}`),
  }));
};

  it('builds a platform-limited dependency only on its platforms', () => {
    const d = platformEngine();
    const at = (platform: string) => cellBuildOrder(d, { series: '9', major: '9', version: '9.0.0', license: 'lgplv3', platform }, ['a']).order;
    expect(at('linux-x64')).toEqual(['b', 'a']);
    expect(at('win-x64')).toEqual(['b', 'c', 'a']);
  });
});

describe('an option whose library differs per platform', () => {
const perPlatformEngine = () => {
  const recipe = (name: string, extra = '') =>
    `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\nconfigure: [--enable-${name}]\n${extra}`;
  return loadEngineData(writeEngine({
    'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  vulkan: { needs: [{ loader: { platforms: [linux-*] } }, { shim: { platforms: [win-*] } }], configure: [--enable-vulkan] }\n',
    'recipes/loader/recipe.yml': recipe('loader').replace('platforms: all', 'platforms: [linux-*]'),
    'recipes/shim/recipe.yml': recipe('shim').replace('platforms: all', 'platforms: [win-*]'),
  }));
};

  const cellOn = (platform: string): Cell => ({ series: '9', major: '9', version: '9.0.0', license: 'lgplv3', platform });
  const vulkanOnly = (platforms: string) => profile(`name: t\nffmpeg: 9\nplatforms: ${platforms}\nlicense: lgplv3\nwith: [vulkan]\n`);

  it('builds the library for each platform', () => {
    const d = perPlatformEngine();
    expect(resolveCell(vulkanOnly('[linux-x64]'), d, cellOn('linux-x64')).recipes).toEqual(['loader']);
    expect(resolveCell(vulkanOnly('[win-x64]'), d, cellOn('win-x64')).recipes).toEqual(['shim']);
  });

  it('is not available where no library applies', () => {
    expect(availability(perPlatformEngine(), cellOn('osx-arm64'), 'vulkan')).toEqual({ kind: 'platform', reason: 'ffmpeg-build has no library for vulkan there' });
  });
});
