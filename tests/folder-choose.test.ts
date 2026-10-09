import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Upstreams } from '../src/choose.ts';
import { chooseFolder, folderLockMatches } from '../src/folder-choose.ts';
import { loadFolder, type Folder } from '../src/targets.ts';
import type { Found } from '../src/upstream.ts';
import { fixtureData } from './helpers.ts';

const data = fixtureData();
const upstreams = (ffmpeg: string[] | undefined, libraries: Record<string, string[] | string>): Upstreams => ({
  ...(ffmpeg ? { ffmpeg } : {}),
  libraries: new Map(Object.entries(libraries).map(([k, v]): [string, Found] => [k, typeof v === 'string' ? { commit: v } : { versions: v }])),
});
const up = upstreams(['8.1.3', '9.0.2', '9.0.3', '9.1.0'], {
  dav1d: ['1.4.1', '1.5.3', '1.5.4'], opus: ['1.5.2', '1.6.1'], libdrm: ['2.4.134'], libva: ['2.24.1'], 'nv-codec': ['13.0.19.1', '13.1.15.0'],
});

function folder(text: string): Folder {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-folder-'));
  writeFileSync(join(dir, 'ffmpeg-build.yml'), text);
  const r = loadFolder(dir);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.folder;
}
const two = (extra = '', pins = '') => folder([
  'bases:',
  '  common: { with: [dav1d, opus] }',
  ...(pins ? [pins] : []),
  'targets:',
  `  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, base: [common], with: [vaapi]${extra} }`,
  '  b: { platform: win-x64, license: gplv3, ffmpeg: 9, base: [common] }',
  '',
].join('\n'));

describe('one version per library for the whole folder', () => {
  it('locks each library once, whichever targets use it, and each FFmpeg series once', () => {
    const c = chooseFolder(two(), data, undefined, up, 'update');
    expect(c.errors).toEqual([]);
    expect(c.lock).toEqual({ ffmpeg: { '9': '9.1.0' }, libraries: { dav1d: '1.5.4', libdrm: '2.4.134', libva: '2.24.1', opus: '1.6.1' } });
    expect(c.rows.find((r) => r.what === 'libva')!.targets).toEqual(['a']); // not every target uses it
    expect(c.rows.find((r) => r.what === 'dav1d')!.targets).toBeUndefined(); // every target does
  });

  it('meets a folder pin and a target pin together', () => {
    const c = chooseFolder(two(', pin: { dav1d: "1.5" }', 'pin:\n  dav1d: "<1.5.4"'), data, undefined, up, 'update');
    expect(c.errors).toEqual([]);
    expect(c.lock.libraries.dav1d).toBe('1.5.3');
  });

  it('names both pins when no version meets them', () => {
    const c = chooseFolder(two(', pin: { dav1d: "1.4" }', 'pin:\n  dav1d: "~1.5"'), data, undefined, up, 'update');
    expect(c.errors).toEqual(["dav1d: no upstream version fits `~1.5` (folder pin) and `1.4` (target a) and FFmpeg's minimum 1.0.0 (newest upstream: 1.5.4)"]);
  });

  it('refuses a pin for a library no target builds', () => {
    const c = chooseFolder(two('', 'pin:\n  srt: "1.5"'), data, undefined, up, 'update');
    expect(c.errors).toEqual(['pin srt: no target builds srt; remove the pin']);
  });

  it('locks each FFmpeg series the targets use once', () => {
    const f = folder('targets:\n  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [opus] }\n  b: { platform: linux-x64, license: gplv3, ffmpeg: 8, with: [opus] }\n  c: { platform: win-x64, license: gplv3, ffmpeg: 9, with: [opus] }\n');
    expect(chooseFolder(f, data, undefined, up, 'update').lock.ffmpeg).toEqual({ '8': '8.1.3', '9': '9.1.0' });
  });

  it('keeps what is locked and asks upstream only for what is missing', () => {
    const f = two();
    const locked = chooseFolder(f, data, undefined, up, 'update').lock;
    const { opus: _, ...withoutOpus } = locked.libraries;
    const c = chooseFolder(f, data, { engine: '0.3.0', ...locked, libraries: withoutOpus }, upstreams(undefined, {}), 'keep');
    expect(c.missing).toEqual(['opus']);
    expect(folderLockMatches(f, data, { engine: '0.3.0', ...locked })).toBe(true);
    expect(folderLockMatches(f, data, { engine: '0.3.0', ...locked, libraries: withoutOpus })).toBe(false);
  });

  it('lists the new options of an FFmpeg minor per target that does not have them', () => {
    const old = { engine: '0.3.0', ffmpeg: { '9': '9.0.2' }, libraries: {} };
    const f = folder('targets:\n  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [opus, amf] }\n  b: { platform: win-x64, license: gplv3, ffmpeg: 9, with: [opus], without: [amf] }\n  c: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [opus] }\n');
    const row = chooseFolder(f, data, old, up, 'update').rows.find((r) => r.what === 'FFmpeg 9')!;
    expect(row.newMinor).toMatchObject({ from: '9.0', to: '9.1', adds: ['amf', 'whep'], missingIn: { amf: ['c'] } });
  });
});
