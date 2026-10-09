import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfile, parseProfileText, type LoadResult } from '../src/profile.ts';
import { fixtureProfilesDir } from './helpers.ts';

function ok(result: LoadResult) {
  if (!result.ok) throw new Error(`expected a valid profile, got:\n${result.errors.join('\n')}`);
  return result.profile;
}
function errors(text: string): string[] {
  const result = parseProfileText(text, 'test.yml');
  if (result.ok) throw new Error('expected problems');
  return result.errors;
}
const base = 'name: t\nffmpeg: 9\nplatforms: all\nlicense: gplv3\n';

describe('profiles', () => {
  it('loads dvr.yml with defaults and normalised entries', () => {
    const p = ok(loadProfile(join(fixtureProfilesDir, 'dvr.yml')));
    expect(p).toMatchObject({
      file: 'tests/fixtures/profiles/dvr.yml', name: 'dvr', ffmpeg: ['9'], platforms: ['linux-x64', 'linux-arm64'], license: ['nonfree'],
      with: [{ name: 'nvenc' }, { name: 'vaapi' }, { name: 'srt' }, { name: 'dav1d' }, { name: 'opus' }],
      without: [], pin: [{ name: 'nvenc', version: '13.0' }],
      patches: ['patches/acme-muxer'], tests: ['./tests/acme-roundtrip.sh'],
    });
    expect(p.with[0]!.cond).toBeUndefined();
  });

  it('reads conditions on with and without entries', () => {
    const p = ok(parseProfileText(`${base}with:\n  - whisper: { ffmpeg: ">=8", platforms: linux-x64 }\nwithout:\n  - nvenc: { license: [gplv3] }\n`, 't.yml'));
    expect(p.with).toEqual([{ name: 'whisper', cond: { ffmpeg: ['>=8'], platforms: ['linux-x64'] } }]);
    expect(p.without).toEqual([{ name: 'nvenc', cond: { license: ['gplv3'] } }]);
  });

  it('accepts only the list form for with and without', () => {
    expect(errors(`${base}with: { whisper: { ffmpeg: ">=8" } }\n`)[0]).toMatch(/^with: expected a list/);
  });

  it('reads pins in map form and list form, keeping their order', () => {
    expect(ok(parseProfileText(`${base}pin: { nvenc: "13.0" }\n`, 't.yml')).pin).toEqual([{ name: 'nvenc', version: '13.0' }]);
    const p = ok(loadProfile(join(fixtureProfilesDir, 'playback.yml')));
    expect(p.pin).toEqual([
      { name: 'dav1d', version: '1.5', cond: { platforms: ['win-arm64'] } },
      { name: 'nvenc', version: '13.0' },
    ]);
  });

  it('explains that start: was removed, once', () => {
    expect(errors(`${base}start: everything\nwith: [x265]\n`)).toEqual([
      'start: was removed: a profile now lists everything it builds. Delete the `start:` line. If it said `start: everything`, list what it should build in `with:` (`ffmpeg-build options` shows what there is).',
    ]);
  });

  it('keeps ffmpeg: 9.10 as written', () => {
    expect(ok(parseProfileText('name: t\nffmpeg: 9.10\nplatforms: all\nlicense: gplv3\n', 't.yml')).ffmpeg).toEqual(['9.10']);
  });

  it('explains shape problems in plain words', () => {
    const result = loadProfile(join(fixtureProfilesDir, 'invalid.yml'));
    expect(result.ok).toBe(false);
    const text = (result as { errors: string[] }).errors.join('\n');
    expect(text).toContain('name: expected a short lowercase name');
    expect(text).toContain('start: was removed: a profile now lists everything it builds. Delete the `start:` line.');
    expect(text).toMatch(/extends/);
  });

  it('checks values zod cannot', () => {
    expect(errors('name: t\nffmpeg: nine\nplatforms: [freebsd-x64]\nlicense: gplv3\n')).toEqual([
      'ffmpeg: "nine" is not an FFmpeg series (use 9, 9.0 or latest)',
      'platforms: "freebsd-x64" matches no platform',
    ]);
    expect(errors(`${base}with:\n  - whisper: { ffmpeg: "~8", platforms: [beos-*] }\n`)).toEqual([
      'with[0]: "~8" is not a version condition (use 9, ">=8" or "<9.1")',
      'with[0]: "beos-*" matches no platform',
    ]);
  });

  it('rejects duplicated or overlapping list values', () => {
    expect(errors('name: t\nffmpeg: [9, "9.0"]\nplatforms: [linux-x64, linux-x64]\nlicense: [gplv3, gplv3]\n')).toEqual([
      'ffmpeg: 9 and 9.0 overlap; list each FFmpeg series once',
      'platforms: linux-x64 is listed twice',
      'license: gplv3 is listed twice',
    ]);
    expect(errors('name: t\nffmpeg: [latest, 9]\nplatforms: all\nlicense: gplv3\n')).toEqual([
      'ffmpeg: latest can only be used on its own',
    ]);
  });

  it('says plainly when a key is misspelled', () => {
    expect(errors('name: t\nffmpeg: 9\nplatform: all\nlicense: gplv3\n')).toContain(
      'unknown key "platform" (a profile has: name, ffmpeg, platforms, license, with, without, pin, patches, tests)',
    );
  });

  it('says plainly when a file is not a profile at all', () => {
    const notAProfile = ["this doesn't look like a profile: it has none of name, ffmpeg, platforms, license"];
    expect(errors('services:\n  web:\n    image: nginx\n')).toEqual(notAProfile);
    expect(errors('- a\n- b\n')).toEqual(notAProfile);
  });

  it('accepts a single patch folder or test, like every other list key', () => {
    expect(ok(parseProfileText(`${base}patches: patches/acme\ntests: ./t.sh\n`, 't.yml'))).toMatchObject({ patches: ['patches/acme'], tests: ['./t.sh'] });
  });

  it('never shows zod wording', () => {
    const text = errors(`${base}patches: { a: b }\n`).join('\n');
    expect(text).not.toMatch(/Invalid input|Unrecognized key|received/);
  });

  it('rejects FFmpeg series with leading zeros', () => {
    expect(errors('name: t\nffmpeg: "09"\nplatforms: all\nlicense: gplv3\n')).toEqual(['ffmpeg: "09" is not an FFmpeg series (use 9, 9.0 or latest)']);
  });

  it('reports an entry listed twice, but allows the same name with different conditions', () => {
    expect(errors(`${base}with: [x265, x265]\nwithout:\n  - nvenc: { platforms: [win-*] }\n  - nvenc: { platforms: [win-*] }\npin: [{ x265: "4.3" }, { x265: "4.3" }]\n`)).toEqual([
      'with: x265 is listed twice',
      'without: nvenc { platforms: win-* } is listed twice',
      'pin: x265 is listed twice',
    ]);
    expect(parseProfileText(`${base}with: [x265, { x265: { license: gplv3 } }]\n`, 't.yml').ok).toBe(true);
  });

  it('checks that a pin is a version, a range or a commit', () => {
    expect(errors(`${base}pin: { x265: "garbage version" }\n`)).toEqual([
      'pin[0]: "garbage version" is not a version or range (use 4.3, 4.3.1, ~1.5.4, ^1.5.4 or ">=3.6 <4", or a full commit hash)',
    ]);
    const p = ok(parseProfileText(`${base}pin:\n  dav1d: "^1.5.4"\n  mbedtls: ">=3.6 <4"\n  x264: b35605ace3ddf7c1a5d67a2eb553f034aef41d55\n`, 't.yml'));
    expect(p.pin.map((e) => e.version)).toEqual(['^1.5.4', '>=3.6 <4', 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55']);
  });

  it('reports YAML problems with their line', () => {
    expect(errors('name: t\nname: u\n')).toEqual([expect.stringMatching(/^line 2: /)]);
  });

  it('reports a missing file without crashing', () => {
    expect(loadProfile(join(fixtureProfilesDir, 'nope.yml'))).toEqual({ ok: false, file: 'tests/fixtures/profiles/nope.yml', errors: ['file not found'] });
    expect(loadProfile(fixtureProfilesDir)).toEqual({ ok: false, file: 'tests/fixtures/profiles', errors: ['this is a folder, not a profile file'] });
  });

  it('reads a Windows-saved profile file (BOM, CRLF) exactly like an LF one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-bom-'));
    const text = 'name: t\nffmpeg: 9\nplatforms: all\nlicense: gplv3\nwith: [x265]\n';
    writeFileSync(join(dir, 'lf.yml'), text);
    writeFileSync(join(dir, 'win.yml'), `\uFEFF${text.replace(/\n/g, '\r\n')}`);
    const { file: _a, ...lf } = ok(loadProfile(join(dir, 'lf.yml')));
    const { file: _b, ...win } = ok(loadProfile(join(dir, 'win.yml')));
    expect(win).toEqual(lf);
  });
});
