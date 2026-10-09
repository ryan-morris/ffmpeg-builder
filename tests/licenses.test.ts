import { describe, expect, it } from 'vitest';
import { allowedBy, type LicenseTable } from '../src/licenses.ts';
import { allowedLicenses, licenseBlocker, loadEngineData } from '../src/engine-data.ts';
import { fixtureData, writeEngine } from './helpers.ts';

const ALL = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'] as const;
const table: LicenseTable = new Map([
  ['MIT', [...ALL]],
  ['Apache-2.0', ['lgplv3', 'gplv3', 'nonfree']],
  ['GPL-2.0-or-later', ['gplv2', 'gplv3', 'nonfree']],
  ['LGPL-3.0-or-later', ['lgplv3', 'gplv3', 'nonfree']],
]);

import { optionLicenses } from '../src/resolve.ts';
describe('SPDX expressions', () => {
  it.each([
    ['MIT', [...ALL]],
    ['Apache-2.0', ['lgplv3', 'gplv3', 'nonfree']],
    ['Apache-2.0 OR MIT', [...ALL]],
    ['LGPL-3.0-or-later OR GPL-2.0-or-later', ['lgplv3', 'gplv2', 'gplv3', 'nonfree']],
    ['MIT AND Apache-2.0', ['lgplv3', 'gplv3', 'nonfree']],
    ['(MIT OR GPL-2.0-or-later) AND Apache-2.0', ['lgplv3', 'gplv3', 'nonfree']],
    ['GPL-2.0-or-later WITH Classpath-exception-2.0', ['gplv2', 'gplv3', 'nonfree']],
  ])('%s', (expression, expected) => {
    expect(allowedBy(expression, table)).toEqual({ allowed: expected });
  });

  it('names licences it does not know, and expressions it cannot read', () => {
    expect(allowedBy('MIT OR Foo-1.0', table)).toEqual({ unknown: ['Foo-1.0'] });
    expect(allowedBy('MIT OR (', table)).toEqual({ invalid: 'MIT OR (' });
    expect(allowedBy('MIT Apache-2.0', table)).toEqual({ invalid: 'MIT Apache-2.0' });
  });
});

describe('libraries in builds', () => {
  const data = fixtureData();

  it('allows a library only where it and everything it needs are allowed', () => {
    expect(licenseBlocker(data, 'dav1d', 'lgplv2')).toBeUndefined();
    expect(licenseBlocker(data, 'openssl', 'gplv2')).toBe('openssl is Apache-2.0');
    expect(licenseBlocker(data, 'mbedtls', 'gplv2')).toBeUndefined(); // Apache-2.0 OR GPL-2.0-or-later
    expect(licenseBlocker(data, 'gnutls', 'lgplv2')).toBe('gnutls needs nettle (LGPL-3.0-or-later OR GPL-2.0-or-later)');
    expect(licenseBlocker(data, 'gnutls', 'gplv2')).toBeUndefined();
    expect(allowedLicenses(data, 'gnutls')).toEqual(['lgplv3', 'gplv2', 'gplv3', 'nonfree']);
  });
});

describe('license closure per platform', () => {
  it('follows only the dependencies that apply on the platform', () => {
    const recipe = (name: string, license: string, extra = '') =>
      `name: ${name}\nlicense: ${license}\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n${extra}`;
    const d = loadEngineData(writeEngine({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions: {}\n',
      'recipes/a/recipe.yml': recipe('a', 'MIT', 'needs: [{ c: { platforms: [win-*] } }]\n'),
      'recipes/c/recipe.yml': recipe('c', 'Apache-2.0'),
    }));
    expect(licenseBlocker(d, 'a', 'lgplv2', 'linux-x64')).toBeUndefined();
    expect(licenseBlocker(d, 'a', 'lgplv2', 'win-x64')).toBe('a needs c (Apache-2.0)');
  });
});

describe('option licenses with a library per platform', () => {
  const recipe = (name: string, license: string) =>
    `name: ${name}\nlicense: ${license}\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n`;
  const d = () => loadEngineData(writeEngine({
    'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  v: { needs: [{ a: { platforms: [linux-*] } }, { b: { platforms: [win-*] } }] }\n  w: { needs: [{ b: { platforms: [win-*] } }] }\n',
    'recipes/a/recipe.yml': recipe('a', 'Apache-2.0'),
    'recipes/b/recipe.yml': recipe('b', 'MIT'),
  }));

  it("gives each platform its own library's licenses, and none where it has no library", () => {
    expect(optionLicenses(d(), '9', 'v', 'linux-x64')).toEqual(['lgplv3', 'gplv3', 'nonfree']);
    expect(optionLicenses(d(), '9', 'v', 'win-x64')).toEqual(['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']);
    expect(optionLicenses(d(), '9', 'v', 'osx-arm64')).toEqual([]);
  });

  it('without a platform, gives the licenses every library allows (one per-platform library too)', () => {
    expect(optionLicenses(d(), '9', 'v')).toEqual(['lgplv3', 'gplv3', 'nonfree']);
    expect(optionLicenses(d(), '9', 'w')).toEqual(['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']);
  });
});

describe('licence exceptions', () => {
  it('reads `X WITH exception` as its own entry when the table has one, else as X', () => {
    const t: LicenseTable = new Map([
      ['Apache-2.0', ['lgplv3', 'gplv3', 'nonfree']],
      ['Apache-2.0 WITH LLVM-exception', ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']],
    ]);
    expect(allowedBy('Apache-2.0 WITH LLVM-exception', t)).toEqual({ allowed: ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'] });
    expect(allowedBy('Apache-2.0 WITH Other-exception', t)).toEqual({ allowed: ['lgplv3', 'gplv3', 'nonfree'] });
  });

  it('lets the NDK libc++ that Android archives ship go into every license', () => {
    expect(allowedBy('Apache-2.0 WITH LLVM-exception', fixtureData().licenses)).toEqual({ allowed: ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'] });
  });
});
