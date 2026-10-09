import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSupport, newMajors, parseConfigure, supportReport, writeReleases } from '../src/ffmpeg-support.ts';
import { fixtureData, fixtureEngineRoot } from './helpers.ts';

// the shape of FFmpeg's configure lists: lists of names, some holding other lists by $NAME
const CONFIGURE = [
  'EXTERNAL_AUTODETECT_LIBRARY_LIST="', '    zlib', '"',
  'EXTERNAL_LIBRARY_GPL_LIST="', '    libx264', '    libx265', '"',
  'EXTERNAL_LIBRARY_NONFREE_LIST="', '    libfdk_aac', '"',
  'EXTERNAL_LIBRARY_VERSION3_LIST="', '    libopencore_amrnb', '"',
  'EXTERNAL_LIBRARY_GPLV3_LIST="', '    libsmbclient', '"',
  'EXTERNAL_LIBRARY_LIST="', '    $EXTERNAL_LIBRARY_GPL_LIST', '    $EXTERNAL_LIBRARY_NONFREE_LIST', '    $EXTERNAL_LIBRARY_VERSION3_LIST',
  '    $EXTERNAL_LIBRARY_GPLV3_LIST', '    libdav1d', '    libopus', '    libsrt', '    gnutls', '    openssl', '    whisper', '"',
  'HWACCEL_AUTODETECT_LIBRARY_LIST="', '    vaapi', '"',
  'HWACCEL_LIBRARY_NONFREE_LIST="', '    cuda_nvcc', '"',
  'HWACCEL_LIBRARY_LIST="', '    $HWACCEL_LIBRARY_NONFREE_LIST', '    ffnvcodec', '    nvenc', '"',
  '',
].join('\n');

describe('the FFmpeg support check', () => {
  it("reads configure's library options and their licence classes, following $LIST references", () => {
    const c = parseConfigure(CONFIGURE);
    expect(c.get('libx265')).toBe('gpl');
    expect(c.get('libfdk_aac')).toBe('nonfree');
    expect(c.get('libopencore_amrnb')).toBe('version3');
    expect(c.get('libsmbclient')).toBe('gplv3');
    expect(c.get('cuda_nvcc')).toBe('nonfree');
    expect(c.get('libdav1d')).toBe('');
    expect(c.has('zlib') && c.has('vaapi') && c.has('nvenc')).toBe(true);
  });

  it("corrects the releases, and reports a new release's new options, what's gone, and a changed class", () => {
    const data = fixtureData();
    const newest = parseConfigure(CONFIGURE.replace('    libopus\n', '    libopus\n    libnewcodec\n').replace('    libsrt\n', ''));
    const previous = parseConfigure(CONFIGURE);
    const r = supportReport(data, '9', ['9.0', '9.0.1', '9.0.2', '9.1.0', '8.1.3'], newest, previous);
    expect(r.releases.now).toEqual(['9.0', '9.0.1', '9.0.2', '9.1.0']);
    expect(r.newOptions).toEqual([{ name: 'libnewcodec', license: '' }]);
    expect(r.gone).toEqual(['srt']);
    const text = formatSupport([r], ['10']);
    expect(text).toContain('**new in 9.1.0**');
    expect(text).toContain('`libnewcodec`');
    expect(text).toContain('**gone from configure**, still in the data: `srt`');
    expect(text).toContain('**New FFmpeg major 10**');
  });

  it("names a licence class that changed in configure", () => {
    const data = fixtureData();
    // x265 is gpl in the fixture data; say configure moved it to nonfree
    const moved = parseConfigure(CONFIGURE.replace('    libx265\n', '').replace('    libfdk_aac\n', '    libfdk_aac\n    libx265\n'));
    const r = supportReport(data, '9', ['9.0.2'], moved, undefined);
    expect(r.reclassed).toEqual([{ option: 'x265', data: 'gpl', configure: 'nonfree' }]);
  });

  it("rewrites only the releases line, and knows a major the data doesn't have", () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-support-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    const before = readFileSync(join(root, 'ffmpeg', '9.yml'), 'utf8');
    expect(writeReleases(root, '9', ['9.0', '9.0.1'])).toBe(true);
    const after = readFileSync(join(root, 'ffmpeg', '9.yml'), 'utf8');
    expect(after).toContain('releases: [9.0, 9.0.1]');
    expect(after.replace(/^releases: .*$/m, '')).toBe(before.replace(/^releases: .*$/m, ''));
    expect(newMajors(fixtureData(), ['9.0.2', '10.0', '11.0'])).toEqual(['10', '11']);
  });
});
