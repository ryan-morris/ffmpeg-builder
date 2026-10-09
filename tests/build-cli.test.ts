import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFolderLock } from '../src/lockfile.ts';
import { copyDvrFolder, fixtureEngineRoot } from './helpers.ts';
import { runCliAsync } from './upstream-helpers.ts';

const env = { FFMPEG_BUILD_DATA: fixtureEngineRoot, FFMPEG_BUILD_DOCKER: 'ffmpeg-build-no-such-docker' };
const lock = { engine: '0.2.0', ffmpeg: { '9': '9.1.0' }, libraries: { dav1d: '1.5.4', libdrm: '2.4.134', libva: '2.24.1', mbedtls: '3.6.5', 'nv-codec': '13.0.19.1', opus: '1.6.1', srt: '1.5.8' } };

function folder(withLock: boolean, extraTargets = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-build-'));
  copyDvrFolder(dir);
  if (extraTargets) appendFileSync(join(dir, 'ffmpeg-build.yml'), extraTargets);
  if (withLock) writeFileSync(join(dir, 'ffmpeg.lock'), formatFolderLock(lock));
  return dir;
}

describe('ffmpeg-build build', () => {
  it('builds only the platforms platforms.yml lists', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-arm64'], { cwd: folder(true), env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("building for linux-arm64 isn't supported yet (ffmpeg-build builds: linux-x64)");
  });

  it.skipIf(process.platform === 'darwin')('says a macOS platform builds on a Mac', async () => {
    const engine = mkdtempSync(join(tmpdir(), 'ffmpeg-build-engine-mac-'));
    cpSync(fixtureEngineRoot, engine, { recursive: true });
    writeFileSync(join(engine, 'platforms.yml'), 'platforms:\n  linux-x64: { image: linux-x64, setup: linux }\n  osx-arm64: { image: macos, setup: apple }\n');
    const dir = folder(true, '  mac:\n    platform: osx-arm64\n    license: nonfree\n    ffmpeg: 9\n    with: [dav1d]\n');
    const r = await runCliAsync(['build', '--target', 'mac'], { cwd: dir, env: { ...env, FFMPEG_BUILD_DATA: engine } });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('osx-arm64 builds on macOS (Xcode); run this on a Mac');
  });

  it('needs the lock', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: folder(false), env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('ffmpeg.lock has no FFmpeg 9 yet; run ffmpeg-build lock first');
  });

  it('needs a target, and names the ones there are', async () => {
    const none = await runCliAsync(['build'], { cwd: folder(true), env });
    expect(none.exitCode).toBe(2);
    expect(none.stdout).toContain('name the target to build: --target <name>');
    const unknown = await runCliAsync(['build', '--target', 'nope'], { cwd: folder(true), env });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toContain('no target nope in ffmpeg-build.yml (targets: linux-x64, linux-arm64)');
  });

  it('stops on a folder-wide problem, naming it', async () => {
    const dir = folder(true);
    writeFileSync(join(dir, 'ffmpeg-build.yml'), readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8').replace('  nvenc: "13.0"', '  nvenc: "13.0"\n  x265: "4.1"'));
    const r = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: dir, env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('✗ pin x265: no target builds x265; remove the pin');
  });

  it('needs Docker', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: folder(true), env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('ffmpeg-build needs Docker to build linux-x64');
  });

  it('says when Docker is installed but not running', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: folder(true), env: { ...env, FFMPEG_BUILD_DOCKER: process.execPath } });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('Docker is installed but not running; start it (Docker Desktop on Windows/macOS) and try again');
  });
});
