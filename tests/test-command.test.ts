import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerArgs, gitBash, isMusl, missingLicenseFlags, muslImage, runnablePlatforms, runTest, scriptCommand, versionMatches } from '../src/commands/test.ts';
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
    '  *-buildconf*) echo "  --disable-gpl --enable-version3 --disable-nonfree --enable-shared" ;;',
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
    expect(runnablePlatforms('linux', 'arm', false, false)).toEqual(['linux-armhf']);
    expect(runnablePlatforms('linux', 'arm', true, false)).toEqual([]); // no musl armhf build
  });

  it("tells musl from glibc by Node's report, not by a file Alpine happens to have", () => {
    if (process.platform !== 'linux') expect(isMusl()).toBe(false);
    else expect(isMusl()).toBe(!(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime);
  });

  it('checks the exact version, and every licence flag the build passes to configure', () => {
    expect(versionMatches('ffmpeg version 9.1.0 Copyright (c) 2000-2026', '9.1.0')).toBe(true);
    expect(versionMatches('ffmpeg version 9.1.0', '9.1.0')).toBe(true);
    expect(versionMatches('ffmpeg version 9.1.01 Copyright', '9.1.0')).toBe(false);
    expect(versionMatches('ffmpeg version 9.1.0.1 Copyright', '9.1.0')).toBe(false);
    expect(versionMatches('ffmpeg version 9x1x0 Copyright', '9.1.0')).toBe(false);
    expect(missingLicenseFlags('--disable-gpl --enable-shared', 'lgplv3')).toEqual(['--enable-version3', '--disable-nonfree']);
    expect(missingLicenseFlags('--enable-gpl --enable-version3 --disable-nonfree', 'gplv2')).toEqual([]);
    expect(missingLicenseFlags('--enable-gpl --enable-version3 --disable-nonfree', 'nonfree')).toEqual(['--enable-nonfree']);
  });

  it('runs a musl x64 build in the pinned Alpine on a glibc x64 machine with Docker, and says so without Docker', () => {
    expect(muslImage()).toMatch(/^alpine:[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(dockerArgs('alpine@sha256:x', ['/b', '/f'], '/f', { FFMPEG: '/b/bin/ffmpeg' }, '/b/bin/ffmpeg', ['-version'])).toEqual([
      'run', '--rm', '--network', 'none', '-v', '/b:/b:ro', '-v', '/f:/f:ro', '-w', '/f', '-e', 'FFMPEG=/b/bin/ffmpeg', 'alpine@sha256:x', '/b/bin/ffmpeg', '-version',
    ]);
    const d = built();
    writeFileSync(join(d, 'ffmpeg-build.yml'), 'targets:\n  t: { platform: linux-musl-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n');
    expect(runTest(folderOf(d), data, { target: 't', dist: join(d, 'dist'), runnable: ['linux-x64'], docker: false }).output)
      .toBe("t: skipped, linux-musl-x64 builds don't run on this machine (it runs linux-x64) (with Docker it would run in an Alpine container)");
  });

  it('runs test scripts on Windows with Git Bash (never WSL), cmd and PowerShell', () => {
    const none = () => undefined;
    expect(scriptCommand('C:\\f\\t.sh', 'win32', { bash: none })).toEqual({ error: "needs Git Bash, which isn't found: install Git for Windows, or set BASH to its bash.exe (WSL's bash isn't used)" });
    expect(scriptCommand('C:\\f\\t.sh', 'win32', { bash: () => 'G:\\Git\\bin\\bash.exe' })).toEqual({ cmd: 'G:\\Git\\bin\\bash.exe', args: ['C:\\f\\t.sh'] });
    expect(scriptCommand('C:\\f\\t.cmd', 'win32')).toMatchObject({ args: ['/d', '/s', '/c', '""C:\\f\\t.cmd""'], verbatim: true });
    expect(scriptCommand('C:\\f\\t.ps1', 'win32', { pwsh: () => 'pwsh' })).toEqual({ cmd: 'pwsh', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\f\\t.ps1'] });
    expect(scriptCommand('C:\\f\\t.ps1', 'win32', { pwsh: none })).toEqual({ error: 'needs PowerShell: neither pwsh nor powershell is on PATH' });
    expect(scriptCommand('/f/t.sh', 'linux')).toEqual({ cmd: 'bash', args: ['/f/t.sh'] });
  });

  it.runIf(process.platform === 'win32')('finds Git Bash: $BASH, beside git (<git>/mingw64/libexec/git-core), then the install folders; never system32', () => {
    const files = new Set(['C:\\Git\\bin\\bash.exe', 'C:\\windows\\system32\\bash.exe', 'P:\\Git\\bin\\bash.exe']);
    const exists = (p: string) => files.has(p);
    expect(gitBash({ BASH: 'C:\\windows\\system32\\bash.exe' }, exists, () => 'C:\\Git\\mingw64\\libexec\\git-core')).toBe('C:\\Git\\bin\\bash.exe');
    expect(gitBash({ BASH: 'P:\\Git\\bin\\bash.exe' }, exists, () => 'C:\\Git\\mingw64\\libexec\\git-core')).toBe('P:\\Git\\bin\\bash.exe');
    expect(gitBash({ ProgramFiles: 'P:\\' }, exists, () => undefined)).toBe('P:\\Git\\bin\\bash.exe');
    expect(gitBash({}, exists, () => undefined)).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('really runs .cmd (in a folder with spaces), .ps1 and .sh tests on Windows', () => {
    const d = built({ 'my tests/a.cmd': '@echo off\r\necho cmd ran %FFMPEG_TARGET%\r\nexit /b 0\r\n', 'my tests/b.ps1': 'Write-Output "ps ran $env:FFMPEG_TARGET"; exit 0\n', 'my tests/c.sh': 'echo "sh ran $FFMPEG_TARGET"; [ -n "$BASH_VERSION" ] && [ -z "$WSL_DISTRO_NAME" ]\n' });
    for (const test of ['my tests/a.cmd', 'my tests/b.ps1', 'my tests/c.sh']) {
      const how = scriptCommand(join(d, test));
      if ('error' in how) throw new Error(how.error);
      const r = spawnSync(how.cmd, how.args, { encoding: 'utf8', env: { ...process.env, FFMPEG_TARGET: 't' }, windowsVerbatimArguments: how.verbatim === true });
      expect(r.status, `${test}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('ran t');
    }
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
    // a gplv3 target whose build says lgplv3's flags fails the licence check, naming what is missing
    const wrong = built({}, 'gplv3');
    const w = runTest(folderOf(wrong), data, { target: 't', dist: join(wrong, 'dist'), runnable: ['linux-x64'] });
    expect(w.output).toContain('✗ ffmpeg -buildconf matches gplv3 (missing --enable-gpl)');
  });

  it("check refuses a tests: script that isn't there", () => {
    const d = built({});
    writeFileSync(join(d, 'ffmpeg-build.yml'), 'targets:\n  t: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d], tests: [tests/missing.sh] }\n');
    const r = runCli(['check'], { cwd: d, env: { FFMPEG_BUILD_DATA: fixtureEngineRoot } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('✗ tests: tests/missing.sh: no such file (ffmpeg-build test runs it against the build)');
  });
});
