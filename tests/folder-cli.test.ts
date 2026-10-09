import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureEngineRoot, runCli } from './helpers.ts';

const env = { FFMPEG_BUILD_DATA: fixtureEngineRoot };
const GOOD = [
  'bases:',
  '  common: { with: [dav1d, opus] }',
  '  linux:  { with: [vaapi] }',
  '  gpl:    { with: [x265], without: [opus] }',
  'targets:',
  '  linux-gplv3: { platform: linux-x64, license: gplv3, ffmpeg: 9, base: [common, linux, gpl] }',
  '  win-lgplv3:  { platform: win-x64, license: lgplv3, ffmpeg: 9, base: [common] }',
  '',
].join('\n');

function dir(text: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-folder-cli-'));
  writeFileSync(join(d, 'ffmpeg-build.yml'), text);
  return d;
}

describe('check and plan on targets', () => {
  it('checks each target as one build', () => {
    const r = runCli(['check'], { cwd: dir(GOOD), env });
    expect(r.stdout).toContain('target linux-gplv3 (linux-x64, gplv3, FFmpeg 9)');
    expect(r.stdout).toContain('target win-lgplv3 (win-x64, lgplv3, FFmpeg 9)');
    expect(r.exitCode).toBe(0);
  });

  it("says plainly what a target can't have, and how to fix it", () => {
    const bad = GOOD.replace('base: [common] }', 'base: [common], with: [vaapi, x265] }');
    const r = runCli(['check'], { cwd: dir(bad), env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("vaapi would be in no build at all");
    expect(r.stdout).toContain("✗ lgplv3: x265 is GPL-only (FFmpeg's own classification)");
    expect(r.stdout).toContain('Remove it from this target (it needs license: gplv2, gplv3 or nonfree)');
  });

  it('checks folder pins against what the targets build', () => {
    const r = runCli(['check'], { cwd: dir(`pin:\n  srt: "1.5"\n${GOOD}`), env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('pin srt: no target builds srt; remove the pin');
  });

  it('plans one target', () => {
    const r = runCli(['plan', '--target', 'linux-gplv3'], { cwd: dir(GOOD), env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('linux-gplv3');
    expect(r.stdout).toMatch(/options: +dav1d, vaapi, x265/);
  });
});

describe('show and targets', () => {
  it('shows what a target gets and where each entry came from', () => {
    const r = runCli(['show', 'linux-gplv3'], { cwd: dir(GOOD), env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dav1d    (common)');
    expect(r.stdout).toContain('vaapi    (linux)');
    expect(r.stdout).toContain('x265     (gpl)');
    expect(r.stdout).toContain('not opus (gpl: without)');
  });

  it('show --has --json gives the same answer as data', () => {
    const rows = JSON.parse(runCli(['show', '--has', 'opus', '--json'], { cwd: dir(GOOD), env }).stdout) as { target: string; has: boolean; why: string }[];
    expect(rows).toEqual([
      { target: 'linux-gplv3', has: false, why: 'turned down by gpl' },
      { target: 'win-lgplv3', has: true, why: 'common' },
    ]);
  });

  it('says which targets get something, and why the others do not', () => {
    const r = runCli(['show', '--has', 'vaapi'], { cwd: dir(GOOD), env });
    expect(r.stdout).toContain('linux-gplv3: yes (linux)');
    expect(r.stdout).toContain('win-lgplv3: no (not listed)');
    const opus = runCli(['show', '--has', 'opus'], { cwd: dir(GOOD), env }).stdout;
    expect(opus).toContain('linux-gplv3: no (turned down by gpl)');
    expect(opus).toContain('win-lgplv3: yes (common)');
  });

  it('lists the targets as JSON for CI matrices', () => {
    const r = runCli(['targets', '--json'], { cwd: dir(GOOD), env });
    expect(JSON.parse(r.stdout)).toEqual([
      { name: 'linux-gplv3', platform: 'linux-x64', license: 'gplv3', ffmpeg: '9' },
      { name: 'win-lgplv3', platform: 'win-x64', license: 'lgplv3', ffmpeg: '9' },
    ]);
  });

  it('names an unknown target', () => {
    const r = runCli(['show', 'nope'], { cwd: dir(GOOD), env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('no target nope in ffmpeg-build.yml (targets: linux-gplv3, win-lgplv3)');
  });
});

describe('build --target', () => {
  const noDocker = { ...env, FFMPEG_BUILD_DOCKER: 'ffmpeg-build-no-such-docker' };

  it('needs the lock first', () => {
    const r = runCli(['build', '--target', 'linux-gplv3'], { cwd: dir(GOOD), env: noDocker });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('ffmpeg.lock has no FFmpeg 9 yet; run ffmpeg-build lock first');
  });

  it('names an unknown target', () => {
    const r = runCli(['build', '--target', 'nope'], { cwd: dir(GOOD), env: noDocker });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('no target nope in ffmpeg-build.yml');
  });

  it('builds the target in its platform toolchain, named after the target', () => {
    const d = dir(GOOD);
    writeFileSync(join(d, 'ffmpeg.lock'), 'engine: 0.3.0\nffmpeg: { "9": 9.1.0 }\nlibraries:\n  dav1d: 1.5.4\n  libdrm: 2.4.134\n  libva: 2.24.1\n  opus: 1.6.1\n  x265: 4.1\n');
    const r = runCli(['build', '--target', 'linux-gplv3', '--dry-run'], { cwd: d, env: noDocker });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('would build ffmpeg-9.1.0-linux-gplv3 (linux-x64) in ffmpeg-build-linux-x64');
  });
});
