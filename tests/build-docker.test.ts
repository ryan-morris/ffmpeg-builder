import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFolderLock } from '../src/lockfile.ts';
import { runCliAsync } from './upstream-helpers.ts';

const MANYLINUX = 'quay.io/pypa/manylinux_2_28_x86_64:2026.09.30-1@sha256:c2261579b9c2e5d45aa93312f73e2a302182e3e977b558581a1838d6fed3d8e6';

// Slow and needs Docker plus network: FFMPEG_BUILD_DOCKER_TESTS=1 npx vitest run tests/build-docker.test.ts
describe.skipIf(!process.env.FFMPEG_BUILD_DOCKER_TESTS)('a real linux-x64 build', () => {
  it('builds dav1d, opus and x265 into FFmpeg, then takes them from the cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-real-'));
    const cache = mkdtempSync(join(tmpdir(), 'ffmpeg-build-real-cache-'));
    writeFileSync(join(dir, 'ffmpeg-build.yml'), 'targets:\n  linux-x64-gplv3: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [dav1d, opus, x265] }\n');
    writeFileSync(join(dir, 'ffmpeg.lock'), formatFolderLock({ engine: '0.2.0', ffmpeg: { '9': '9.0.2' }, libraries: { dav1d: '1.5.4', opus: '1.6.1', x265: '4.3' } }));
    const env = { FFMPEG_BUILD_CACHE: cache };

    const first = await runCliAsync(['build', '--target', 'linux-x64-gplv3'], { cwd: dir, env });
    expect(first.stdout).toContain('built dist/ffmpeg-9.0.2-linux-x64-gplv3.tar.gz, ffmpeg-9.0.2-linux-x64-gplv3-dev.tar.gz and ffmpeg-9.0.2-linux-x64-gplv3.sources.json');
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(dir, 'dist', 'ffmpeg-9.0.2-linux-x64-gplv3-dev.tar.gz'))).toBe(true);
    const log = readFileSync(join(dir, 'dist', 'ffmpeg-9.0.2-linux-x64-gplv3.log'), 'utf8');
    for (const lib of ['dav1d 1.5.4: building', 'opus 1.6.1: building', 'x265 4.3: building']) expect(log).toContain(lib);
    expect(log).toMatch(/ffmpeg version 9\.0\.2/);
    expect(log).toMatch(/--enable-libx265/);

    // the archives, unpacked in a clean glibc-2.28 container: runnable, $ORIGIN rpath, symlinks kept, relocatable .pc
    const name = 'ffmpeg-9.0.2-linux-x64-gplv3';
    const checks = [
      'set -e', 'mkdir -p /t /d',
      `tar -xzf /out/${name}.tar.gz -C /t`, `tar -xzf /out/${name}-dev.tar.gz -C /d`,
      'test -x /t/ffmpeg', 'test -x /t/ffprobe', 'test -L /t/libavcodec.so',
      '/t/ffmpeg -hide_banner -version | grep -q -- --enable-libx265',
      'readelf -d /t/libavcodec.so | grep -q ORIGIN',
      'grep -q pcfiledir /d/lib/pkgconfig/libavcodec.pc',
      'test -f /d/include/libavcodec/avcodec.h',
    ].join('; ');
    execFileSync('docker', ['run', '--rm', '--mount', `type=bind,source=${join(dir, 'dist')},target=/out,readonly`, MANYLINUX, 'bash', '-c', checks], { stdio: 'inherit' });

    const second = await runCliAsync(['build', '--target', 'linux-x64-gplv3'], { cwd: dir, env });
    expect(second.exitCode).toBe(0);
    for (const lib of ['dav1d 1.5.4: from cache', 'opus 1.6.1: from cache', 'x265 4.3: from cache']) expect(second.stdout).toContain(lib);
  }, 90 * 60_000);
});

describe('toolchain image builds', () => {
  it("use GitHub Actions' cache in CI, one scope per image, and plain docker build elsewhere", async () => {
    const { imageBuildArgs } = await import('../src/build/docker.ts');
    expect(imageBuildArgs('t', '/i/linux-x64', 'linux-x64', undefined)).toEqual(['build', '-t', 't', '/i/linux-x64']);
    expect(imageBuildArgs('t', '/i/linux-x64', 'linux-x64', 'gha')).toEqual([
      'buildx', 'build', '--load', '--cache-from', 'type=gha,scope=linux-x64', '--cache-to', 'type=gha,mode=max,scope=linux-x64', '-t', 't', '/i/linux-x64',
    ]);
  });
});
