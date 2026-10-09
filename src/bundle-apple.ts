// `ffmpeg-build bundle --apple`, on a Mac: a release's iOS / Mac Catalyst framework builds, four per licence, become
// that licence's xcframework bundle, ffmpeg-<version>-ios-<license>.tar.gz, laid out as devenvy/ffmpeg publishes it:
// one <lib>.xcframework per FFmpeg library with three slices (ios-arm64, ios-arm64-simulator and the universal
// ios-arm64_x86_64-maccatalyst, the two Catalyst builds lipo-fused and signed again ad hoc), and one
// THIRD-PARTY-NOTICES.txt at the root. Plain `bundle` then publishes it in place of the four builds' archives.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appleBundleName, BundleError, releaseOf } from './bundle.ts';
import type { EngineData } from './engine-data.ts';
import type { FolderLock } from './lockfile.ts';
import { APPLE_SLICES, appleSlicesName, frameworkSliceProblems, isFrameworkPlatform, type AppleSlices, type PlannedRelease, type PlannedTarget } from './release.ts';
import { artifactName, type Folder } from './targets.ts';

export interface AppleBundleOptions {
  tag: string;
  dist: string;
  engineRoot: string;
  host?: NodeJS.Platform; // default: this machine's (tests pass another)
}

type Slice = (typeof APPLE_SLICES)[number];

// What each slice's binaries must be: their architectures, and LC_BUILD_VERSION's platform (2 iOS, 6 Mac Catalyst,
// 7 iOS simulator). The Catalyst slice is checked after fusing.
const XCF_SLICE = { device: 'ios-arm64', simulator: 'ios-arm64-simulator', catalyst: 'ios-arm64_x86_64-maccatalyst' } as const;
const EXPECT: Record<string, { archs: string[]; platform: string }> = {
  [XCF_SLICE.device]: { archs: ['arm64'], platform: '2' },
  [XCF_SLICE.simulator]: { archs: ['arm64'], platform: '7' },
  [XCF_SLICE.catalyst]: { archs: ['arm64', 'x86_64'], platform: '6' },
};

/**
 * The release's framework builds by licence and platform. Each licence needs exactly one build of each slice: the
 * xcframeworks have exactly three slices (the two Catalyst builds fused into one).
 */
export function appleSets(rel: PlannedRelease): Map<string, Map<Slice, PlannedTarget>> {
  const problems = frameworkSliceProblems(rel.targets.map((p) => p.target));
  if (problems.length) throw new BundleError(problems.join('\n'));
  const sets = new Map<string, Map<Slice, PlannedTarget>>();
  for (const p of rel.targets.filter((t) => isFrameworkPlatform(t.target.platform))) {
    const set = sets.get(p.target.license) ?? new Map<Slice, PlannedTarget>();
    set.set(p.target.platform as Slice, p);
    sets.set(p.target.license, set);
  }
  return sets;
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The .slices.json of a bundle in `dist`: its sha256, and each slice's archive, sha256 and components. */
export function appleSlicesRecord(dist: string, bundleName: string, set: Map<Slice, PlannedTarget>, ffmpeg: string): AppleSlices {
  const slices: AppleSlices['slices'] = {};
  for (const slice of APPLE_SLICES) {
    const p = set.get(slice)!;
    const archive = `${artifactName(p.target, ffmpeg)}.tar.gz`;
    slices[slice] = { target: p.target.name, archive, sha256: sha256(join(dist, archive)), components: p.facts.components };
  }
  return { bundle: { name: bundleName, sha256: sha256(join(dist, bundleName)) }, slices };
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });

/** A binary's architectures (sorted) and its LC_BUILD_VERSION platform. */
function machO(bin: string): { archs: string[]; platform: string } {
  const archs = run('lipo', ['-archs', bin]).trim().split(/\s+/).sort();
  const platform = /cmd LC_BUILD_VERSION[\s\S]*?platform (\S+)/.exec(run('otool', ['-l', bin]))?.[1] ?? '?';
  return { archs, platform };
}

const frameworksIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.framework')).sort();

/**
 * One THIRD-PARTY-NOTICES.txt for the bundle: a header naming the four builds and where each went, then each build's
 * own notices in full, in slice order. Their texts differ only in the target and platform lines, but each is what its
 * build shipped; keeping all four whole is the merge that can't drop anything.
 */
function bundleNotices(ffmpeg: string, license: string, slices: { slice: Slice; artifact: string; text: string }[]): string {
  const rule = '='.repeat(80);
  const where: Record<Slice, string> = {
    'ios-arm64': XCF_SLICE.device, 'ios-sim-arm64': XCF_SLICE.simulator,
    'maccatalyst-arm64': `${XCF_SLICE.catalyst} (arm64)`, 'maccatalyst-x64': `${XCF_SLICE.catalyst} (x86_64)`,
  };
  const out = [
    `THIRD-PARTY NOTICES: FFmpeg ${ffmpeg} for iOS and Mac Catalyst (${license})`,
    '',
    'This archive holds one .xcframework per FFmpeg library, made from four builds. Each build\'s own',
    'THIRD-PARTY-NOTICES.txt follows in full, in this order:',
    '',
    ...slices.map((s) => `  ${s.artifact}  ->  ${where[s.slice]}`),
    '',
  ];
  for (const s of slices) out.push(rule, `BUILD ${s.artifact}`, rule, '', s.text.endsWith('\n') ? s.text : `${s.text}\n`);
  return `${out.join('\n')}\n`;
}

/**
 * Writes each licence's xcframework bundle for the release `tag` from its framework builds in `dist`. Refuses
 * (BundleError) off macOS or without Xcode, when a licence lacks a slice or a slice isn't built, and when a slice's
 * binaries aren't the architectures and platform that slice is.
 */
