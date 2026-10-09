import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkProfile } from '../src/check.ts';
import { formatReport } from '../src/format.ts';
import { loadProfile, parseProfileText } from '../src/profile.ts';
import { fmtEntry } from '../src/text.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { fixtureData, fixtureProfilesDir, writeEngine } from './helpers.ts';

const data = fixtureData();
const checkFixture = (name: string) => checkProfile(loadProfile(join(fixtureProfilesDir, name)), data);
const checkText = (text: string) => checkProfile(parseProfileText(text, 't.yml'), data);

describe('fmtEntry', () => {
  it('shows entries the way profiles write them', () => {
    expect(fmtEntry({ name: 'x265' })).toBe('x265');
    expect(fmtEntry({ name: 'whisper', cond: { ffmpeg: ['>=8'] } })).toBe('whisper { ffmpeg: ">=8" }');
    expect(fmtEntry({ name: 'nvenc', cond: { platforms: ['linux-x64', 'win-*'] } })).toBe('nvenc { platforms: [linux-x64, win-*] }');
  });
});

describe('check', () => {
  it('passes dvr.yml', () => {
    const report = checkFixture('dvr.yml');
    expect(report.problems).toBe(0);
    const text = formatReport(report);
    expect(text).toContain('dvr.yml   (ffmpeg: 9, platforms: [linux-x64, linux-arm64], license: nonfree)');
    expect(text).toContain('  with: nvenc\n    ✓ available on FFmpeg 9, linux-x64, linux-arm64');
  });

  it('explains playback.yml across versions and platforms', () => {
    const report = checkFixture('playback.yml');
    expect(report.problems).toBe(0);
    const text = formatReport(report);
    expect(text).toContain('  with: whisper { ffmpeg: ">=8" }\n    ✓ required and available on FFmpeg 8 and 9, every platform');
    expect(text).toContain('  gnutls / openssl / schannel / securetransport  (tls - one per build)');
    expect(text).toContain('    ✓ linux-*, maccatalyst-*, android-*: openssl     win-*: schannel     osx-*, ios-*: securetransport');
    expect(text).toContain('  with: nvenc\n    ✓ available on FFmpeg 8 and 9, linux-x64, linux-arm64, linux-musl-*, win-x64');
    expect(text).toContain("    - not on linux-armhf, win-arm64: the nv-codec recipe doesn't build there   (reported, not an error)");
    expect(text).toContain("    - not on osx-*, ios-*, maccatalyst-*, android-*: FFmpeg doesn't support nvenc there   (reported, not an error)");
    expect(text).toContain("    - not on android-*: the libva recipe doesn't build there");
    expect(text).toContain('    - FFmpeg 8: FFmpeg added whep in 9.1.0   (reported, not an error)');
  });

  it('reports version absences in oss.yml, and fails the entry its license does not allow', () => {
    const report = checkFixture('oss.yml');
    expect(report.problems).toBe(1);
    const text = formatReport(report);
    expect(text).toContain('  with: whep\n    ✓ available on FFmpeg 9, every platform\n    - FFmpeg 8: FFmpeg added whep in 9.1.0   (reported, not an error)');
    expect(text).toContain("  with: x265\n    ✓ available on FFmpeg 8 and 9, every platform, gplv2\n    ✗ lgplv3: x265 is GPL-only (FFmpeg's own classification)\n        Limit this entry with `license: [gplv2]`");
  });

  it('finds every problem in bad.yml', () => {
    const report = checkFixture('bad.yml');
    const text = formatReport(report);
    expect(text).toContain('  ✗ with: whisper { ffmpeg: ">=10" }\n      This profile targets ffmpeg: 9 only, so this entry can never apply.');
    expect(text).toContain('  ✗ with: frobnicate\n      ffmpeg-build doesn\'t know "frobnicate".');
    expect(text).toContain('  ✗ with: x265 and without: x265\n      x265 is both added and removed everywhere; keep one of them.');
    expect(text).toContain('  ✗ pin: schannel\n      schannel is part of FFmpeg itself; there is no library version to pin.');
    expect(text).toContain("  with: nvenc { platforms: osx-* }\n    ✗ required here, but not on osx-arm64: FFmpeg doesn't support nvenc there");
    expect(text).toContain('    ✗ linux-x64: gnutls and openssl are both in this build, but FFmpeg uses one tls per build');
    expect(report.problems).toBe(6);
    expect(text.trimEnd().endsWith('6 problems in tests/fixtures/profiles/bad.yml.')).toBe(true);
  });

  it('flags a `with` that would be in no build at all', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [osx-arm64]\nlicense: lgplv3\nwith: [vaapi]\n');
    expect(formatReport(report)).toContain("    ✗ vaapi would be in no build at all\n        not on osx-arm64: FFmpeg doesn't support vaapi there");
    expect(report.problems).toBe(1);
  });

  it('flags a pin that applies to no build', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: all\nlicense: gplv3\nwith: [dav1d]\npin: { opus: "1.5" }\n');
    expect(formatReport(report)).toContain("  ✗ pin: opus\n      opus isn't in any build of this profile, so this pin never applies.");
    expect(report.problems).toBe(1);
  });

  it('flags a pin entry that an earlier entry always beats', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: all\nlicense: gplv3\nwith: [x265]\npin:\n  - x265: "4.3"\n  - x265: { version: "4.2", platforms: [linux-x64] }\n');
    expect(formatReport(report)).toContain('  ✗ pin: x265 { platforms: linux-x64 }\n      an earlier pin for x265 always comes first, so this one never applies.');
    expect(report.problems).toBe(1);
  });

  it('lists shape problems under the file', () => {
    const report = checkFixture('invalid.yml');
    expect(report.problems).toBeGreaterThanOrEqual(3);
    expect(formatReport(report).split('\n')[0]).toBe('tests/fixtures/profiles/invalid.yml');
  });

  it('stops at FFmpeg series it has no data for', () => {
    const text = formatReport(checkText('name: t\nffmpeg: 4\nplatforms: all\nlicense: gplv3\n'));
    expect(text).toContain('  ✗ ffmpeg: 4: ffmpeg-build has no data for FFmpeg 4 (it knows 8, 9)');
  });
});

