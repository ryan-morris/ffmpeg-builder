import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { swapIn } from '../src/commands/migrate.ts';
import { formatLock, parseFolderLock } from '../src/lockfile.ts';
import { fixtureEngineRoot, runCli } from './helpers.ts';

const env = { FFMPEG_BUILD_DATA: fixtureEngineRoot };
const DVR = 'name: dvr\nffmpeg: 9\nplatforms: [linux-x64, win-x64]\nlicense: gplv3\nwith: [dav1d, x265, nvenc: { platforms: [win-x64] }]\nwithout: [opus]\n';
const OSS = 'name: oss\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [dav1d, opus]\n';

function folder(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-migrate-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}
const v1 = (dvrDav1d: string) =>
  formatLock({
    engine: '0.2.0',
    profiles: {
      dvr: { ffmpeg: { '9': '9.0.2' }, libraries: { dav1d: dvrDav1d, x265: '4.1', 'nv-codec': '13.0.19.1' }, pinned: [] },
      oss: { ffmpeg: { '9': '9.0.2' }, libraries: { dav1d: '1.5.4', opus: '1.6.1' }, pinned: [] },
    },
  });

describe('ffmpeg-build migrate', () => {
  it('writes ffmpeg-build.yml and one lock, keeps the old files as .old, and the result checks', () => {
    const d = folder({ 'dvr.yml': DVR, 'oss.yml': OSS, 'ffmpeg.lock': v1('1.5.4'), 'notes.yml': 'just: data\n' });
    const r = runCli(['migrate'], { cwd: d, env });
    expect(r.stdout).toContain('wrote ffmpeg-build.yml: linux-x64-dvr, linux-x64-oss, win-x64-dvr');
    expect(r.stdout).toContain('kept the old files as dvr.yml.old, oss.yml.old, ffmpeg.lock.old');
    expect(r.exitCode).toBe(0);
    for (const f of ['dvr.yml', 'oss.yml']) expect(existsSync(join(d, f))).toBe(false);
    expect(existsSync(join(d, 'notes.yml'))).toBe(true); // not a profile: left alone
    expect(readFileSync(join(d, 'dvr.yml.old'), 'utf8')).toBe(DVR);
    const lock = parseFolderLock(readFileSync(join(d, 'ffmpeg.lock'), 'utf8'), 'ffmpeg.lock');
    expect(lock.ffmpeg).toEqual({ '9': '9.0.2' });
    expect(lock.libraries).toEqual({ dav1d: '1.5.4', x265: '4.1', 'nv-codec': '13.0.19.1', opus: '1.6.1' });
    const check = runCli(['check'], { cwd: d, env });
    expect(check.stdout).toContain('target win-x64-dvr');
    expect(check.stdout).not.toContain('✗');
  });

  it("refuses when the profiles' locks disagree, and changes nothing", () => {
    const d = folder({ 'dvr.yml': DVR, 'oss.yml': OSS, 'ffmpeg.lock': v1('1.4.1') });
    const r = runCli(['migrate'], { cwd: d, env });
    expect(r.stdout).toContain("can't migrate: dav1d is locked at 1.4.1 for dvr and 1.5.4 for oss");
    expect(r.exitCode).toBe(2);
    expect(existsSync(join(d, 'ffmpeg-build.yml'))).toBe(false);
    expect(readFileSync(join(d, 'dvr.yml'), 'utf8')).toBe(DVR);
  });

  it('refuses in a folder that already has ffmpeg-build.yml, or has no profiles', () => {
    expect(runCli(['migrate'], { cwd: folder({ 'ffmpeg-build.yml': 'targets: {}\n', 'dvr.yml': DVR }), env }).stdout).toContain('ffmpeg-build.yml is already here');
    const none = runCli(['migrate'], { cwd: folder({ 'notes.yml': 'just: data\n' }), env });
    expect(none.stdout).toContain('no old profiles here to migrate');
    expect(none.exitCode).toBe(2);
  });

  it('refuses until check passes on the old profiles, so nothing they list is lost', () => {
    const d = folder({ 'dvr.yml': DVR.replace('x265', 'x264') });
    const r = runCli(['migrate'], { cwd: d, env });
    expect(r.stdout).toContain("can't migrate until check passes on the old profiles");
    expect(r.stdout).toContain('ffmpeg-build doesn\'t know "x264"');
    expect(r.exitCode).toBe(2);
    expect(existsSync(join(d, 'ffmpeg-build.yml'))).toBe(false);
  });

  it('takes an old profile saved as ffmpeg-build.yml, which every other command points at migrate', () => {
    const d = folder({ 'ffmpeg-build.yml': OSS });
    const check = runCli(['check'], { cwd: d, env });
    expect(check.exitCode).toBe(2);
    expect(check.stdout).toContain('ffmpeg-build.yml is an old matrix profile');
    const r = runCli(['migrate'], { cwd: d, env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('kept the old files as ffmpeg-build.yml.old');
    expect(readFileSync(join(d, 'ffmpeg-build.yml.old'), 'utf8')).toBe(OSS);
    expect(readFileSync(join(d, 'ffmpeg-build.yml'), 'utf8')).toContain('linux-x64-lgplv3:');
  });

  it('puts everything back when a step fails part way', () => {
    const d = folder({ 'a.yml': 'a', 'ffmpeg.lock': 'old lock' });
    const cwd = process.cwd();
    process.chdir(d);
    try {
      // the second old file is missing, so moving it fails after a.yml has moved
      expect(() => swapIn([{ path: 'ffmpeg-build.yml', text: 'new' }, { path: 'ffmpeg.lock', text: 'new lock' }], ['a.yml', 'b.yml'])).toThrow(/Couldn't migrate: .*Nothing was changed\./);
    } finally {
      process.chdir(cwd);
    }
    expect(readdirSync(d).sort()).toEqual(['a.yml', 'ffmpeg.lock']);
    expect(readFileSync(join(d, 'ffmpeg.lock'), 'utf8')).toBe('old lock');
  });

  it('migrates without a lock', () => {
    const d = folder({ 'oss.yml': OSS });
    expect(runCli(['migrate'], { cwd: d, env }).exitCode).toBe(0);
    expect(existsSync(join(d, 'ffmpeg.lock'))).toBe(false);
    expect(readFileSync(join(d, 'ffmpeg-build.yml'), 'utf8')).toContain('linux-x64-lgplv3:');
  });
});
