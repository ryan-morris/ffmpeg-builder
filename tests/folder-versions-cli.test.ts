import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatFolderSummary } from '../src/commands/folder-versions.ts';
import type { FolderChoice } from '../src/folder-choose.ts';
import { formatFolderLock, parseFolderLock } from '../src/lockfile.ts';
import { packageVersion } from '../src/paths.ts';
import { parseFolderText } from '../src/targets.ts';
import { writeEngine } from './helpers.ts';
import { addTag, makeGitRepo, makeScenario, runCliAsync } from './upstream-helpers.ts';

let s: Awaited<ReturnType<typeof makeScenario>>;
beforeEach(async () => { s = await makeScenario(); });
afterEach(() => s.close());

const FOLDER = [
  'bases:',
  '  common: { with: [dav1d] }',
  'targets:',
  '  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, base: [common], with: [x264, libmp3lame] }',
  '  b: { platform: win-x64, license: gplv3, ffmpeg: 9, base: [common], with: [nvenc], pin: { nvenc: "13.0" } }',
  '',
].join('\n');
function folder(text = FOLDER): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-folder-versions-'));
  writeFileSync(join(d, 'ffmpeg-build.yml'), text);
  return d;
}
const lockOf = (d: string) => parseFolderLock(readFileSync(join(d, 'ffmpeg.lock'), 'utf8'), 'ffmpeg.lock');

