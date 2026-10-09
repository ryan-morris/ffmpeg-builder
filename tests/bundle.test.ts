import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { fetchRelease } from '../src/fetch.ts';
import { formatFolderLock, type FolderLock } from '../src/lockfile.ts';
import { parseManifest } from '../src/manifest.ts';
import { packageRoot, packageVersion } from '../src/paths.ts';
import { planReleases } from '../src/release.ts';
import { artifactName, loadFolder, type Folder } from '../src/targets.ts';
import { readTarGz } from '../src/untar.ts';
import { fakeGitHub, tarGz, type FakeGitHub } from './github-fake.ts';
import { fixtureEngineRoot } from './helpers.ts';

const data = loadEngineData(fixtureEngineRoot);
const LOCK: FolderLock = { engine: '0.2.0', ffmpeg: { '9': '9.1.0' }, libraries: { dav1d: '1.5.4', opus: '1.6.1', x265: '4.1' } };
const FOLDER = [
  'targets:',
  '  linux-x64-lgplv3: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d, opus] }',
  '  linux-x64-gplv3:  { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [dav1d, x265] }',
  '',
].join('\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A folder with its targets "built" into dist: archives, sources.json and the kept sources, as the driver leaves them. */
function builtFolder(text = FOLDER, edit: (name: string, sources: { libraries: { name: string; version: string }[] }) => void = () => {}): { dir: string; dist: string; folder: Folder } {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-bundle-'));
  writeFileSync(join(dir, 'ffmpeg-build.yml'), text);
  writeFileSync(join(dir, 'ffmpeg.lock'), formatFolderLock(LOCK));
  const r = loadFolder(dir);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const dist = join(dir, 'dist');
  mkdirSync(dist);
  for (const rel of planReleases(r.folder, data, LOCK, packageRoot).releases) {
    for (const p of rel.targets) {
      const name = artifactName(p.target, p.facts.ffmpeg);
      writeFileSync(join(dist, `${name}.tar.gz`), tarGz([{ name: 'bin/ffmpeg', data: name, mode: 0o755 }, { name: 'THIRD-PARTY-NOTICES.txt', data: 'notices' }]));
      writeFileSync(join(dist, `${name}-dev.tar.gz`), tarGz([{ name: 'include/libavutil/avutil.h', data: 'h' }]));
      const kept = (file: string, text: string) => {
        mkdirSync(join(dist, `${name}.sources`, file, '..'), { recursive: true });
        writeFileSync(join(dist, `${name}.sources`, file), text);
        return sha(Buffer.from(text));
      };
      const record = (n: string, v: string) => ({ name: n, version: v, origin: `https://example.org/${n}-${v}.tar.gz`, file: `${n}/${n}-${v}.tar.gz`, sha256: kept(`${n}/${n}-${v}.tar.gz`, `${n} ${v} source`) });
      const sources = {
        artifact: name, target: p.target.name, platform: p.target.platform, license: p.target.license, release: null,
        ffmpeg: record('ffmpeg', p.facts.ffmpeg),
        libraries: Object.entries(p.facts.components).map(([n, v]) => ({ ...record(n, v), cached: false })),
        patches: [],
      };
      edit(name, sources);
      writeFileSync(join(dist, `${name}.sources.json`), JSON.stringify(sources));
    }
  }
  return { dir, dist, folder: r.folder };
}

let gh: FakeGitHub;
beforeEach(async () => {
  gh = await fakeGitHub();
  delete process.env.GITHUB_REPOSITORY;
});
afterEach(() => gh.close());

describe('ffmpeg-build bundle', () => {
  it('writes the manifest, the sources archive, SHA256SUMS, the notes, and what to upload', async () => {
    const { dist, folder } = builtFolder();
    const r = await bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot, repo: 'o/r' });
    expect(r.assets).toEqual([
      'ffmpeg-9.1.0-linux-x64-lgplv3.tar.gz', 'ffmpeg-9.1.0-linux-x64-lgplv3-dev.tar.gz',
      'ffmpeg-9.1.0-linux-x64-gplv3.tar.gz', 'ffmpeg-9.1.0-linux-x64-gplv3-dev.tar.gz',
      'ffmpeg-9.1.0-sources.tar.gz', 'manifest.yml', 'SHA256SUMS',
    ]);
    expect(r.latest).toBe(true);
    const m = parseManifest(readFileSync(join(dist, 'manifest.yml'), 'utf8'));
    expect(m).toMatchObject({ release: '9.1.0.0', ffmpeg: '9.1.0', build: '0', engine: packageVersion() });
    const lg = m.targets.find((t) => t.name === 'linux-x64-lgplv3')!;
    expect(lg.components).toEqual({ dav1d: '1.5.4', opus: '1.6.1' });
    expect(lg.assets.runtime.sha256).toBe(sha(readFileSync(join(dist, lg.assets.runtime.name))));
    // every asset but SHA256SUMS itself, with its sha256
    const sums = readFileSync(join(dist, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(6);
    for (const line of sums) {
      const [hash, file] = line.split(/ {2}/);
      expect(sha(readFileSync(join(dist, file!))), file).toBe(hash);
    }
    // the sources: each kept source once, the build definition, the engine's files, and the index
    const names = readTarGz(readFileSync(join(dist, 'ffmpeg-9.1.0-sources.tar.gz'))).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([
      'ffmpeg-9.1.0-sources/sources/ffmpeg/ffmpeg-9.1.0.tar.gz', 'ffmpeg-9.1.0-sources/sources/dav1d/dav1d-1.5.4.tar.gz',
      'ffmpeg-9.1.0-sources/sources/x265/x265-4.1.tar.gz', 'ffmpeg-9.1.0-sources/build/ffmpeg-build.yml', 'ffmpeg-9.1.0-sources/build/ffmpeg.lock',
      'ffmpeg-9.1.0-sources/engine/platforms/driver.sh', 'ffmpeg-9.1.0-sources/engine/recipes/dav1d/recipe.yml', 'ffmpeg-9.1.0-sources/SOURCES.md',
    ]));
    expect(names.filter((n) => n.endsWith('dav1d-1.5.4.tar.gz'))).toHaveLength(1); // shared by both targets, kept once
    expect(readFileSync(join(dist, 'release-notes.md'), 'utf8')).toContain('| linux-x64-gplv3 | gplv3 | `ffmpeg-9.1.0-linux-x64-gplv3.tar.gz` |');
    expect(JSON.parse(readFileSync(join(dist, 'bundle.json'), 'utf8'))).toEqual({ tag: '9.1.0.0', assets: r.assets, latest: true });
  });

  it('gives a product exactly what was bundled: fetch reads the manifest and checks every archive', async () => {
    const { dist, folder } = builtFolder();
    const r = await bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot, repo: 'o/r' });
    gh.releases.push({ tag: '9.1.0.0', files: Object.fromEntries(r.assets.map((a) => [a, readFileSync(join(dist, a))])) });
    const out = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-bundle-fetch-')), 'ffmpeg');
    await fetchRelease('o/r@9.1.0.0', { target: 'linux-x64-gplv3', dev: true }, out);
    expect(readFileSync(join(out, 'bin', 'ffmpeg'), 'utf8')).toBe('ffmpeg-9.1.0-linux-x64-gplv3');
    expect(existsSync(join(out, 'THIRD-PARTY-NOTICES.txt'))).toBe(true);
  });

  it('refuses a missing build, a kept source that changed, and a build from other versions than the lock', async () => {
    const missing = builtFolder();
    const { rmSync } = await import('node:fs');
    rmSync(join(missing.dist, 'ffmpeg-9.1.0-linux-x64-gplv3-dev.tar.gz'));
    await expect(bundle(missing.folder, data, LOCK, { tag: '9.1.0.0', dist: missing.dist, engineRoot: packageRoot })).rejects.toThrow("linux-x64-gplv3 isn't built in");
    const tampered = builtFolder();
    writeFileSync(join(tampered.dist, 'ffmpeg-9.1.0-linux-x64-gplv3.sources', 'x265', 'x265-4.1.tar.gz'), 'other');
    await expect(bundle(tampered.folder, data, LOCK, { tag: '9.1.0.0', dist: tampered.dist, engineRoot: packageRoot })).rejects.toThrow("doesn't match its record; build it again");
    const stale = builtFolder(FOLDER, (_n, s) => { s.libraries = s.libraries.map((l) => (l.name === 'dav1d' ? { ...l, version: '1.4.0' } : l)); });
    await expect(bundle(stale.folder, data, LOCK, { tag: '9.1.0.0', dist: stale.dist, engineRoot: packageRoot })).rejects.toThrow('was built from other versions than ffmpeg.lock says (dav1d 1.5.4)');
  });

  it("keeps both when two machines kept the same source as different bytes (another tar and gzip), each build's own", async () => {
    const { dist, folder } = builtFolder();
    const gpl = 'ffmpeg-9.1.0-linux-x64-gplv3';
    const json = JSON.parse(readFileSync(join(dist, `${gpl}.sources.json`), 'utf8'));
    const dav1d = json.libraries.find((l: { name: string }) => l.name === 'dav1d');
    writeFileSync(join(dist, `${gpl}.sources`, dav1d.file), 'the same commit, archived elsewhere');
    dav1d.sha256 = sha(Buffer.from('the same commit, archived elsewhere'));
    writeFileSync(join(dist, `${gpl}.sources.json`), JSON.stringify(json));
    await bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot });
    const entries = readTarGz(readFileSync(join(dist, 'ffmpeg-9.1.0-sources.tar.gz')));
    const kept = entries.filter((e) => e.name.endsWith('dav1d-1.5.4.tar.gz')).map((e) => [e.name, e.data.toString()]);
    expect(kept).toEqual([
      ['ffmpeg-9.1.0-sources/sources/dav1d/dav1d-1.5.4.tar.gz', 'dav1d 1.5.4 source'],
      [`ffmpeg-9.1.0-sources/sources/dav1d/${dav1d.sha256.slice(0, 12)}/dav1d-1.5.4.tar.gz`, 'the same commit, archived elsewhere'],
    ]);
    const index = entries.find((e) => e.name.endsWith('SOURCES.md'))!.data.toString();
    expect(index).toContain(`| sources/dav1d/${dav1d.sha256.slice(0, 12)}/dav1d-1.5.4.tar.gz | ${dav1d.sha256} |`);
  });

  it('refuses a build made with other patches than the folder has now', async () => {
    const { dist, folder } = builtFolder(FOLDER, (_n, s) => { (s as unknown as { patches: unknown[] }).patches = [{ name: 'acme', sha256: 'ab'.repeat(32) }]; });
    await expect(bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot })).rejects.toThrow('was built with other patches than the folder has now; build it again');
  });

  it('names the release a tag must match', async () => {
    const { dist, folder } = builtFolder();
    await expect(bundle(folder, data, LOCK, { tag: '9.0.2.1', dist, engineRoot: packageRoot })).rejects.toThrow('no release 9.0.2 in this folder (it has 9.1.0)');
  });

  it('never sends a nonfree build to a public repository, and to a private one only when the folder says so', async () => {
    const nonfree = 'targets:\n  dvr: { platform: linux-x64, license: nonfree, ffmpeg: 9, with: [dav1d] }\n';
    const nowhere = builtFolder(nonfree);
    await expect(bundle(nowhere.folder, data, LOCK, { tag: '9.1.0.0', dist: nowhere.dist, engineRoot: packageRoot })).rejects.toThrow("there's no repository to check is private");
    const pub = builtFolder(nonfree);
    await expect(bundle(pub.folder, data, LOCK, { tag: '9.1.0.0', dist: pub.dist, engineRoot: packageRoot, repo: 'o/r' })).rejects.toThrow('dvr is nonfree: internal use only, never published to a public repository (o/r is public)');
    gh.private = true;
    const unacknowledged = builtFolder(nonfree);
    await expect(bundle(unacknowledged.folder, data, LOCK, { tag: '9.1.0.0', dist: unacknowledged.dist, engineRoot: packageRoot, repo: 'o/r' })).rejects.toThrow('Say that is intended with private-release: internal');
    const internal = builtFolder(`private-release: internal\n${nonfree}`);
    await bundle(internal.folder, data, LOCK, { tag: '9.1.0.0', dist: internal.dist, engineRoot: packageRoot, repo: 'o/r' });
    const m = parseManifest(readFileSync(join(internal.dist, 'manifest.yml'), 'utf8'));
    expect(m.targets[0]!.redistributable).toBe('false');
    expect(readFileSync(join(internal.dist, 'release-notes.md'), 'utf8')).toContain('**Internal use only:**');
  });

  it('stops when a component of the last release is gone, unless allowed', async () => {
    const { dist, folder } = builtFolder();
    const previous = gh.publish('9.1.0.0', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64', components: { dav1d: '1.5.4', opus: '1.6.1', zimg: '3.0' } }]);
    await expect(bundle(folder, data, LOCK, { tag: '9.1.0.1', dist, engineRoot: packageRoot, previous })).rejects.toThrow('linux-x64-lgplv3: zimg was in 9.1.0.0 and is gone now');
    const allowed = builtFolder(FOLDER.replace('with: [dav1d, opus] }', 'with: [dav1d, opus], allow-removal: [zimg] }'));
    await expect(bundle(allowed.folder, data, LOCK, { tag: '9.1.0.1', dist: allowed.dist, engineRoot: packageRoot, previous })).resolves.toMatchObject({ tag: '9.1.0.1' });
  });

  it('is latest only with the highest FFmpeg of its group', async () => {
    gh.publish('9.2.0.0', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64' }]);
    const { dist, folder } = builtFolder();
    const r = await bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot, repo: 'o/r', previous: undefined });
    expect(r.latest).toBe(false);
  });
});