export async function bundleApple(folder: Folder, data: EngineData, lock: FolderLock, o: AppleBundleOptions): Promise<{ assets: string[] }> {
  if ((o.host ?? process.platform) !== 'darwin') throw new BundleError('bundle --apple runs on macOS with Xcode (xcodebuild makes the xcframeworks)');
  try {
    run('xcodebuild', ['-version']);
  } catch {
    throw new BundleError('bundle --apple needs Xcode: xcodebuild -version fails (install Xcode and select it with xcode-select -s)');
  }
  const { rel } = releaseOf(folder, data, lock, o.engineRoot, o.tag);
  const sets = appleSets(rel);
  if (!sets.size) throw new BundleError(`${o.tag} has no iOS / Mac Catalyst targets: there's nothing for bundle --apple to do`);
  const assets: string[] = [];
  for (const [license, set] of sets) {
    const work = mkdtempSync(join(tmpdir(), 'ffmpeg-build-apple-'));
    try {
      const unpacked = new Map<Slice, { dir: string; artifact: string }>();
      for (const slice of APPLE_SLICES) {
        const p = set.get(slice)!;
        const artifact = artifactName(p.target, rel.ffmpeg);
        const archive = join(o.dist, `${artifact}.tar.gz`);
        if (!existsSync(archive)) throw new BundleError(`${p.target.name} isn't built in ${o.dist}: ${artifact}.tar.gz missing (ffmpeg-build build --target ${p.target.name} --out ${o.dist})`);
        const dir = join(work, slice);
        mkdirSync(dir);
        run('tar', ['-xzf', archive, '-C', dir]);
        unpacked.set(slice, { dir, artifact });
      }
      const frameworks = frameworksIn(unpacked.get('ios-arm64')!.dir);
      if (!frameworks.length) throw new BundleError(`${unpacked.get('ios-arm64')!.artifact}.tar.gz has no .framework`);
      for (const [slice, u] of unpacked) {
        const have = frameworksIn(u.dir);
        if (have.join() !== frameworks.join()) throw new BundleError(`${u.artifact} has ${have.join(', ') || 'no frameworks'}, but ${unpacked.get('ios-arm64')!.artifact} has ${frameworks.join(', ')} (${slice})`);
      }

      // the universal Catalyst slice: the arm64 framework with both builds' binaries, signed again (lipo rewrote it)
      const fused = join(work, 'catalyst');
      mkdirSync(fused);
      for (const fw of frameworks) {
        const lib = fw.replace(/\.framework$/, '');
        run('cp', ['-R', join(unpacked.get('maccatalyst-arm64')!.dir, fw), join(fused, fw)]);
        run('lipo', ['-create', join(unpacked.get('maccatalyst-arm64')!.dir, fw, lib), join(unpacked.get('maccatalyst-x64')!.dir, fw, lib), '-output', join(fused, fw, lib)]);
        run('codesign', ['--force', '--sign', '-', join(fused, fw)]);
      }

      const sliceDirs: [string, string][] = [[XCF_SLICE.device, unpacked.get('ios-arm64')!.dir], [XCF_SLICE.simulator, unpacked.get('ios-sim-arm64')!.dir], [XCF_SLICE.catalyst, fused]];
      for (const [xcfSlice, dir] of sliceDirs) {
        for (const fw of frameworks) {
          const got = machO(join(dir, fw, fw.replace(/\.framework$/, '')));
          const want = EXPECT[xcfSlice]!;
          if (got.archs.join() !== want.archs.join() || got.platform !== want.platform) {
            throw new BundleError(`${xcfSlice}/${fw}: ${got.archs.join(' ')}, platform ${got.platform}; the slice needs ${want.archs.join(' ')}, platform ${want.platform}`);
          }
        }
      }

      const out = join(work, 'out');
      mkdirSync(out);
      for (const fw of frameworks) {
        const xcf = join(out, fw.replace(/\.framework$/, '.xcframework'));
        run('xcodebuild', ['-create-xcframework', ...sliceDirs.flatMap(([, dir]) => ['-framework', join(dir, fw)]), '-output', xcf]);
        const slices = readdirSync(xcf).filter((e) => e !== 'Info.plist').sort();
        const listed = (JSON.parse(run('plutil', ['-extract', 'AvailableLibraries', 'json', '-o', '-', join(xcf, 'Info.plist')])) as { LibraryIdentifier: string }[]).map((l) => l.LibraryIdentifier).sort();
        const want = Object.values(XCF_SLICE).sort();
        if (slices.join() !== want.join() || listed.join() !== want.join()) {
          throw new BundleError(`${fw.replace(/\.framework$/, '.xcframework')} has slices ${slices.join(', ')} (Info.plist: ${listed.join(', ')}); it needs exactly ${want.join(', ')}`);
        }
      }

      const notices = APPLE_SLICES.map((slice) => {
        const u = unpacked.get(slice)!;
        const file = join(u.dir, 'THIRD-PARTY-NOTICES.txt');
        if (!existsSync(file)) throw new BundleError(`${u.artifact}.tar.gz has no THIRD-PARTY-NOTICES.txt`);
        return { slice, artifact: u.artifact, text: readFileSync(file, 'utf8') };
      });
      writeFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), bundleNotices(rel.ffmpeg, license, notices));

      const name = appleBundleName(rel.ffmpeg, license);
      run('tar', ['-czf', join(o.dist, name), '-C', out, '.']);
      // what it was made from, so plain bundle can refuse it once a slice is built again
      writeFileSync(join(o.dist, appleSlicesName(name)), `${JSON.stringify(appleSlicesRecord(o.dist, name, set, rel.ffmpeg), null, 2)}\n`);
      assets.push(name, appleSlicesName(name));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return { assets };
}