describe('update and lock on a folder of targets', () => {
  it('writes one lock: each library once, pins met', async () => {
    const d = folder();
    const r = await runCliAsync(['update', '--summary', 'pr.md'], { cwd: d, env: s.env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ffmpeg.lock: updated');
    expect(lockOf(d)).toEqual({
      engine: packageVersion(),
      ffmpeg: { '9': '9.1.0' },
      libraries: { dav1d: '1.5.5', lame: '4.0', 'nv-codec': '13.0.19.1', x264: s.x264.head },
    });
    const pr = readFileSync(join(d, 'pr.md'), 'utf8');
    expect(pr).toContain('| nv-codec | - | 13.0.19.1 | b |'); // only b uses it
    expect(pr).toContain('| dav1d | - | 1.5.5 | |'); // every target does
    expect(pr).toContain('FFmpeg 10 is out; your targets build 9');
    expect((await runCliAsync(['check'], { cwd: d, env: s.env })).exitCode).toBe(0);
  });

  it('leaves out the new-major note when the folder says so', async () => {
    const d = folder(`notify: { new-ffmpeg: false }\n${FOLDER}`);
    await runCliAsync(['update', '--summary', 'pr.md'], { cwd: d, env: s.env });
    expect(readFileSync(join(d, 'pr.md'), 'utf8')).not.toContain('FFmpeg 10 is out');
  });

  it('lock reads no upstream when the lock already fits', async () => {
    const d = folder();
    await runCliAsync(['update'], { cwd: d, env: s.env });
    await s.close();
    const r = await runCliAsync(['lock'], { cwd: d, env: s.env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ffmpeg.lock: no changes');
  });

  it('outdated shows what update would do, and which targets use each library', async () => {
    const d = folder();
    const r = await runCliAsync(['outdated'], { cwd: d, env: s.env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/nv-codec +- +-> 13\.0\.19\.1 +\(b\)/);
    expect(r.stdout).toContain('FFmpeg 10 is out; your targets build 9');
  });
});

describe('update: moving forward, and writing nothing when something fails', () => {
  it('moves forward when upstream does, and says when nothing changed', async () => {
    const d = folder();
    await runCliAsync(['update'], { cwd: d, env: s.env });
    expect((await runCliAsync(['update'], { cwd: d, env: s.env })).stdout).toContain('ffmpeg.lock: no changes');
    addTag(s.dav1d.dir, '1.5.6');
    expect((await runCliAsync(['update'], { cwd: d, env: s.env })).stdout).toContain('ffmpeg.lock: updated');
    expect(lockOf(d).libraries.dav1d).toBe('1.5.6');
  });

  it('lists what it did not apply, and why', async () => {
    const d = folder();
    await runCliAsync(['update', '--summary', 'pr.md'], { cwd: d, env: s.env });
    expect(readFileSync(join(d, 'pr.md'), 'utf8')).toContain('- **nv-codec 13.1.15.0**: outside `13.0` (target b) - needs NVIDIA driver 610+');
  });

  it('writes nothing when an upstream is down, and names the failure', async () => {
    const d = folder();
    await runCliAsync(['update'], { cwd: d, env: s.env });
    const before = readFileSync(join(d, 'ffmpeg.lock'), 'utf8');
    addTag(s.dav1d.dir, '1.5.6');
    await s.close(); // the lame listing is now unreachable
    const r = await runCliAsync(['update'], { cwd: d, env: s.env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/lame: couldn't read http:\/\/127\.0\.0\.1:\d+\/lame\/: /);
    expect(readFileSync(join(d, 'ffmpeg.lock'), 'utf8')).toBe(before);
  });

  it("says the libraries weren't checked when FFmpeg itself can't be read", async () => {
    rmSync(s.ffmpeg.dir, { recursive: true, force: true });
    const r = await runCliAsync(['update'], { cwd: folder(), env: s.env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("FFmpeg: couldn't read");
    expect(r.stdout).toContain("The libraries weren't checked");
  });

  it('refuses targets that fail check, and writes nothing', async () => {
    const d = folder(FOLDER.replace('with: [nvenc]', 'with: [frobnicate]'));
    const r = await runCliAsync(['update'], { cwd: d, env: s.env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('ffmpeg-build doesn\'t know "frobnicate"');
    expect(r.stdout).toContain('Nothing was written.');
    expect(existsSync(join(d, 'ffmpeg.lock'))).toBe(false);
  });

  it('writes nothing, and leaves no .tmp files, when the summary folder is missing', async () => {
    const d = folder();
    const r = await runCliAsync(['update', '--summary', 'missing/pr.md'], { cwd: d, env: s.env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("Couldn't write missing/pr.md: its folder doesn't exist. Nothing was written.");
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(join(d, 'ffmpeg.lock'))).toBe(false);
  });
});

describe('update with ffmpeg: latest', () => {
  it('stays on the locked major when the next one would lose something a target asks for', async () => {
    const ffmpeg = makeGitRepo(['n8.1.0', 'n9.0.0']);
    const ra = makeGitRepo(['v1.0']);
    const recipe = (n: string, url: string) => `name: ${n}\nlicense: MIT\nsource: { git: ${url} }\nversions: { git-tags: '^v(\\d+\\.\\d+)$' }\nplatforms: all\n`;
    const engine = writeEngine({
      'ffmpeg/source.yml': `git: ${ffmpeg.url}\nversions: { git-tags: '^n(\\d+\\.\\d+(?:\\.\\d+)?)$' }\nurl: ${ffmpeg.url}/ffmpeg-{version}.tar.xz\n`,
      'ffmpeg/8.yml': 'major: 8\nreleases: [8.1.0]\noptions:\n  a: { needs: ra }\n  b: { needs: rb }\n',
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: ra }\n',
      'recipes/ra/recipe.yml': recipe('ra', ra.url),
      'recipes/rb/recipe.yml': recipe('rb', ra.url),
    });
    const d = folder('targets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: latest, with: [b] }\n');
    writeFileSync(join(d, 'ffmpeg.lock'), formatFolderLock({ engine: '0.2.0', ffmpeg: { latest: '8.1.0' }, libraries: { rb: '1.0' } }));
    const r = await runCliAsync(['update', '--summary', 'pr.md'], { cwd: d, env: { FFMPEG_BUILD_DATA: engine } });
    expect(r.stdout).toContain('ffmpeg.lock: no changes');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(d, 'pr.md'), 'utf8')).toContain("- **FFmpeg 9.0.0**: b wouldn't be available on FFmpeg 9");
  });
});

describe('outdated', () => {
  it('prints the same rows as JSON with --json', async () => {
    const r = await runCliAsync(['outdated', '--json'], { cwd: folder(), env: s.env });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { rows: { what: string; to: string }[] };
    expect(out.rows.find((row) => row.what === 'dav1d')!.to).toBe('1.5.5');
  });

  it('says up to date after an update, and shows the new version once upstream moves', async () => {
    const d = folder();
    await runCliAsync(['update'], { cwd: d, env: s.env });
    const same = await runCliAsync(['outdated'], { cwd: d, env: s.env });
    expect(same.stdout).toMatch(/\n {2}dav1d +1\.5\.5 +up to date\n/);
    expect(same.stdout).toContain('Everything is up to date.');
    expect(same.stdout).toContain(s.x264.head.slice(0, 12));
    expect(same.stdout).not.toContain(s.x264.head);
    expect(existsSync(join(d, 'pr.md'))).toBe(false);
    addTag(s.dav1d.dir, '1.5.6');
    expect((await runCliAsync(['outdated'], { cwd: d, env: s.env })).stdout).toMatch(/\n {2}dav1d +1\.5\.5 +-> 1\.5\.6\n/);
  });
});

describe('check and plan with a lock', () => {
  it('plan shows exact versions; check passes', async () => {
    const d = folder();
    await runCliAsync(['update'], { cwd: d, env: s.env });
    expect((await runCliAsync(['check'], { cwd: d, env: s.env })).exitCode).toBe(0);
    const plan = await runCliAsync(['plan', '--target', 'b'], { cwd: d, env: s.env });
    expect(plan.stdout).toContain('dav1d 1.5.5');
    expect(plan.stdout).toContain('nv-codec 13.0.19.1');
    const json = JSON.parse((await runCliAsync(['plan', '--json'], { cwd: d, env: s.env })).stdout) as { target: string; builds: { versions: Record<string, string> }[] }[];
    expect(json.find((t) => t.target === 'b')!.builds[0]!.versions['nv-codec']).toBe('13.0.19.1');
  });

  it('check says when the lock no longer matches the targets', async () => {
    const d = folder();
    await runCliAsync(['update'], { cwd: d, env: s.env });
    writeFileSync(join(d, 'ffmpeg-build.yml'), `pin: { dav1d: "1.4" }\n${FOLDER}`);
    const r = await runCliAsync(['check'], { cwd: d, env: s.env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("ffmpeg.lock doesn't match the targets; run ffmpeg-build lock");
  });

  it('stops with a plain message on a broken lock, without touching it', async () => {
    const d = folder();
    const broken = '<<<<<<< HEAD\nengine: 0.2.0\n=======\nengine: 0.2.1\n>>>>>>> other\n';
    writeFileSync(join(d, 'ffmpeg.lock'), broken);
    for (const cmd of ['check', 'plan', 'update', 'lock']) {
      const r = await runCliAsync([cmd], { cwd: d, env: s.env });
      expect(r.exitCode, cmd).toBe(2);
      expect(r.stdout, cmd).toMatch(/^ffmpeg\.lock:\d+: .*resolve the conflict, or delete it and run ffmpeg-build lock/m);
    }
    expect(readFileSync(join(d, 'ffmpeg.lock'), 'utf8')).toBe(broken);
  });

  it('checks that a pin suits how the library is released', async () => {
    const d = folder(`pin: { x264: "1.2", dav1d: b35605ace3ddf7c1a5d67a2eb553f034aef41d55 }\n${FOLDER}`);
    const r = await runCliAsync(['check'], { cwd: d, env: s.env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('x264 has no releases (it follows the stable branch), so pin it to a full commit hash.');
    expect(r.stdout).toContain('dav1d has releases, so pin a version or range like 1.5 or ~1.5.4, not a commit.');
  });
});

describe('formatFolderSummary', () => {
  it('calls out a new FFmpeg minor and says when there is nothing to do', () => {
    const parsed = parseFolderText(FOLDER, '.');
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const minor = { what: 'FFmpeg 9', from: '9.0.2', to: '9.1.0', newMinor: { from: '9.0', to: '9.1', adds: ['amf', 'whep'], missing: ['amf'], missingIn: { amf: ['a'] } } };
    const choice = (rows: FolderChoice['rows']): FolderChoice => ({ lock: { ffmpeg: {}, libraries: {} }, rows, missing: [], errors: [] });
    const text = formatFolderSummary(parsed.folder, choice([minor]));
    expect(text).toContain('## ⚠ New FFmpeg minor: 9.0 -> 9.1');
    expect(text).toContain('- new: `amf` (not in a: `ffmpeg-build profile add amf --to <base or target>`), `whep`');
    expect(text).toContain('To stay on 9.0.x, write `ffmpeg: "9.0"` on them.');
    expect(text).toContain('| FFmpeg 9 | 9.0.2 | **9.1.0** | |');
    expect(formatFolderSummary(parsed.folder, choice([{ what: 'srt', from: '1.5.7', to: '1.5.7' }]))).toContain('Nothing to update.');
  });
});

describe('the removal guard in update', () => {
  it('refuses, writing nothing, when a target would lose something its last release had', async () => {
    const { fakeGitHub } = await import('./github-fake.ts');
    const gh = await fakeGitHub();
    try {
      gh.publish('9.1.0.0', [{ name: 'a', platform: 'linux-x64', components: { dav1d: '1.5.5', lame: '4.0', x264: 'abc', zimg: '3.0' } }]);
      const d = folder();
      const r = await runCliAsync(['update'], { cwd: d, env: { ...s.env, ...gh.env, GITHUB_REPOSITORY: 'o/r' } });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('✗ a: zimg was in 9.1.0.0 and is gone now; if that is intended, add allow-removal: [zimg] to the target');
      expect(r.stdout).toContain('Nothing was written.');
      expect(existsSync(join(d, 'ffmpeg.lock'))).toBe(false);
    } finally {
      await gh.close();
    }
  });
});
