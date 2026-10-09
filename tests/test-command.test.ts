import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runnablePlatforms, runTest } from '../src/commands/test.ts';
import { formatFolderLock } from '../src/lockfile.ts';
import { loadFolder } from '../src/targets.ts';
import { tarGz } from './github-fake.ts';
import { fixtureData, fixtureEngineRoot, runCli } from './helpers.ts';

const data = fixtureData();
const LOCK = { engine: '0.2.0', ffmpeg: { '9': '9.1.0' }, libraries: { dav1d: '1.5.4' } };

/** A folder with one linux-x64 target "built" into dist, its ffmpeg a script that answers like the real one. */
function built(tests: Record<string, string> = {}, license = 'lgplv3'): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-test-cmd-'));
  const list = Object.keys(tests);
  writeFileSync(join(d, 'ffmpeg-build.yml'), `targets:\n  t: { platform: linux-x64, license: ${license}, ffmpeg: 9, with: [dav1d]${list.length ? `, tests: [${list.join(', ')}]` : ''} }\n`);
  writeFileSync(join(d, 'ffmpeg.lock'), formatFolderLock(LOCK));
  for (const [path, text] of Object.entries(tests)) {
    mkdirSync(join(d, path, '..'), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  const ffmpeg = [
    '#!/usr/bin/env bash',
    'case "$*" in',
    '  *-version*) echo "ffmpeg version 9.1.0 Copyright" ;;',
    '  *-buildconf*) echo "  --disable-gpl --enable-shared" ;;',
    '  *testsrc2*) exit 0 ;;',
    'esac',
  ].join('\n');
  mkdirSync(join(d, 'dist'));
  writeFileSync(join(d, 'dist', 'ffmpeg-9.1.0-t.tar.gz'), tarGz([{ name: 'ffmpeg', data: `${ffmpeg}\n`, mode: 0o755 }]));
  return d;
}
const folderOf = (d: string) => {
  const r = loadFolder(d);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.folder;
};

describe('ffmpeg-build test', () => {
  it('knows which builds this machine can run', () => {
    expect(runnablePlatforms('linux', 'x64', false, false)).toEqual(['linux-x64']);
    expect(runnablePlatforms('linux', 'x64', true, false)).toEqual(['linux-musl-x64']);
    expect(runnablePlatforms('darwin', 'arm64', false, true)).toEqual(['osx-arm64', 'osx-x64']);
    expect(runnablePlatforms('darwin', 'arm64', false, false)).toEqual(['osx-arm64']);
    expect(runnablePlatforms('win32', 'arm64', false, false)).toEqual(['win-arm64', 'win-x64']);
  });

  it("skips a build this machine can't run, and says why", () => {
    const d = built();
    expect(runTest(folderOf(d), data, { target: 't', dist: join(d, 'dist'), runnable: ['win-x64'] })).toEqual({
      output: "t: skipped, linux-x64 builds don't run on this machine (it runs win-x64)",
      exitCode: 0,
    });
  });

  it.skipIf(process.platform === 'win32')("runs the smoke test and the target's tests, failing on one that fails", () => {
    const pass = built({ 'tests/ok.sh': '"${FFMPEG}" -version | grep -q 9.1.0\n' });
    const ok = runTest(folderOf(pass), data, { target: 't', dist: join(pass, 'dist'), runnable: ['linux-x64'] });
    expect(ok.output).toContain('✓ ffmpeg -version says 9.1.0');
    expect(ok.output).toContain('✓ ffmpeg -buildconf matches lgplv3');
    expect(ok.output).toContain('✓ tests: tests/ok.sh');
    expect(ok.exitCode).toBe(0);
    const fail = built({ 'tests/bad.sh': 'echo "decoded the wrong number of frames"; exit 3\n' });
    const r = runTest(folderOf(fail), data, { target: 't', dist: join(fail, 'dist'), runnable: ['linux-x64'] });
    expect(r.output).toContain('✗ tests: tests/bad.sh');
    expect(r.output).toContain('decoded the wrong number of frames');
    expect(r.exitCode).toBe(1);
  });

  it("check refuses a tests: script that isn't there", () => {
    const d = built({});
    writeFileSync(join(d, 'ffmpeg-build.yml'), 'targets:\n  t: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d], tests: [tests/missing.sh] }\n');
    const r = runCli(['check'], { cwd: d, env: { FFMPEG_BUILD_DATA: fixtureEngineRoot } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('✗ tests: tests/missing.sh: no such file (ffmpeg-build test runs it against the build)');
  });
});
