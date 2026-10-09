import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchRelease, parsePin, parseTag, updatePin } from '../src/fetch.ts';
import { formatManifest, parseManifest } from '../src/manifest.ts';
import { readTarGz } from '../src/untar.ts';
import { fakeGitHub, tarGz, type FakeGitHub, type FakeTarget } from './github-fake.ts';
import { runCliAsync } from './upstream-helpers.ts';

let gh: FakeGitHub;
beforeEach(async () => { gh = await fakeGitHub(); });
afterEach(async () => {
  delete process.env.GITHUB_TOKEN;
  await gh.close();
});
const publish = (tag: string, targets: (FakeTarget & { runtime: Buffer })[], extra = {}) => gh.publish(tag, targets, extra);
const runtime = (version: string) => tarGz([{ name: 'bin', type: 'dir' }, { name: 'bin/ffmpeg', data: `ffmpeg ${version}`, mode: 0o755 }, { name: 'libavutil.so', type: 'symlink', link: 'libavutil.so.60' }, { name: 'libavutil.so.60', data: 'lib' }]);

describe('the manifest', () => {
  it('reads back what it writes, and names what is wrong with a hand-made one', () => {
    const m = publish('9.0.2.3', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: runtime('9.0.2') }]);
    expect(parseManifest(formatManifest(m))).toEqual(m);
    expect(() => parseManifest('release: x\n')).toThrow(/manifest.yml: not a manifest \(ffmpeg: /);
  });
});

describe('ffmpeg-build fetch', () => {
  it('downloads the target, checks it, unpacks it, and does nothing the second time', async () => {
    publish('9.0.2.3', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: runtime('9.0.2') }, { name: 'win-x64-lgplv3', platform: 'win-x64', runtime: runtime('win') }]);
    const out = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-')), 'vendor', 'ffmpeg');
    expect(await fetchRelease('o/r@9.0.2.3', { platform: 'linux-x64', dev: true }, out)).toContain('linux-x64-lgplv3 from o/r@9.0.2.3 (with the dev archive)');
    expect(readFileSync(join(out, 'bin', 'ffmpeg'), 'utf8')).toBe('ffmpeg 9.0.2');
    expect(existsSync(join(out, 'include', 'libavutil', 'avutil.h'))).toBe(true);
    expect(readFileSync(join(out, 'libavutil.so'), 'utf8')).toBe('lib'); // the link (or its copy where links aren't allowed)
    expect(await fetchRelease('o/r@9.0.2.3', { platform: 'linux-x64', dev: true }, out)).toContain('already linux-x64-lgplv3');
  });

  it('replaces an older fetch whole, so nothing stale is left', async () => {
    publish('9.0.2.3', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: tarGz([{ name: 'old-only.txt', data: 'x' }]) }]);
    publish('9.0.2.4', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: runtime('9.0.2') }]);
    const out = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-')), 'ffmpeg');
    await fetchRelease('o/r@9.0.2.3', { target: 'linux-x64-lgplv3' }, out);
    await fetchRelease('o/r@9.0.2.4', { target: 'linux-x64-lgplv3' }, out);
    expect(existsSync(join(out, 'old-only.txt'))).toBe(false);
    expect(existsSync(join(out, 'bin', 'ffmpeg'))).toBe(true);
  });

  it('refuses an archive whose checksum differs, or that writes outside its folder, and unpacks nothing', async () => {
    const m = publish('9.0.2.3', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: runtime('9.0.2') }]);
    gh.releases[0]!.files[m.targets[0]!.assets.runtime.name] = runtime('tampered');
    const out = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-')), 'ffmpeg');
    await expect(fetchRelease('o/r@9.0.2.3', { target: 'linux-x64-lgplv3' }, out)).rejects.toThrow(/checksum mismatch .*nothing was unpacked/);
    expect(existsSync(out)).toBe(false);
    for (const [i, hostile] of [
      tarGz([{ name: '../escape.txt', data: 'x' }]),
      tarGz([{ name: '/etc/evil', data: 'x' }]),
      tarGz([{ name: 'link', type: 'symlink', link: '../../outside' }]),
    ].entries()) {
      publish(`9.0.2.${10 + i}`, [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: hostile }]);
      await expect(fetchRelease(`o/r@9.0.2.${10 + i}`, { target: 'linux-x64-lgplv3' }, out)).rejects.toThrow(/refusing to unpack linux-x64-lgplv3: /);
      expect(existsSync(out)).toBe(false);
    }
  });

  it('says when a release tag was reused with different files', async () => {
    publish('9.0.2.3', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: runtime('9.0.2') }]);
    const out = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-')), 'ffmpeg');
    await fetchRelease('o/r@9.0.2.3', { target: 'linux-x64-lgplv3' }, out);
    gh.releases.length = 0;
    publish('9.0.2.3', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: runtime('rebuilt') }]);
    await expect(fetchRelease('o/r@9.0.2.3', { target: 'linux-x64-lgplv3' }, out)).rejects.toThrow(/changed since it was fetched/);
  });

  it('names the targets there are, and sends the token for private repositories', async () => {
    publish('9.0.2.3', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: runtime('a') }, { name: 'linux-x64-gplv3', platform: 'linux-x64', runtime: runtime('b') }]);
    const out = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-')), 'ffmpeg');
    await expect(fetchRelease('o/r@9.0.2.3', { platform: 'linux-x64' }, out)).rejects.toThrow('has 2 targets for linux-x64; name one with --target (linux-x64-lgplv3, linux-x64-gplv3)');
    await expect(fetchRelease('o/r@9.0.2.3', { target: 'osx' }, out)).rejects.toThrow('has no target osx (it has linux-x64-lgplv3, linux-x64-gplv3)');
    process.env.GITHUB_TOKEN = 'secret';
    await expect(fetchRelease('o/r@9.9.9.9', { target: 'x' }, out)).rejects.toThrow('release o/r@9.9.9.9 not found');
    expect(gh.seenAuth.at(-1)).toBe('Bearer secret');
  });

  it('reads pins and tags', () => {
    expect(parsePin('devenvy/ffmpeg@9.0.2.3\n')).toEqual({ repo: 'devenvy/ffmpeg', tag: '9.0.2.3' });
    expect(() => parsePin('9.0.2.3')).toThrow('write it as owner/repo@tag');
    expect(parseTag('dvr-9.1.0.0')).toEqual({ group: 'dvr', ffmpeg: '9.1.0', build: 0 });
    expect(parseTag('9.0.2.3')).toEqual({ group: '', ffmpeg: '9.0.2', build: 3 });
  });
});

