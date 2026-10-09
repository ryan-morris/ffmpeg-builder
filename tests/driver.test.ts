// platforms/driver.sh end to end with the host's bash, on stand-ins: a fake platform setup, two small libraries (a
// tarball and a git checkout that clones another repository into itself, as shaderc's recipe does) and a fake FFmpeg
// whose configure and make only lay out files. What it checks: the declared licence files, THIRD-PARTY-NOTICES.txt at
// the root of both archives (FFmpeg first, the governing texts per licence, every library's texts under its heading,
// the patch sets, what the platform ships), the kept sources, <name>.sources.json, and the library cache bringing all
// of it back. Needs bash, git, jq, GNU tar/find/coreutils; skipped where they're missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GOVERNING_TEXTS, noticesBuild, noticesHeader, noticesSource, type PlannedPatchSet } from '../src/build/plan.ts';
import { packageRoot } from '../src/paths.ts';
import { LICENSES, type License } from '../src/schema/profile.ts';

const hasTools = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v git && command -v jq && command -v sha256sum && find --version && tar --version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A path as the host's bash sees it (Git Bash on Windows: /c/...; GNU tar reads C: as a remote host). */
const sh = (p: string) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replaceAll('\\', '/') : p);
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const write = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text, { mode: 0o755 });
};

let T = '';
const bash = (script: string) => execFileSync('bash', ['-c', `set -euo pipefail\n${script}`], { encoding: 'utf8', env: { ...process.env, T: sh(T) } });

// The stand-ins: tools the driver calls that a test can't (curl, make), with jq's Windows CRLF taken out.
function lay(): void {
  T = mkdtempSync(join(tmpdir(), 'ffmpeg-build-driver-'));
  write(join(T, 'bin', 'curl'), '#!/usr/bin/env bash\n# curl -fsSL --connect-timeout 30 <url> -o <file>, for file:// urls\ncp "${4#file://}" "$6"\n');
  write(join(T, 'bin', 'make'), '#!/usr/bin/env bash\n[ "${1:-}" = install ] || exit 0\np="$(cat .prefix)"\nmkdir -p "$p/lib" "$p/include/libavutil"\necho lib >"$p/lib/libavutil.so"\necho h >"$p/include/libavutil/avutil.h"\n');
  const jq = execFileSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).trim();
  write(join(T, 'bin', 'jq'), `#!/usr/bin/env bash\nset -o pipefail\n"${jq}" "$@" | tr -d '\\r'\n`);

  // the engine: the real driver and notices helpers, a fake setup
  cpSync(join(packageRoot, 'platforms', 'driver.sh'), join(T, 'engine', 'driver.sh'));
  cpSync(join(packageRoot, 'platforms', 'notices.sh'), join(T, 'engine', 'notices.sh'));
  write(join(T, 'engine', 'setup', 'fake.sh'), [
    'CMAKE_CROSS_ARGS=()', 'MESON_CROSS_ARGS=()', `export FAKE_TOOLCHAIN="${sh(T)}/toolchain"`,
    'before_ffmpeg() { :; }',
    'stage() { cp -a "$1/lib/." "$2/"; mkdir -p "$3/include"; cp -a "$1/include/." "$3/include/"; }',
    'check_stage() { [ -f "$1/THIRD-PARTY-NOTICES.txt" ]; }', '',
  ].join('\n'));
  write(join(T, 'toolchain', 'NOTICE'), 'libfoo notice\n');

  // recipes: alpha (a tarball), beta (git, with a licence file kept beside its recipe), gamma (declares a file it lacks)
  write(join(T, 'recipes', 'lib.sh'), '# recipes/lib.sh stand-in\n');
  write(join(T, 'recipes', 'alpha', 'build.sh'), 'mkdir -p "${DEPS_DIR}/lib"\ncp README "${DEPS_DIR}/lib/alpha.txt"\n');
  write(join(T, 'recipes', 'beta', 'build.sh'), `git clone -q "${sh(T)}/repos/nested" third_party/nested\nmkdir -p "\${DEPS_DIR}/lib"\necho beta >"\${DEPS_DIR}/lib/beta.txt"\n`);
  // with a line of = signs, as some licences have: the file's sections are a rule, a title and a rule
  write(join(T, 'recipes', 'beta', 'LICENSE'), `beta licence, kept beside the recipe\n\n${'='.repeat(80)}\n\nand more of it\n`);
  write(join(T, 'recipes', 'gamma', 'build.sh'), 'mkdir -p "${DEPS_DIR}/lib"\necho gamma >"${DEPS_DIR}/lib/gamma.txt"\n');

  // sources: alpha's tarball, beta's and nested's repositories, FFmpeg's tarball with its COPYING texts
  write(join(T, 'srcs', 'alpha-1.0', 'COPYING'), 'alpha copying\n');
  write(join(T, 'srcs', 'alpha-1.0', 'docs', 'NOTICE.txt'), 'alpha notice, no final newline');
  write(join(T, 'srcs', 'alpha-1.0', 'README'), 'alpha\n');
  write(join(T, 'repos', 'beta', 'LICENSE.md'), 'beta license\n');
  write(join(T, 'repos', 'beta', 'beta.c'), 'int beta;\n');
  write(join(T, 'repos', 'beta', 'version.h'), '#define REV "$Format:%H$"\n');
  // what git archive would leave out or rewrite, and the kept source must not
  write(join(T, 'repos', 'beta', '.gitattributes'), 'beta.c export-ignore\nversion.h export-subst\n');
  write(join(T, 'repos', 'nested', 'N.txt'), 'nested\n');
  const ff = join(T, 'srcs', 'ffmpeg-9.0.0');
  // as FFmpeg's configure: its arguments, C-escaped, as FFMPEG_CONFIGURATION in config.h
  write(join(ff, 'configure'), [
    '#!/usr/bin/env bash',
    'for a; do case "$a" in --prefix=*) echo "${a#--prefix=}" >.prefix ;; esac; done',
    'mkdir -p ffbuild',
    'echo CONFIG_FAKE=yes >ffbuild/config.mak',
    'printf \'#define FFMPEG_CONFIGURATION "%s"\\n\' "$(printf \'%s\' "$*" | sed \'s/[\\\\"]/\\\\&/g\')" >config.h', '',
  ].join('\n'));
  for (const f of ['LICENSE.md', 'CREDITS', 'COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3']) write(join(ff, f), `FFmpeg ${f}\n`);
  bash(`
    mkdir -p "$T/dl" && tar -czf "$T/dl/alpha-1.0.tar.gz" -C "$T/srcs" alpha-1.0 && tar -czf "$T/dl/ffmpeg-9.0.0.tar.gz" -C "$T/srcs" ffmpeg-9.0.0
    for r in beta nested; do
      git -C "$T/repos/$r" init -q -b main && git -C "$T/repos/$r" add -A && git -C "$T/repos/$r" -c user.name=t -c user.email=t@t commit -q -m one
    done`);
}