describe('licenses in check', () => {
  it('makes an entry the license does not allow an error, with the limit to add', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: [lgplv3, gplv2]\nwith: [openssl, x265]\n');
    const text = formatReport(report);
    expect(text).toContain('✗ gplv2: openssl is Apache-2.0');
    expect(text).toContain('Limit this entry with `license: [lgplv3]`');
    expect(text).toContain("✗ lgplv3: x265 is GPL-only (FFmpeg's own classification)");
    expect(text).toContain('Limit this entry with `license: [gplv2]`');
  });

  it('says to remove an entry no license of the profile allows', () => {
    const text = formatReport(checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [x265]\n'));
    expect(text).toContain('Remove it, or add a license it allows: gplv2, gplv3, nonfree');
  });

  it('reports optional pieces left out, without failing', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: [lgplv3, lgplv2]\nwith: [srt]\n');
    expect(report.problems).toBe(0);
    expect(formatReport(report)).toContain('- srt without mbedtls on lgplv2: mbedtls is Apache-2.0 OR GPL-2.0-or-later');
  });

  it('reports two TLS libraries in one build as a conflict, even with one license', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: gplv3\nwith: [openssl, gnutls]\n');
    expect(report.problems).toBeGreaterThan(0);
    expect(formatReport(report)).toContain('gnutls and openssl are both in this build, but FFmpeg uses one tls per build');
  });
});

describe('what a condition asks for', () => {
  it('treats a license limit as compliance, not as asking for the entry on every platform', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64, osx-arm64]\nlicense: gplv3\nwith:\n  - vaapi: { license: [gplv3] }\n');
    expect(report.problems).toBe(0);
    expect(formatReport(report)).toContain("    - not on osx-arm64: FFmpeg doesn't support vaapi there   (reported, not an error)");
  });

  it('still requires an entry where its platforms or FFmpeg condition says', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64, osx-arm64]\nlicense: gplv3\nwith:\n  - vaapi: { platforms: [osx-*], license: [gplv3] }\n');
    expect(formatReport(report)).toContain("    ✗ required here, but not on osx-arm64: FFmpeg doesn't support vaapi there");
  });

  it('reports a without exception to a required entry, without failing', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64, linux-arm64]\nlicense: gplv3\nwith:\n  - dav1d: { platforms: [linux-*] }\nwithout:\n  - dav1d: { platforms: [linux-arm64] }\n');
    expect(report.problems).toBe(0);
    expect(formatReport(report)).toContain('    - removed by without on linux-arm64');
  });

  it('takes a without exception as the reason, even where the entry could not be built anyway', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64, osx-arm64]\nlicense: gplv3\nwith:\n  - vaapi: { ffmpeg: "9" }\nwithout:\n  - vaapi: { platforms: [osx-arm64] }\n');
    expect(report.problems).toBe(0);
    expect(formatReport(report)).toContain('    - removed by without on osx-arm64');
  });
});