describe('ffmpeg-build fetch --update', () => {
  it('moves the pin to the newest release of the same group and FFmpeg major that has the target', async () => {
    const t = (n: string) => [{ name: n, platform: 'linux-x64', runtime: runtime('x') }];
    publish('9.0.2.3', t('linux-x64-lgplv3'));
    publish('9.1.0.0', t('linux-x64-lgplv3'));
    publish('9.1.0.1', t('linux-x64-lgplv3'), { prerelease: true });
    publish('9.1.0.2', t('linux-x64-gplv3')); // newer, but without the target
    publish('10.0.0.0', t('linux-x64-lgplv3')); // a new major is never taken
    publish('dvr-9.2.0.0', t('linux-x64-lgplv3')); // another group
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pin-'));
    const pin = join(dir, 'ffmpeg.version');
    writeFileSync(pin, 'o/r@9.0.2.3\n');
    expect(await updatePin(pin, { target: 'linux-x64-lgplv3' })).toBe('FFmpeg build 9.0.2.3 -> 9.1.0.0 (linux-x64-lgplv3, o/r)');
    expect(readFileSync(pin, 'utf8')).toBe('o/r@9.1.0.0\n');
    expect(await updatePin(pin, { target: 'linux-x64-lgplv3' })).toBeUndefined();
  });

  it('reads every page of gh.releases', async () => {
    for (let b = 0; b < 130; b++) publish(`9.0.2.${b}`, [{ name: 't', platform: 'linux-x64', runtime: runtime('x') }]);
    const pin = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-pin-')), 'ffmpeg.version');
    writeFileSync(pin, 'o/r@9.0.2.0\n');
    expect(await updatePin(pin, { target: 't' })).toBe('FFmpeg build 9.0.2.0 -> 9.0.2.129 (t, o/r)');
  });
});