type Lib = { name: string; source: object; license: string; licenseFiles: { path: string; recipe?: true }[] };
const ALPHA: Lib = { name: 'alpha', license: 'MIT', source: { archives: ['file:///nowhere/alpha-1.0.tar.gz', 'file://$T/dl/alpha-1.0.tar.gz'] }, licenseFiles: [{ path: 'COPYING' }, { path: 'docs/NOTICE.txt' }] };
const BETA: Lib = { name: 'beta', license: 'BSD-2-Clause', source: { git: '$T/repos/beta', ref: 'main' }, licenseFiles: [{ path: 'LICENSE.md' }, { path: 'LICENSE', recipe: true }] };
const GAMMA: Lib = { name: 'gamma', license: 'MIT', source: { git: '$T/repos/beta', ref: 'main' }, licenseFiles: [{ path: 'COPYING' }] };

// a patch to FFmpeg's CREDITS, which the notices carry: proof in the archive that patches are applied before the build
const CREDITS_PATCH = { name: '0001-credits.patch', text: '--- a/CREDITS\n+++ b/CREDITS\n@@ -1 +1 @@\n-FFmpeg CREDITS\n+FFmpeg CREDITS, patched by acme\n' };
const CONFIGURE = ['--enable-gpl', '--extra-cflags=-DX="a b"'];

