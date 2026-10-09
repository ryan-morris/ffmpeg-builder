// iOS / Mac Catalyst releases: four framework builds per licence published as one xcframework bundle,
// ffmpeg-<v>-ios-<license>.tar.gz (bundle --apple, on a Mac), which plain bundle then publishes in their place.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { appleSets, appleSlicesRecord, bundleApple } from '../src/bundle-apple.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { formatFolderLock, type FolderLock } from '../src/lockfile.ts';
import { parseManifest, type Manifest } from '../src/manifest.ts';
import { packageRoot } from '../src/paths.ts';
import { runFolderCheck } from '../src/commands/folder.ts';
import { changesSince, planReleases, publishedTargets, removals } from '../src/release.ts';
import { artifactName, loadFolder, type Folder } from '../src/targets.ts';
import { readTarGz } from '../src/untar.ts';
import { fakeGitHub, tarGz, type FakeGitHub } from './github-fake.ts';

const data = loadEngineData(packageRoot);
const LOCK: FolderLock = { engine: '0.2.0', ffmpeg: { '9': '9.0.2' }, libraries: { dav1d: '1.5.4', opus: '1.6.1' } };
const SLICES = ['ios-arm64', 'ios-sim-arm64', 'maccatalyst-arm64', 'maccatalyst-x64'];
const FOLDER = [
  'targets:',
  ...SLICES.map((p) => `  ${p}-lgplv3: { platform: ${p}, license: lgplv3, ffmpeg: 9, with: [dav1d${p === 'ios-sim-arm64' ? '' : ', opus'}] }`),
  '  linux-x64-lgplv3: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }',
  '',
].join('\n');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A folder whose targets are "built" into dist as the driver leaves them (archives, sources.json, kept sources). */
function builtFolder(text = FOLDER): { dir: string; dist: string; folder: Folder } {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-apple-'));
  writeFileSync(join(dir, 'ffmpeg-build.yml'), text);
  writeFileSync(join(dir, 'ffmpeg.lock'), formatFolderLock(LOCK));
  const r = loadFolder(dir);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const dist = join(dir, 'dist');
  mkdirSync(dist);
  for (const rel of planReleases(r.folder, data, LOCK, packageRoot).releases) {
    for (const p of rel.targets) {
      const name = artifactName(p.target, p.facts.ffmpeg);
      writeFileSync(join(dist, `${name}.tar.gz`), tarGz([{ name: 'THIRD-PARTY-NOTICES.txt', data: `notices of ${name}` }]));
      writeFileSync(join(dist, `${name}-dev.tar.gz`), tarGz([{ name: 'include/libavutil/avutil.h', data: 'h' }]));
      const kept = (file: string, body: string) => {
        mkdirSync(join(dist, `${name}.sources`, file, '..'), { recursive: true });
        writeFileSync(join(dist, `${name}.sources`, file), body);
        return sha(body);
      };
      const record = (n: string, v: string) => ({ name: n, version: v, origin: `https://example.org/${n}-${v}.tar.gz`, file: `${n}/${n}-${v}.tar.gz`, sha256: kept(`${n}/${n}-${v}.tar.gz`, `${n} ${v}`) });
      writeFileSync(join(dist, `${name}.sources.json`), JSON.stringify({
        artifact: name, target: p.target.name, ffmpeg: record('ffmpeg', p.facts.ffmpeg),
        libraries: Object.entries(p.facts.components).map(([n, v]) => record(n, v)), patches: [],
      }));
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

describe('what an Apple release publishes', () => {
  it('one ios-<license> entry for the four framework slices of a licence; other targets as they are', () => {
    const { folder } = builtFolder();
    const rel = planReleases(folder, data, LOCK, packageRoot).releases[0]!;
    const published = publishedTargets(rel);
    expect(published.map((t) => [t.name, t.platform])).toEqual([['ios-lgplv3', 'ios'], ['linux-x64-lgplv3', 'linux-x64']]);
    const ios = published[0]!;
    expect(ios.slices.map((s) => s.target.platform).sort()).toEqual([...SLICES].sort());
    expect(ios.facts.components).toEqual({ dav1d: '1.5.4', opus: '1.6.1' }); // the union: the simulator has no opus
  });

  it('compares an ios entry with the last release by its published name', () => {
    const { folder } = builtFolder();
    const rel = planReleases(folder, data, LOCK, packageRoot).releases[0]!;
    const ios = publishedTargets(rel)[0]!;
    const linux = publishedTargets(rel)[1]!;
    const entry = (t: typeof ios) => ({
      name: t.name, platform: t.platform, license: t.license, redistributable: 'true' as const,
      assets: { runtime: { name: 'r', sha256: '0'.repeat(64) }, dev: { name: 'd', sha256: '0'.repeat(64) } },
      toolchain: t.facts.toolchain, components: t.facts.components, patches: t.facts.patches, 'not-included': [], definition: t.facts.definition,
    });
    const previous: Manifest = { release: '9.0.2.0', ffmpeg: '9.0.2', build: '0', engine: ios.facts.engine, targets: [entry(ios), entry(linux)], sources: { name: 's', sha256: '0'.repeat(64) } };
    expect(changesSince(rel, previous)).toEqual([]);
    const lost: Manifest = { ...previous, targets: [{ ...entry(ios), components: { ...ios.facts.components, aom: '3.15.1' } }, entry(linux)] };
    expect(removals(rel, lost, folder)).toEqual([
      'ios-lgplv3: aom was in 9.0.2.0 and is gone now; if that is intended, add allow-removal: [aom] to ios-arm64-lgplv3, ios-sim-arm64-lgplv3, maccatalyst-arm64-lgplv3, maccatalyst-x64-lgplv3 (the slice targets of ios-lgplv3)',
    ]);
    // the last release recorded its slices: opus dropped from the simulator only is caught, though the union kept it
    const slices = { 'ios-lgplv3': Object.fromEntries(SLICES.map((s) => [s, { dav1d: '1.5.4', opus: '1.6.1' }])) };
    expect(removals(rel, previous, folder, slices)).toEqual([
      'ios-lgplv3: opus was in its ios-sim-arm64 slice in 9.0.2.0 and is gone now; if that is intended, add allow-removal: [opus] to ios-sim-arm64-lgplv3 (the slice targets of ios-lgplv3)',
    ]);
    const allowed = builtFolder(FOLDER.replace('ios-sim-arm64-lgplv3: { platform: ios-sim-arm64, license: lgplv3, ffmpeg: 9, with: [dav1d] }', 'ios-sim-arm64-lgplv3: { platform: ios-sim-arm64, license: lgplv3, ffmpeg: 9, with: [dav1d], allow-removal: [opus] }'));
    expect(removals(planReleases(allowed.folder, data, LOCK, packageRoot).releases[0]!, previous, allowed.folder, slices)).toEqual([]);
  });

  it('refuses a licence without all four slices, or with one twice', () => {
    const three = builtFolder(FOLDER.split('\n').filter((l) => !l.includes('maccatalyst-x64')).join('\n'));
    const rel = planReleases(three.folder, data, LOCK, packageRoot).releases[0]!;
    expect(() => appleSets(rel)).toThrow('lgplv3 has no maccatalyst-x64 target: an xcframework bundle needs ios-arm64, ios-sim-arm64, maccatalyst-arm64 and maccatalyst-x64');
  });

  it('stops releases and check before anything is built, when a licence lacks a slice', () => {
    const three = builtFolder(FOLDER.split('\n').filter((l) => !l.includes('maccatalyst-x64')).join('\n'));
    expect(planReleases(three.folder, data, LOCK, packageRoot).errors).toEqual([
      '9.0.2: lgplv3 has no maccatalyst-x64 target: an xcframework bundle needs ios-arm64, ios-sim-arm64, maccatalyst-arm64 and maccatalyst-x64 (it has ios-arm64-lgplv3, ios-sim-arm64-lgplv3, maccatalyst-arm64-lgplv3)',
    ]);
    const check = runFolderCheck(three.folder, data);
    expect(check.exitCode).toBe(1);
    expect(check.output).toContain('✗ lgplv3 has no maccatalyst-x64 target');
    // a second ios-arm64 of the same licence is refused too
    const twice = builtFolder(`${FOLDER}  extra-ios: { platform: ios-arm64, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n`);
    expect(runFolderCheck(twice.folder, data).output).toContain('lgplv3 has two ios-arm64 targets (ios-arm64-lgplv3, extra-ios)');
    // another release group is its own bundle: three slices there are refused even with four here
    const grouped = builtFolder(`${FOLDER}${SLICES.slice(1).map((p) => `  ${p}-dvr: { platform: ${p}, license: lgplv3, ffmpeg: 9, with: [dav1d], release-group: dvr }\n`).join('')}`);
    expect(runFolderCheck(grouped.folder, data).output).toContain('dvr-9.0.2: lgplv3 has no ios-arm64 target');
  });
});

/** What bundle --apple leaves in dist: the bundle and its .slices.json (a stand-in bundle; no Mac needed). */
function appleBundled(dist: string, folder: Folder): void {
  writeFileSync(join(dist, 'ffmpeg-9.0.2-ios-lgplv3.tar.gz'), tarGz([{ name: 'libavutil.xcframework/Info.plist', data: 'x' }]));
  const rel = planReleases(folder, data, LOCK, packageRoot).releases[0]!;
  const record = appleSlicesRecord(dist, 'ffmpeg-9.0.2-ios-lgplv3.tar.gz', appleSets(rel).get('lgplv3')!, rel.ffmpeg);
  writeFileSync(join(dist, 'ffmpeg-9.0.2-ios-lgplv3.slices.json'), JSON.stringify(record));
}

describe('ffmpeg-build bundle, for a release with framework targets', () => {
  it('publishes the ios bundle for the slices, and keeps every slice\'s sources', async () => {
    const { dist, folder } = builtFolder();
    appleBundled(dist, folder);
    const r = await bundle(folder, data, LOCK, { tag: '9.0.2.3', dist, engineRoot: packageRoot, repo: 'o/r' });
    expect(r.assets).toEqual([
      'ffmpeg-9.0.2-ios-lgplv3.tar.gz', 'ffmpeg-9.0.2-linux-x64-lgplv3.tar.gz', 'ffmpeg-9.0.2-linux-x64-lgplv3-dev.tar.gz',
      'ffmpeg-9.0.2-ios-lgplv3.slices.json', 'ffmpeg-9.0.2-sources.tar.gz', 'manifest.yml', 'SHA256SUMS',
    ]);
    const m = parseManifest(readFileSync(join(dist, 'manifest.yml'), 'utf8'));
    const ios = m.targets.find((t) => t.name === 'ios-lgplv3')!;
    expect(ios).toMatchObject({ platform: 'ios', license: 'lgplv3', components: { dav1d: '1.5.4', opus: '1.6.1' } });
    expect(ios.assets.runtime).toEqual(ios.assets.dev); // the xcframeworks carry their headers: one file for both
    expect(ios.assets.runtime.name).toBe('ffmpeg-9.0.2-ios-lgplv3.tar.gz');
    expect(m.targets.map((t) => t.name)).toEqual(['ios-lgplv3', 'linux-x64-lgplv3']);
    const names = readTarGz(readFileSync(join(dist, 'ffmpeg-9.0.2-sources.tar.gz'))).map((e) => e.name);
    const index = readTarGz(readFileSync(join(dist, 'ffmpeg-9.0.2-sources.tar.gz'))).find((e) => e.name.endsWith('SOURCES.md'))!.data.toString();
    for (const s of SLICES) expect(index).toContain(`## ${s}-lgplv3`);
    expect(names).toContain('ffmpeg-9.0.2-sources/sources/opus/opus-1.6.1.tar.gz');
    expect(readFileSync(join(dist, 'release-notes.md'), 'utf8')).toContain('| ios-lgplv3 | lgplv3 | `ffmpeg-9.0.2-ios-lgplv3.tar.gz` |');
  });

  it('refuses without the ios bundle, and says how to make it', async () => {
    const { dist, folder } = builtFolder();
    await expect(bundle(folder, data, LOCK, { tag: '9.0.2.3', dist, engineRoot: packageRoot, repo: 'o/r' }))
      .rejects.toThrow('ffmpeg-9.0.2-ios-lgplv3.tar.gz (the lgplv3 xcframework bundle) isn\'t in');
  });

  it('refuses a stale ios bundle: a slice built again since bundle --apple, or no record of its slices', async () => {
    const { dist, folder } = builtFolder();
    appleBundled(dist, folder);
    writeFileSync(join(dist, 'ffmpeg-9.0.2-ios-sim-arm64-lgplv3.tar.gz'), tarGz([{ name: 'THIRD-PARTY-NOTICES.txt', data: 'built again' }]));
    await expect(bundle(folder, data, LOCK, { tag: '9.0.2.3', dist, engineRoot: packageRoot, repo: 'o/r' }))
      .rejects.toThrow("ffmpeg-9.0.2-ios-lgplv3.tar.gz is stale: it wasn't made from the ffmpeg-9.0.2-ios-sim-arm64-lgplv3.tar.gz in");
    rmSync(join(dist, 'ffmpeg-9.0.2-ios-lgplv3.slices.json'));
    await expect(bundle(folder, data, LOCK, { tag: '9.0.2.3', dist, engineRoot: packageRoot, repo: 'o/r' }))
      .rejects.toThrow("ffmpeg-9.0.2-ios-lgplv3.slices.json isn't in");
  });

  it("compares slice by slice with the last release's .slices.json", async () => {
    const { dist, folder } = builtFolder();
    appleBundled(dist, folder);
    const rel = planReleases(folder, data, LOCK, packageRoot).releases[0]!;
    const [ios, linux] = publishedTargets(rel);
    gh.publish('9.0.2.0', [
      { name: 'ios-lgplv3', platform: 'ios', components: ios!.facts.components },
      { name: 'linux-x64-lgplv3', platform: 'linux-x64', components: linux!.facts.components },
    ]);
    // the last release's simulator slice had opus; this one's doesn't, though the union still has it
    const record = JSON.parse(readFileSync(join(dist, 'ffmpeg-9.0.2-ios-lgplv3.slices.json'), 'utf8')) as { slices: Record<string, { components: Record<string, string> }> };
    record.slices['ios-sim-arm64']!.components = { dav1d: '1.5.4', opus: '1.6.1' };
    gh.releases.at(-1)!.files['ffmpeg-9.0.2-ios-lgplv3.slices.json'] = Buffer.from(JSON.stringify(record));
    await expect(bundle(folder, data, LOCK, { tag: '9.0.2.1', dist, engineRoot: packageRoot, repo: 'o/r' }))
      .rejects.toThrow('ios-lgplv3: opus was in its ios-sim-arm64 slice in 9.0.2.0 and is gone now');
  });
});

describe('ffmpeg-build bundle --apple', () => {
  it('needs macOS (xcodebuild)', async () => {
    const { dist, folder } = builtFolder();
    await expect(bundleApple(folder, data, LOCK, { tag: '9.0.2.3', dist, engineRoot: packageRoot, host: 'linux' }))
      .rejects.toThrow('bundle --apple runs on macOS with Xcode (xcodebuild makes the xcframeworks)');
  });

  it.skipIf(process.platform === 'darwin')('stops at the host check before reading dist', async () => {
    await expect(bundleApple({} as Folder, data, LOCK, { tag: '9.0.2.3', dist: '/nowhere', engineRoot: packageRoot })).rejects.toThrow('runs on macOS');
  });
});

// On a Mac with Xcode: stand-in frameworks (a tiny dylib per slice, compiled for that slice) through the real thing.
const hasXcode = (() => {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('xcodebuild', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasXcode)('bundle --apple on a Mac', () => {
  const TARGET: Record<string, string[]> = {
    'ios-arm64': ['--sdk', 'iphoneos', 'clang', '-arch', 'arm64', '-miphoneos-version-min=13.0'],
    'ios-sim-arm64': ['--sdk', 'iphonesimulator', 'clang', '-arch', 'arm64', '-mios-simulator-version-min=13.0'],
    'maccatalyst-arm64': ['--sdk', 'macosx', 'clang', '-target', 'arm64-apple-ios14.0-macabi'],
    'maccatalyst-x64': ['--sdk', 'macosx', 'clang', '-target', 'x86_64-apple-ios14.0-macabi'],
  };

  it('makes one three-slice xcframework per library, with the Catalyst slices fused and one notices file', async () => {
    const { dist, folder } = builtFolder();
    const src = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-fw-')), 'x.c');
    writeFileSync(src, 'int av_version_stub(void) { return 1; }\n');
    for (const p of SLICES) {
      const name = `ffmpeg-9.0.2-${p}-lgplv3`;
      const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-slice-'));
      for (const lib of ['libavutil', 'libavcodec']) {
        const fw = join(root, `${lib}.framework`);
        mkdirSync(join(fw, 'Headers'), { recursive: true });
        writeFileSync(join(fw, 'Headers', 'version.h'), '#define X 1\n');
        writeFileSync(join(fw, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${lib}</string><key>CFBundleIdentifier</key><string>org.ffmpeg.${lib}</string><key>CFBundlePackageType</key><string>FMWK</string></dict></plist>\n`);
        execFileSync('xcrun', [...TARGET[p]!, '-dynamiclib', '-install_name', `@rpath/${lib}.framework/${lib}`, '-o', join(fw, lib), src]);
      }
      writeFileSync(join(root, 'THIRD-PARTY-NOTICES.txt'), `notices of ${name}\n`);
      rmSync(join(dist, `${name}.tar.gz`));
      execFileSync('tar', ['-czf', join(dist, `${name}.tar.gz`), '-C', root, '.']);
    }
    const r = await bundleApple(folder, data, LOCK, { tag: '9.0.2.3', dist, engineRoot: packageRoot });
    expect(r.assets).toEqual(['ffmpeg-9.0.2-ios-lgplv3.tar.gz', 'ffmpeg-9.0.2-ios-lgplv3.slices.json']);
    const record = JSON.parse(readFileSync(join(dist, 'ffmpeg-9.0.2-ios-lgplv3.slices.json'), 'utf8')) as { slices: Record<string, { sha256: string }> };
    for (const p of SLICES) expect(record.slices[p]!.sha256).toBe(sha(readFileSync(join(dist, `ffmpeg-9.0.2-${p}-lgplv3.tar.gz`))));
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-xcf-'));
    execFileSync('tar', ['-xzf', join(dist, 'ffmpeg-9.0.2-ios-lgplv3.tar.gz'), '-C', out]);
    for (const lib of ['libavutil', 'libavcodec']) {
      const xcf = join(out, `${lib}.xcframework`);
      for (const slice of ['ios-arm64', 'ios-arm64-simulator', 'ios-arm64_x86_64-maccatalyst']) expect(existsSync(join(xcf, slice, `${lib}.framework`, lib)), slice).toBe(true);
      const fused = execFileSync('lipo', ['-archs', join(xcf, 'ios-arm64_x86_64-maccatalyst', `${lib}.framework`, lib)], { encoding: 'utf8' }).trim().split(' ').sort();
      expect(fused).toEqual(['arm64', 'x86_64']);
      execFileSync('codesign', ['-v', join(xcf, 'ios-arm64_x86_64-maccatalyst', `${lib}.framework`)]);
    }
    const notices = readFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const p of SLICES) expect(notices).toContain(`notices of ffmpeg-9.0.2-${p}-lgplv3`);
  });

  it('refuses a missing slice archive', async () => {
    const { dist, folder } = builtFolder();
    rmSync(join(dist, 'ffmpeg-9.0.2-maccatalyst-x64-lgplv3.tar.gz'));
    await expect(bundleApple(folder, data, LOCK, { tag: '9.0.2.3', dist, engineRoot: packageRoot })).rejects.toThrow("maccatalyst-x64-lgplv3 isn't built in");
  });
});