describe('the fetch command', () => {
  it('takes the pin or a pin file, and exits 1 on a checksum mismatch', async () => {
    const m = publish('9.0.2.3', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', runtime: runtime('9.0.2') }]);
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-cli-'));
    writeFileSync(join(dir, 'ffmpeg.version'), 'o/r@9.0.2.3\n');
    const r = await runCliAsync(['fetch', 'ffmpeg.version', '--platform', 'linux-x64', '--out', 'vendor/ffmpeg'], { cwd: dir, env: gh.env });
    expect(r.stdout).toContain('vendor/ffmpeg: linux-x64-lgplv3 from o/r@9.0.2.3');
    expect(r.exitCode).toBe(0);
    gh.releases[0]!.files[m.targets[0]!.assets.runtime.name] = runtime('tampered');
    const bad = await runCliAsync(['fetch', 'o/r@9.0.2.3', '--target', 'linux-x64-lgplv3', '--out', 'other'], { cwd: dir, env: gh.env });
    expect(bad.exitCode).toBe(1);
    const usage = await runCliAsync(['fetch', 'o/r@9.0.2.3', '--out', 'x'], { cwd: dir, env: gh.env });
    expect(usage.exitCode).toBe(2);
    expect(usage.stdout).toContain('say what to fetch: --target <name>');
  });

  it('--update rewrites the pin file and prints the change, or says it is current', async () => {
    publish('9.0.2.3', [{ name: 't', platform: 'linux-x64', runtime: runtime('x') }]);
    publish('9.0.2.4', [{ name: 't', platform: 'linux-x64', runtime: runtime('y') }]);
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-cli-'));
    writeFileSync(join(dir, 'ffmpeg.version'), 'o/r@9.0.2.3\n');
    const r = await runCliAsync(['fetch', '--update', 'ffmpeg.version', '--target', 't'], { cwd: dir, env: gh.env });
    expect(r.stdout).toContain('FFmpeg build 9.0.2.3 -> 9.0.2.4 (t, o/r)');
    expect(r.exitCode).toBe(0);
    expect((await runCliAsync(['fetch', '--update', 'ffmpeg.version', '--target', 't'], { cwd: dir, env: gh.env })).stdout).toContain('ffmpeg.version: up to date (o/r@9.0.2.4)');
  });
});

describe('reading archives', () => {
  it('reads GNU long names', () => {
    const long = `${'d'.repeat(120)}/file.txt`;
    const [entry] = readTarGz(tarGz([{ name: long, data: 'y' }]));
    expect([entry!.name, entry!.data.toString()]).toEqual([long, 'y']);
  });
});

describe('fetch review fixes', () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-')), 'ffmpeg');
  const pax = (records: Record<string, string>) =>
    Object.entries(records).map(([k, v]) => {
      const body = ` ${k}=${v}\n`;
      let len = body.length + 1;
      while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
      return `${len}${body}`;
    }).join('');

  it('refuses every way out of the folder: dotted links, pax and long names, backslashes, drives, empty names, hard links to folders', async () => {
    const hostile = [
      tarGz([{ name: 's/a', type: 'symlink', link: '..' }]),
      tarGz([{ name: 'x', type: 'pax', data: pax({ path: '../escape' }) }, { name: 'innocent', data: 'x' }]),
      tarGz([{ name: `${'d/'.repeat(60)}../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../out`, data: 'x' }]),
      tarGz([{ name: 'a\\..\\..\\b', data: 'x' }]),
      tarGz([{ name: 'C:/Windows/evil', data: 'x' }]),
      tarGz([{ name: '', data: 'x' }]),
      tarGz([{ name: 'dir', type: 'dir' }, { name: 'h', type: 'hardlink', link: 'dir' }]),
    ];
    for (const [i, archive] of hostile.entries()) {
      publish(`9.0.2.${20 + i}`, [{ name: 't', platform: 'linux-x64', runtime: archive }]);
      const out = fresh();
      await expect(fetchRelease(`o/r@9.0.2.${20 + i}`, { target: 't' }, out), `archive ${i}`).rejects.toThrow(/refusing to unpack t: /);
      expect(existsSync(out), `archive ${i}`).toBe(false);
    }
  });

  it("never writes the dev archive's files through a link the runtime archive made", async () => {
    publish('9.0.2.3', [{
      name: 't', platform: 'linux-x64',
      runtime: tarGz([{ name: 'sub', type: 'dir' }, { name: 'lib', type: 'symlink', link: 'sub' }]),
      dev: tarGz([{ name: 'lib/x.h', data: 'x' }]),
    }]);
    await expect(fetchRelease('o/r@9.0.2.3', { target: 't', dev: true }, fresh())).rejects.toThrow(/lib.*goes through a link/);
  });

  it('copies a hard link to a file of the archive', async () => {
    publish('9.0.2.3', [{ name: 't', platform: 'linux-x64', runtime: tarGz([{ name: 'a', data: 'same' }, { name: 'b', type: 'hardlink', link: 'a' }]) }]);
    const out = fresh();
    await fetchRelease('o/r@9.0.2.3', { target: 't' }, out);
    expect(readFileSync(join(out, 'b'), 'utf8')).toBe('same');
  });

  it("won't replace a folder it didn't make, the current folder, or a parent of it", async () => {
    publish('9.0.2.3', [{ name: 't', platform: 'linux-x64', runtime: runtime('x') }]);
    const out = fresh();
    mkdirSync(out);
    writeFileSync(join(out, 'my-code.c'), 'precious');
    await expect(fetchRelease('o/r@9.0.2.3', { target: 't' }, out)).rejects.toThrow(/already holds files fetch didn't put there/);
    expect(readFileSync(join(out, 'my-code.c'), 'utf8')).toBe('precious');
    await expect(fetchRelease('o/r@9.0.2.3', { target: 't' }, process.cwd())).rejects.toThrow(/is this folder or one that holds it/);
    await expect(fetchRelease('o/r@9.0.2.3', { target: 't' }, join(process.cwd(), '..'))).rejects.toThrow(/is this folder or one that holds it/);
  });

  it('puts back the earlier fetch when a run died between its two renames', async () => {
    publish('9.0.2.3', [{ name: 't', platform: 'linux-x64', runtime: runtime('x') }]);
    const out = fresh();
    await fetchRelease('o/r@9.0.2.3', { target: 't' }, out);
    const old = join(out, '..', '.ffmpeg.old');
    const { renameSync } = await import('node:fs');
    renameSync(out, old);
    expect(await fetchRelease('o/r@9.0.2.3', { target: 't' }, out)).toContain('already t');
    expect(existsSync(old)).toBe(false);
  });

  it('orders FFmpeg versions by their numbers, whatever their length', async () => {
    publish('8.0.5', [{ name: 't', platform: 'linux-x64', runtime: runtime('x') }]);
    publish('8.0.1.2', [{ name: 't', platform: 'linux-x64', runtime: runtime('y') }]);
    const pin = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-pin-')), 'ffmpeg.version');
    writeFileSync(pin, 'o/r@8.0.5\n');
    expect(await updatePin(pin, { target: 't' })).toBe('FFmpeg build 8.0.5 -> 8.0.1.2 (t, o/r)');
  });

  it('skips a newer release without a readable manifest', async () => {
    publish('9.0.2.3', [{ name: 't', platform: 'linux-x64', runtime: runtime('x') }]);
    publish('9.0.2.4', [{ name: 't', platform: 'linux-x64', runtime: runtime('y') }]);
    gh.releases.push({ tag: '9.0.2.5', files: { 'manifest.yml': Buffer.from('not: a manifest\n') } });
    const pin = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-pin-')), 'ffmpeg.version');
    writeFileSync(pin, 'o/r@9.0.2.3\n');
    expect(await updatePin(pin, { target: 't' })).toBe('FFmpeg build 9.0.2.3 -> 9.0.2.4 (t, o/r)');
  });

  it('keeps the token to the API host, and refuses plain http elsewhere and dotted repository names', async () => {
    publish('9.0.2.3', [{ name: 't', platform: 'linux-x64', runtime: runtime('x') }]);
    process.env.GITHUB_TOKEN = 'secret';
    // the API by name, the assets by address: another origin
    process.env.FFMPEG_BUILD_GITHUB_API = gh.base.replace('127.0.0.1', 'localhost');
    await fetchRelease('o/r@9.0.2.3', { target: 't' }, fresh());
    expect(gh.requests.filter((r) => r.path.startsWith('/repos/')).every((r) => r.auth)).toBe(true);
    expect(gh.requests.filter((r) => r.path.startsWith('/assets/')).some((r) => r.auth)).toBe(false);
    process.env.FFMPEG_BUILD_GITHUB_API = 'http://example.invalid';
    await expect(fetchRelease('o/r@9.0.2.3', { target: 't' }, fresh())).rejects.toThrow('refusing to download over http:');
    expect(() => parsePin('../..@9.0.2.3')).toThrow('is not a release pin');
  });

  it('says plainly when the pin file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-fetch-cli-'));
    const r = await runCliAsync(['fetch', '--update', 'nope.version', '--target', 't'], { cwd: dir, env: gh.env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("can't read the pin file nope.version");
  });
});
