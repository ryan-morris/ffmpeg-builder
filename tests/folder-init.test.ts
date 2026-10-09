import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEngineData } from '../src/engine-data.ts';
import { initFolder, shippedFolder } from '../src/folder-init.ts';
import { packageRoot } from '../src/paths.ts';
import { planProfile } from '../src/resolve.ts';
import { parseFolderText, targetProfile } from '../src/targets.ts';
import { runCli } from './helpers.ts';

const data = loadEngineData(packageRoot);
const shipped = shippedFolder('devenvy');
const parse = (text: string) => {
  const r = parseFolderText(text, '.');
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.folder;
};
const summary = (folder: ReturnType<typeof parse>, name: string) => {
  const cell = planProfile(targetProfile(folder, folder.targets.find((t) => t.name === name)!), data, { '9': '9.0.2', '8': '8.1.3' }).cells[0]!;
  return { options: [...cell.options].sort(), recipes: [...cell.recipes].sort() };
};

describe('init from the shipped targets', () => {
  it('takes the targets the selection names, on the newest FFmpeg by default, and builds them as shipped', () => {
    const folder = parse(initFolder(shipped, { license: ['lgplv3', 'gplv3'], platforms: ['linux-x64', 'linux-musl-x64'] }));
    expect(folder.targets.map((t) => t.name)).toEqual(['linux-musl-x64-gplv3', 'linux-musl-x64-lgplv3', 'linux-x64-gplv3', 'linux-x64-lgplv3']);
    for (const t of folder.targets) expect(summary(folder, t.name), t.name).toEqual(summary(shipped, t.name));
    expect(Object.keys(folder.bases)).toContain('common');
  });

  it('writes a single target without bases', () => {
    const text = initFolder(shipped, { license: ['lgplv3'], platforms: ['win-x64'] });
    expect(text).not.toContain('bases:');
    const folder = parse(text);
    expect(summary(folder, 'win-x64-lgplv3')).toEqual(summary(shipped, 'win-x64-lgplv3'));
  });

  it('takes older series when asked, and FFmpeg latest as the newest series written latest', () => {
    expect(parse(initFolder(shipped, { license: ['lgplv3'], platforms: ['osx-arm64'], ffmpeg: ['8', '9'] })).targets.map((t) => t.name))
      .toEqual(['osx-arm64-lgplv3', 'osx-arm64-lgplv3-ffmpeg8']);
    const latest = parse(initFolder(shipped, { license: ['lgplv3'], platforms: ['osx-arm64'], ffmpeg: ['latest'] }));
    expect(latest.targets.map((t) => [t.name, t.ffmpeg])).toEqual([['osx-arm64-lgplv3', 'latest']]);
  });

  it('--empty writes bare targets', () => {
    const folder = parse(initFolder(shipped, { license: ['gplv2'], platforms: ['linux-x64', 'win-x64'], empty: true }));
    expect(folder.targets.map((t) => [t.name, t.with])).toEqual([['linux-x64-gplv2', []], ['win-x64-gplv2', []]]);
    expect(folder.bases).toEqual({});
  });

  it('says what it has when the selection matches nothing', () => {
    expect(() => initFolder(shipped, { platforms: ['amiga-*'] })).toThrow(/no shipped target is on amiga-\*; the shipped platforms are .*linux-x64/);
    expect(() => initFolder(shipped, { ffmpeg: ['4'] })).toThrow(/no shipped target builds FFmpeg 4; they build 8, 9 or latest/);
  });
});

describe('ffmpeg-build init', () => {
  it('names a --from that is not a shipped targets file as a usage error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-init-from-'));
    const none = runCli(['init', '--from', 'nope'], { cwd: dir });
    expect(none.exitCode).toBe(2);
    expect(none.stdout).toContain('there is no shipped targets file nope; use --from devenvy');
    expect(existsSync(join(dir, 'ffmpeg-build.yml'))).toBe(false);
  });

  it('writes ffmpeg-build.yml, checks it, and never overwrites one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-init-'));
    const r = runCli(['init', '--license', 'lgplv3', '--platforms', 'linux-x64,win-x64'], { cwd: dir });
    expect(r.stdout).toContain('wrote ffmpeg-build.yml: linux-x64-lgplv3, win-x64-lgplv3');
    expect(r.stdout).not.toContain('✗');
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dir, 'ffmpeg-build.yml'))).toBe(true);
    const before = readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8');
    const again = runCli(['init'], { cwd: dir });
    expect(again.stdout).toContain('ffmpeg-build.yml already exists');
    expect(again.exitCode).toBe(2);
    expect(readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8')).toBe(before);
  });
});