/** Runs the driver on a plan for `license` (and `libs`); its exit code and log. */
function drive(license: License, libs: Lib[] = [BETA, ALPHA], release?: string, patchFiles = [CREDITS_PATCH]): { code: number; log: string; name: string } {
  const name = `ffmpeg-9.0.0-fake-${license}`;
  const at = (s: string) => s.replaceAll('$T', sh(T));
  const patches: PlannedPatchSet[] = [{ name: 'acme', license: 'MIT', sha256: 'ab'.repeat(32), files: patchFiles, licenses: [{ path: 'LICENSE', text: 'Acme licence\n' }] }];
  const licence = license === 'nonfree' ? 'This build is NOT REDISTRIBUTABLE.\n' : `EFFECTIVE LICENSE:  ${license}\n`;
  const plan = {
    platform: 'linux-x64', setup: 'fake', image: 'linux-x64', toolchain: 'f00d', engine: '0.0.0-test', name, target: `fake-${license}`, license,
    ...(release ? { release, repository: 'acme/media-builds' } : {}),
    sourcesArchive: 'ffmpeg-9.0.0-sources.tar.gz',
    libraries: libs.map((l) => ({ name: l.name, version: '1.0', license: l.license, key: `${l.name}-key`, cached: false, source: JSON.parse(at(JSON.stringify(l.source))), licenseFiles: l.licenseFiles })),
    runtime: [],
    ships: [{ file: 'libfoo.so', license: 'Zlib', notice: '${FAKE_TOOLCHAIN}/NOTICE' }],
    patches,
    notices: {
      governing: GOVERNING_TEXTS[license],
      header: noticesHeader({ version: '9.0.0', target: `fake-${license}`, platform: 'linux-x64', engine: '0.0.0-test', licence, patches }),
      build: noticesBuild({ platform: 'linux-x64', setup: 'fake', image: 'linux-x64', toolchain: 'f00d' }),
      source: noticesSource({
        name, version: '9.0.0', license, ...(release ? { release, repository: 'acme/media-builds' } : {}), sourcesArchive: 'ffmpeg-9.0.0-sources.tar.gz',
        source: { repo: 'https://github.com/acme/media-builds', ref: 'c0ffee' }, ffmpegTarball: 'https://ffmpeg.org/releases/ffmpeg-9.0.0.tar.xz',
      }),
    },
    ffmpeg: { version: '9.0.0', archives: [at('file://$T/dl/ffmpeg-9.0.0.tar.gz')], configure: CONFIGURE, verify: [] },
  };
  writeFileSync(join(T, 'plan.json'), JSON.stringify(plan));
  for (const d of ['deps', 'work']) rmSync(join(T, d), { recursive: true, force: true });
  mkdirSync(join(T, 'out'), { recursive: true });
  const r = spawnSync('bash', ['-c', `export PATH="${sh(T)}/bin:$PATH"; exec bash "${sh(T)}/engine/driver.sh"`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FFB_PLAN: sh(join(T, 'plan.json')), FFB_RECIPES: sh(join(T, 'recipes')), ENGINE: sh(join(T, 'engine')), FFB_CACHE: sh(join(T, 'cache')),
      FFB_OUT: sh(join(T, 'out')), DEPS_DIR: sh(join(T, 'deps')), FFB_WORK: sh(join(T, 'work')),
    },
  });
  return { code: r.status ?? 1, log: `${r.stdout}${r.stderr}`, name };
}

/** The files in an archive under out/, sorted. */
const listing = (archive: string) => bash(`tar -tzf "$T/out/${archive}" | sed 's|^\\./||' | grep -v '/$' | LC_ALL=C sort`).trim().split('\n');
const fileIn = (archive: string, path: string) => bash(`tar -xzOf "$T/out/${archive}" "./${path}"`);
const notices = (name: string) => fileIn(`${name}.tar.gz`, 'THIRD-PARTY-NOTICES.txt');
const sources = (name: string) => JSON.parse(readFileSync(join(T, 'out', `${name}.sources.json`), 'utf8'));
const RULE = '='.repeat(80);
/** The titles of the file's sections, in order. */
const sectionsOf = (text: string) => [...text.matchAll(new RegExp(`^${RULE}\\n(.+)\\n${RULE}$`, 'gm'))].map((m) => m[1]);
/** A section's body: from its rule to the next section's. */
// (to the next rule-title-rule: a licence text may hold a line of = signs itself, as SVT-AV1's do)
const sectionOf = (text: string, title: string) => text.split(`${RULE}\n${title}\n${RULE}\n`)[1]!.split(new RegExp(`\\n${RULE}\\n[A-Z][A-Z ]+\\n${RULE}\\n`))[0]!;

