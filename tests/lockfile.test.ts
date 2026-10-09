import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFolderLock, formatLock, LockError, parseFolderLock, parseLock, readLock, type Lock } from '../src/lockfile.ts';

const lock: Lock = {
  engine: '0.2.0',
  profiles: {
    playback: {
      ffmpeg: { '8': '8.1.3', '9': '9.0.2' },
      libraries: { 'nv-codec': '13.0.19.1', dav1d: '1.5.4', libplacebo: '7.360.1', x264: 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55' },
      pinned: [
        { name: 'libplacebo', version: '7.349.0', cond: { platforms: ['win-arm64'] } },
        { name: 'dav1d', version: '1.4.3', cond: { ffmpeg: ['>=9'], license: ['gplv3', 'nonfree'] } },
      ],
    },
    dvr: { ffmpeg: { '9': '9.0.2' }, libraries: { srt: '1.5.7' }, pinned: [] },
  },
};

const text = `# ffmpeg.lock - written only by \`ffmpeg-build update\` / \`ffmpeg-build lock\`. Do not edit.
engine: 0.2.0
profiles:
  dvr:
    ffmpeg: { "9": 9.0.2 }
    libraries:
      srt: 1.5.7
  playback:
    ffmpeg: { "8": 8.1.3, "9": 9.0.2 }
    libraries:
      dav1d: 1.5.4
      libplacebo: 7.360.1
      nv-codec: 13.0.19.1
      x264: b35605ace3ddf7c1a5d67a2eb553f034aef41d55
    pinned:
      - libplacebo: { version: 7.349.0, platforms: [win-arm64] }
      - dav1d: { version: 1.4.3, ffmpeg: [">=9"], license: [gplv3, nonfree] }
`;

describe('ffmpeg.lock', () => {
  it('writes a stable, sorted layout', () => {
    expect(formatLock(lock)).toBe(text);
  });

  it('reads back exactly what it wrote', () => {
    expect(parseLock(formatLock(lock), 'ffmpeg.lock')).toEqual(lock);
  });

  it('writes an empty lock', () => {
    const empty = formatLock({ engine: '0.2.0', profiles: {} });
    expect(empty).toContain('profiles: {}');
    expect(parseLock(empty, 'ffmpeg.lock')).toEqual({ engine: '0.2.0', profiles: {} });
  });

  it('stops on a merge conflict with the line, and says how to recover', () => {
    const conflicted = text.replace('    libraries:\n      srt: 1.5.7\n', '<<<<<<< HEAD\n    libraries: {}\n=======\n    libraries: { srt: 1.5.8 }\n>>>>>>> other\n');
    expect(() => parseLock(conflicted, 'ffmpeg.lock')).toThrow(LockError);
    expect(() => parseLock(conflicted, 'ffmpeg.lock')).toThrow(/^ffmpeg\.lock:\d+: .*run ffmpeg-build lock/);
  });

  it('names what is wrong in a hand-edited lock', () => {
    expect(() => parseLock('profiles: {}\n', 'ffmpeg.lock')).toThrow(/ffmpeg\.lock: engine: /);
  });

  it('reads a lock from disk, or nothing when there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-lock-'));
    expect(readLock(join(dir, 'ffmpeg.lock'))).toBeUndefined();
    writeFileSync(join(dir, 'ffmpeg.lock'), text);
    expect(readLock(join(dir, 'ffmpeg.lock'))).toEqual(lock);
  });
});

describe('the folder lock (targets)', () => {
  const lock = { engine: '0.3.0', ffmpeg: { '9': '9.0.2', '8': '8.1.3' }, libraries: { x264: 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55', dav1d: '1.5.4' } };

  it('writes one version per FFmpeg series and per library, sorted, and reads it back', () => {
    const text = formatFolderLock(lock);
    expect(text).toBe([
      '# ffmpeg.lock - written only by `ffmpeg-build update` / `ffmpeg-build lock`. Do not edit.',
      'engine: 0.3.0',
      'ffmpeg: { "8": 8.1.3, "9": 9.0.2 }',
      'libraries:',
      '  dav1d: 1.5.4',
      '  x264: b35605ace3ddf7c1a5d67a2eb553f034aef41d55',
      '',
    ].join('\n'));
    expect(parseFolderLock(text, 'ffmpeg.lock')).toEqual(lock);
  });

  it('points an older lock at migrate', () => {
    expect(() => parseFolderLock('engine: 0.2.0\nprofiles: {}\n', 'ffmpeg.lock')).toThrow(
      'ffmpeg.lock predates targets (it has profiles:); run `ffmpeg-build migrate` to convert this folder',
    );
  });

  it('says how to recover from a broken lock', () => {
    expect(() => parseFolderLock('engine: 0.3.0\nlibraries: [a]\n', 'ffmpeg.lock')).toThrow(/delete it and run ffmpeg-build lock/);
  });
});