describe('license problems, once per entry', () => {
  it('gives an entry one problem, naming every license it is not allowed in', () => {
    const report = checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: [gplv3, gplv2, lgplv3, lgplv2]\nwith: [openssl]\n');
    const text = formatReport(report);
    expect(report.problems).toBe(1);
    expect(text).toContain('    ✗ gplv2, lgplv2: openssl is Apache-2.0\n        Limit this entry with `license: [gplv3, lgplv3]`');
  });

  it("keeps the entry's own license limit in the fix", () => {
    const text = formatReport(checkText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: [gplv2, gplv3, lgplv3]\nwith:\n  - x265: { license: [lgplv3, gplv3] }\n'));
    expect(text).toContain('Limit this entry with `license: [gplv3]`');
  });

  it('works out the fix from the FFmpeg versions that have the option', () => {
    const real = loadEngineData(packageRoot);
    const loaded = parseProfileText('name: t\nffmpeg: [9, 8]\nplatforms: [linux-x64]\nlicense: [gplv2, gplv3]\nwith: [shaderc]\n', 't.yml');
    expect(formatReport(checkProfile(loaded, real))).toContain('Limit this entry with `license: [gplv3]`');
  });

  it('reports a left-out optional piece once, for every license it applies to', () => {
    const real = loadEngineData(packageRoot);
    const loaded = parseProfileText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: [gplv2, lgplv2, gplv3]\nwith: [whisper]\n', 't.yml');
    const text = formatReport(checkProfile(loaded, real));
    expect(text.match(/whisper\.cpp without vulkan-loader/g)).toHaveLength(1);
    expect(text).toContain('- whisper.cpp without vulkan-loader on gplv2, lgplv2: vulkan-loader is Apache-2.0');
  });
});

describe('licenses per platform', () => {
  const recipe = (name: string, license: string, extra = '') =>
    `name: ${name}\nlicense: ${license}\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n${extra}`;
  const d = () => loadEngineData(writeEngine({
    'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a }\n',
    'recipes/a/recipe.yml': recipe('a', 'MIT', 'needs: [{ c: { platforms: [win-*] } }]\n'),
    'recipes/c/recipe.yml': recipe('c', 'Apache-2.0'),
  }));

  it("doesn't count a dependency of another platform against a build", () => {
    const report = checkProfile(parseProfileText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv2\nwith: [a]\n', 't.yml'), d());
    expect(report.problems).toBe(0);
  });

  it('limits the fix to the licenses allowed on the platforms where the entry is blocked', () => {
    const text = formatReport(checkProfile(parseProfileText('name: t\nffmpeg: 9\nplatforms: [linux-x64, win-x64]\nlicense: [lgplv2, lgplv3]\nwith: [a]\n', 't.yml'), d()));
    expect(text).toContain('✗ lgplv2: a needs c (Apache-2.0)');
    expect(text).toContain('Limit this entry with `license: [lgplv3]`');
  });

});

describe('runtime libraries a platform ships', () => {
  it("is an error where the build's license doesn't allow one", () => {
    const d = loadEngineData(writeEngine({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions: {}\n',
      'platforms.yml': 'platforms:\n  linux-x64: { image: linux-x64, setup: linux, ships: { libfoo.so: { license: Apache-2.0, notice: /x/NOTICE } } }\n',
    }));
    const text = formatReport(checkProfile(parseProfileText('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: [lgplv2, lgplv3]\n', 't.yml'), d));
    expect(text).toContain("✗ linux-x64 ships libfoo.so (Apache-2.0), which lgplv2 doesn't allow");
  });
});