describe.skipIf(!hasTools)('the driver: THIRD-PARTY-NOTICES.txt and sources', () => {
  let first: ReturnType<typeof drive>;
  beforeAll(() => {
    lay();
    first = drive('lgplv3');
  }, 120_000);

  it('builds, with THIRD-PARTY-NOTICES.txt at the root of both archives and no legal/ folder', () => {
    expect(first.code, first.log).toBe(0);
    for (const archive of [`${first.name}.tar.gz`, `${first.name}-dev.tar.gz`]) {
      const files = listing(archive);
      expect(files).toContain('THIRD-PARTY-NOTICES.txt');
      expect(files.filter((f) => f.startsWith('legal/'))).toEqual([]);
    }
    expect(fileIn(`${first.name}-dev.tar.gz`, 'THIRD-PARTY-NOTICES.txt')).toBe(notices(first.name));
  });

  it('starts with FFmpeg: the header, then BUILD, SOURCE and FFmpeg\'s own texts, before any library', () => {
    const text = notices(first.name);
    expect(text.split('\n')[0]).toBe('FFmpeg 9.0.0 — fake-lgplv3 (linux-x64), built by ffmpeg-build 0.0.0-test');
    expect(text).toContain('\nEFFECTIVE LICENSE:  lgplv3\n');
    expect(sectionsOf(text)).toEqual(['BUILD', 'SOURCE', 'FFMPEG', 'COMPONENTS', 'PATCH SETS', 'FILES THE PLATFORM SHIPS']);
    const ffmpeg = sectionOf(text, 'FFMPEG');
    // LICENSE.md, CREDITS (patched: patches are applied before the build), then the governing texts, each in full
    expect(ffmpeg).toContain('--- LICENSE.md ---\n\nFFmpeg LICENSE.md\n\n--- CREDITS ---\n\nFFmpeg CREDITS, patched by acme\n\n--- COPYING.LGPLv3 ---\n\nFFmpeg COPYING.LGPLv3\n\n--- COPYING.GPLv3 ---\n\nFFmpeg COPYING.GPLv3\n');
    expect(first.log).toContain('patch acme/0001-credits.patch');
  });

  it('says FFmpeg was modified, by which patch sets', () => {
    const text = notices(first.name);
    const header = text.split(RULE)[0]!;
    expect(header).toContain(`FFmpeg was modified by these patch sets (applied to its source before it was configured; see PATCH SETS below):\n  acme: 1 patch (0001-credits.patch), sha256 ${'ab'.repeat(32)}`);
    expect(sectionOf(text, 'PATCH SETS')).toContain(`== acme ==\n\nLicense: MIT\nsha256: ${'ab'.repeat(32)}\nPatches: 0001-credits.patch\n\n--- LICENSE ---\n\nAcme licence\n`);
  });

  it("names FFmpeg's configure line as it was built, the toolchain and the platform", () => {
    const build = sectionOf(notices(first.name), 'BUILD');
    expect(build).toContain('FFmpeg configure line (as ffmpeg -buildconf prints it):\n  --prefix=/work/install --enable-gpl --extra-cflags=-DX="a b"\n');
    expect(build).toContain('Toolchain identity: f00d');
    expect(build).toContain('Platform: linux-x64, built in the toolchain image images/linux-x64, set up by platforms/setup/fake.sh');
  });

  it('puts every declared licence file, in full, under its library, the libraries sorted by name, with their origin', () => {
    const components = sectionOf(notices(first.name), 'COMPONENTS');
    const commit = bash('git -C "$T/repos/beta" rev-parse HEAD').trim();
    const [alpha, beta] = sources(first.name).libraries.sort((a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1));
    expect(components.indexOf('== alpha 1.0 ==')).toBeLessThan(components.indexOf('== beta 1.0 =='));
    expect(components).toContain(`== alpha 1.0 ==\n\nLicense: MIT\nOrigin: file://${sh(T)}/dl/alpha-1.0.tar.gz\nSource: alpha/alpha-1.0.tar.gz (sha256 ${alpha.sha256})\n\n--- COPYING ---\n\nalpha copying\n\n--- docs/NOTICE.txt ---\n\nalpha notice, no final newline\n\n`);
    expect(components).toContain(`== beta 1.0 ==\n\nLicense: BSD-2-Clause\nOrigin: ${beta.origin}\nCommit: ${commit}\nSource: beta/beta-${commit}.tar.gz (sha256 ${beta.sha256})\n\n--- LICENSE.md ---\n\nbeta license\n\n--- LICENSE ---\n\nbeta licence, kept beside the recipe\n`);
    expect(sectionOf(notices(first.name), 'FILES THE PLATFORM SHIPS')).toContain('== libfoo.so ==\n\nLicense: Zlib\n\n--- NOTICE ---\n\nlibfoo notice\n');
  });

  it('points an unreleased build at its recorded sources, with no offer to send them', () => {
    const source = sectionOf(notices(first.name), 'SOURCE');
    expect(source).toContain(`Its source is recorded in\n${first.name}.sources.json beside it`);
    expect(source).toContain('It must be published together with its sources archive (ffmpeg-9.0.0-sources.tar.gz) before it is\ndistributed.');
    expect(source).toContain('Build definition: https://github.com/acme/media-builds/tree/c0ffee');
    expect(source).toContain('FFmpeg 9.0.0, unmodified upstream: https://ffmpeg.org/releases/ffmpeg-9.0.0.tar.xz');
    expect(source).toContain('no request to the distributor is necessary');
    expect(source).not.toMatch(/on request|write to|contact/i);
  });

  it('keeps every source in the cache and lists them in <name>.sources.json', () => {
    const s = sources(first.name);
    expect(s).toMatchObject({ artifact: first.name, target: 'fake-lgplv3', platform: 'linux-x64', license: 'lgplv3', release: null, patches: [{ name: 'acme', sha256: 'ab'.repeat(32) }] });
    expect(s.ffmpeg).toEqual({ name: 'ffmpeg', version: '9.0.0', origin: `file://${sh(T)}/dl/ffmpeg-9.0.0.tar.gz`, file: 'ffmpeg/ffmpeg-9.0.0.tar.gz', sha256: sha256(join(T, 'dl', 'ffmpeg-9.0.0.tar.gz')) });
    const [beta, alpha] = s.libraries;
    // a tarball is kept as downloaded (from the url that worked)
    expect(alpha).toEqual({ name: 'alpha', version: '1.0', origin: `file://${sh(T)}/dl/alpha-1.0.tar.gz`, file: 'alpha/alpha-1.0.tar.gz', sha256: sha256(join(T, 'dl', 'alpha-1.0.tar.gz')), cached: false });
    expect(sha256(join(T, 'cache', 'sources', 'alpha', 'alpha-1.0.tar.gz'))).toBe(alpha.sha256);
    // a git checkout as git archive of its commit, with the repository the recipe cloned into it
    const commit = bash('git -C "$T/repos/beta" rev-parse HEAD').trim();
    expect(beta).toMatchObject({ name: 'beta', commit, file: `beta/beta-${commit}.tar.gz`, cached: false });
    expect(sha256(join(T, 'cache', 'sources', beta.file))).toBe(beta.sha256);
    const kept = bash(`tar -tzf "$T/cache/sources/${beta.file}" | LC_ALL=C sort`).trim().split('\n');
    expect(kept).toEqual(expect.arrayContaining([`beta-${commit}/LICENSE.md`, `beta-${commit}/beta.c`, `beta-${commit}/third_party/nested/N.txt`]));
    // as checked out: .gitattributes' export-ignore and export-subst don't apply
    expect(bash(`tar -xzOf "$T/cache/sources/${beta.file}" "beta-${commit}/version.h"`)).toBe('#define REV "$Format:%H$"\n');
  });

  it("puts each library's licence files and source record in its cache entry", () => {
    const entry = bash('tar -tzf "$T/cache/libs/alpha-key.tar.gz" | LC_ALL=C sort').trim().split('\n');
    expect(entry).toEqual(['lib/alpha.txt', 'share/ffmpeg-build/legal/alpha/COPYING', 'share/ffmpeg-build/legal/alpha/docs/NOTICE.txt', 'share/ffmpeg-build/sources/alpha.json']);
  });

  it('gives each licence its governing texts, with libraries from the cache still bringing theirs', () => {
    for (const license of LICENSES) {
      const r = drive(license, [BETA, ALPHA], 'acme-9.0.0.4');
      expect(r.code, r.log).toBe(0);
      expect(r.log).toContain('alpha 1.0: from cache');
      const text = notices(r.name);
      const governing = [...sectionOf(text, 'FFMPEG').matchAll(/^--- (COPYING\.[^ ]+) ---$/gm)].map((m) => m[1]);
      expect(governing, license).toEqual(GOVERNING_TEXTS[license]);
      for (const heading of ['--- COPYING ---\n\nalpha copying', '--- LICENSE.md ---\n\nbeta license', '--- LICENSE ---\n\nbeta licence, kept beside the recipe']) expect(text).toContain(heading);
      expect(sources(r.name).libraries.map((l: { cached: boolean }) => l.cached)).toEqual([true, true]);
      expect(sources(r.name).release).toBe('acme-9.0.0.4');
      const source = sectionOf(text, 'SOURCE');
      expect(source).toContain('  https://github.com/acme/media-builds/releases/download/acme-9.0.0.4/ffmpeg-9.0.0-sources.tar.gz\nThis archive, published with release acme-9.0.0.4, holds the complete corresponding source');
      // a nonfree build says it isn't offered to anyone
      expect(source.includes('it is for internal use only and is not offered for redistribution'), license).toBe(license === 'nonfree');
      expect(text.includes('This build is NOT REDISTRIBUTABLE.'), license).toBe(license === 'nonfree');
    }
  }, 300_000);

  it("stops, naming the patch, when one doesn't apply", () => {
    const stale = { name: '0002-stale.patch', text: '--- a/CREDITS\n+++ b/CREDITS\n@@ -1 +1 @@\n-something else\n+x\n' };
    const r = drive('lgplv3', [BETA, ALPHA], undefined, [stale]);
    expect(r.code).toBe(1);
    expect(r.log).toContain("ERROR: patches/acme: 0002-stale.patch doesn't apply to FFmpeg 9.0.0; update it for this version");
  }, 60_000);

  it('rebuilds a cached library whose kept source no longer matches its record, and keeps it again', () => {
    const beta = sources(first.name).libraries[0];
    writeFileSync(join(T, 'cache', 'sources', beta.file), 'not the archive');
    const r = drive('lgplv3');
    expect(r.code, r.log).toBe(0);
    expect(r.log).toContain("beta 1.0: the cache entry's source isn't on file under sources/ as recorded; building it again");
    expect(r.log).toContain('alpha 1.0: from cache');
    const again = sources(r.name).libraries[0];
    expect(again).toMatchObject({ file: beta.file, cached: false });
    expect(sha256(join(T, 'cache', 'sources', beta.file))).toBe(again.sha256);
  }, 60_000);

  it('rebuilds a cached library whose kept source is gone', () => {
    rmSync(join(T, 'cache', 'sources', 'alpha'), { recursive: true });
    const r = drive('lgplv3');
    expect(r.code, r.log).toBe(0);
    expect(r.log).toContain("alpha 1.0: the cache entry's source isn't on file under sources/ as recorded; building it again");
    expect(r.log).toContain('beta 1.0: from cache');
    expect(existsSync(join(T, 'cache', 'sources', 'alpha', 'alpha-1.0.tar.gz'))).toBe(true);
    expect(sources(r.name).libraries.map((l: { cached: boolean }) => l.cached)).toEqual([true, false]);
  }, 60_000);

  it('fails before writing the cache entry when a declared licence file is missing', () => {
    const r = drive('lgplv3', [GAMMA]);
    expect(r.code).not.toBe(0);
    expect(r.log).toContain('ERROR: gamma 1.0 has no COPYING, which recipes/gamma/recipe.yml lists in license-files');
    expect(existsSync(join(T, 'cache', 'libs', 'gamma-key.tar.gz'))).toBe(false);
  }, 60_000);

  it('refuses a download that differs from the kept copy of the same name', () => {
    bash('echo changed >"$T/srcs/alpha-1.0/README" && tar -czf "$T/dl/alpha-1.0.tar.gz" -C "$T/srcs" alpha-1.0 && rm -f "$T"/cache/libs/alpha-key.tar.gz');
    const r = drive('lgplv3');
    expect(r.code).not.toBe(0);
    expect(r.log).toContain('ERROR: the download of alpha/alpha-1.0.tar.gz differs from the copy the cache kept earlier');
  }, 60_000);
});
