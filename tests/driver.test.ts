// platforms/driver.sh end to end with the host's bash, on stand-ins: a fake platform setup, two small libraries (a
// tarball and a git checkout that clones another repository into itself, as shaderc's recipe does) and a fake FFmpeg
// whose configure and make only lay out files. What it checks is what 6a adds: the declared licence files, legal/ in
// both archives (the governing texts per licence), the kept sources, <name>.sources.json, and the library cache
// bringing all of it back. Needs bash, git, jq, GNU tar/find/coreutils; skipped where they're missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GOVERNING_TEXTS } from '../src/build/plan.ts';
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

  // the engine: the real driver and legal template, a fake setup
  cpSync(join(packageRoot, 'platforms', 'driver.sh'), join(T, 'engine', 'driver.sh'));
  cpSync(join(packageRoot, 'platforms', 'legal'), join(T, 'engine', 'legal'), { recursive: true });
  write(join(T, 'engine', 'setup', 'fake.sh'), [
    'CMAKE_CROSS_ARGS=()', 'MESON_CROSS_ARGS=()', `export FAKE_TOOLCHAIN="${sh(T)}/toolchain"`,
    'before_ffmpeg() { :; }',
    'stage() { cp -a "$1/lib/." "$2/"; mkdir -p "$3/include"; cp -a "$1/include/." "$3/include/"; }',
    'check_stage() { [ -f "$1/legal/LICENSE-NOTICE.txt" ]; }', '',
  ].join('\n'));
  write(join(T, 'toolchain', 'NOTICE'), 'libfoo notice\n');

  // recipes: alpha (a tarball), beta (git, with a licence file kept beside its recipe), gamma (declares a file it lacks)
  write(join(T, 'recipes', 'lib.sh'), '# recipes/lib.sh stand-in\n');
  write(join(T, 'recipes', 'alpha', 'build.sh'), 'mkdir -p "${DEPS_DIR}/lib"\ncp README "${DEPS_DIR}/lib/alpha.txt"\n');
  write(join(T, 'recipes', 'beta', 'build.sh'), `git clone -q "${sh(T)}/repos/nested" third_party/nested\nmkdir -p "\${DEPS_DIR}/lib"\necho beta >"\${DEPS_DIR}/lib/beta.txt"\n`);
  write(join(T, 'recipes', 'beta', 'LICENSE'), 'beta licence, kept beside the recipe\n');
  write(join(T, 'recipes', 'gamma', 'build.sh'), 'mkdir -p "${DEPS_DIR}/lib"\necho gamma >"${DEPS_DIR}/lib/gamma.txt"\n');

  // sources: alpha's tarball, beta's and nested's repositories, FFmpeg's tarball with its COPYING texts
  write(join(T, 'srcs', 'alpha-1.0', 'COPYING'), 'alpha copying\n');
  write(join(T, 'srcs', 'alpha-1.0', 'docs', 'NOTICE.txt'), 'alpha notice\n');
  write(join(T, 'srcs', 'alpha-1.0', 'README'), 'alpha\n');
  write(join(T, 'repos', 'beta', 'LICENSE.md'), 'beta license\n');
  write(join(T, 'repos', 'beta', 'beta.c'), 'int beta;\n');
  write(join(T, 'repos', 'beta', 'version.h'), '#define REV "$Format:%H$"\n');
  // what git archive would leave out or rewrite, and the kept source must not
  write(join(T, 'repos', 'beta', '.gitattributes'), 'beta.c export-ignore\nversion.h export-subst\n');
  write(join(T, 'repos', 'nested', 'N.txt'), 'nested\n');
  const ff = join(T, 'srcs', 'ffmpeg-9.0.0');
  write(join(ff, 'configure'), '#!/usr/bin/env bash\nfor a; do case "$a" in --prefix=*) echo "${a#--prefix=}" >.prefix ;; esac; done\nmkdir -p ffbuild\necho CONFIG_FAKE=yes >ffbuild/config.mak\necho "#define FFMPEG_CONFIGURATION \\"$*\\"" >config.h\n');
  for (const f of ['LICENSE.md', 'CREDITS', 'COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3']) write(join(ff, f), `FFmpeg ${f}\n`);
  bash(`
    mkdir -p "$T/dl" && tar -czf "$T/dl/alpha-1.0.tar.gz" -C "$T/srcs" alpha-1.0 && tar -czf "$T/dl/ffmpeg-9.0.0.tar.gz" -C "$T/srcs" ffmpeg-9.0.0
    for r in beta nested; do
      git -C "$T/repos/$r" init -q -b main && git -C "$T/repos/$r" add -A && git -C "$T/repos/$r" -c user.name=t -c user.email=t@t commit -q -m one
    done`);
}

type Lib = { name: string; source: object; licenseFiles: { path: string; recipe?: true }[] };
const ALPHA: Lib = { name: 'alpha', source: { archives: ['file:///nowhere/alpha-1.0.tar.gz', 'file://$T/dl/alpha-1.0.tar.gz'] }, licenseFiles: [{ path: 'COPYING' }, { path: 'docs/NOTICE.txt' }] };
const BETA: Lib = { name: 'beta', source: { git: '$T/repos/beta', ref: 'main' }, licenseFiles: [{ path: 'LICENSE.md' }, { path: 'LICENSE', recipe: true }] };
const GAMMA: Lib = { name: 'gamma', source: { git: '$T/repos/beta', ref: 'main' }, licenseFiles: [{ path: 'COPYING' }] };

// a patch to FFmpeg's CREDITS, which legal/ ships: proof in the archive that patches are applied before the build
const CREDITS_PATCH = { name: '0001-credits.patch', text: '--- a/CREDITS\n+++ b/CREDITS\n@@ -1 +1 @@\n-FFmpeg CREDITS\n+FFmpeg CREDITS, patched by acme\n' };

/** Runs the driver on a plan for `license` (and `libs`); its exit code and log. */
function drive(license: License, libs: Lib[] = [ALPHA, BETA], release?: string, patches = [CREDITS_PATCH]): { code: number; log: string; name: string } {
  const name = `ffmpeg-9.0.0-fake-${license}`;
  const at = (s: string) => s.replaceAll('$T', sh(T));
  const plan = {
    platform: 'linux-x64', setup: 'fake', name, target: `fake-${license}`, license, ...(release ? { release } : {}),
    sourcesArchive: 'ffmpeg-9.0.0-sources.tar.gz',
    libraries: libs.map((l) => ({ name: l.name, version: '1.0', key: `${l.name}-key`, cached: false, source: JSON.parse(at(JSON.stringify(l.source))), licenseFiles: l.licenseFiles })),
    runtime: [],
    ships: [{ file: 'libfoo.so', notice: '${FAKE_TOOLCHAIN}/NOTICE' }],
    patches: [{ name: 'acme', sha256: 'ab'.repeat(32), files: patches, licenses: [{ path: 'LICENSE', text: 'Acme licence\n' }] }],
    legal: { label: license, governing: GOVERNING_TEXTS[license], notice: `notice for ${license}\n` },
    ffmpeg: { version: '9.0.0', archives: [at('file://$T/dl/ffmpeg-9.0.0.tar.gz')], configure: [], verify: [] },
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
      FFMPEG_BUILD_SOURCE_REPO: 'https://example.com/acme/media', FFMPEG_BUILD_SOURCE_REF: 'c0ffee',
    },
  });
  return { code: r.status ?? 1, log: `${r.stdout}${r.stderr}`, name };
}

/** The files in an archive under out/, sorted. */
const listing = (archive: string) => bash(`tar -tzf "$T/out/${archive}" | sed 's|^\\./||' | grep -v '/$' | LC_ALL=C sort`).trim().split('\n');
const fileIn = (archive: string, path: string) => bash(`tar -xzOf "$T/out/${archive}" "./${path}"`);
const sources = (name: string) => JSON.parse(readFileSync(join(T, 'out', `${name}.sources.json`), 'utf8'));

describe.skipIf(!hasTools)('fill_template (platforms/legal/helpers.sh)', () => {
  const fill = (template: string, env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-fill-'));
    writeFileSync(join(dir, 't.txt'), template);
    return execFileSync('bash', ['-c', `source "${sh(join(packageRoot, 'platforms', 'legal', 'helpers.sh'))}"; fill_template "${sh(join(dir, 't.txt'))}"`], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10_000 });
  };

  it("never reads what a value brought in again (a value holding @KEY@ can't loop)", () => {
    expect(fill('repo: @REPO@ (@REF@)\n', { OFFER_REPO: 'https://h/@REPO@/@REF@', OFFER_REF: 'abc' })).toBe('repo: https://h/@REPO@/@REF@ (abc)\n');
  });

  it('keeps an @...@ it has no value for, and the text around it', () => {
    expect(fill('mail x@USER@y or @REPO@\n', { OFFER_REPO: 'r' })).toBe('mail x@USER@y or r\n');
    expect(fill('@A@@B@\n', { OFFER_A: 'one\ntwo', OFFER_B: '' })).toBe('one\ntwo\n');
  });
});

describe.skipIf(!hasTools)('the driver: legal files and sources', () => {
  let first: ReturnType<typeof drive>;
  beforeAll(() => {
    lay();
    first = drive('lgplv3');
  }, 120_000);

  it("applies the target's patches to FFmpeg's source before building", () => {
    expect(first.log).toContain('patch acme/0001-credits.patch');
    expect(fileIn(`${first.name}.tar.gz`, 'legal/CREDITS')).toBe('FFmpeg CREDITS, patched by acme\n');
  });

  it("stops, naming the patch, when one doesn't apply", () => {
    const stale = { name: '0002-stale.patch', text: '--- a/CREDITS\n+++ b/CREDITS\n@@ -1 +1 @@\n-something else\n+x\n' };
    const r = drive('lgplv3', [ALPHA, BETA], undefined, [stale]);
    expect(r.code).toBe(1);
    expect(r.log).toContain("ERROR: patches/acme: 0002-stale.patch doesn't apply to FFmpeg 9.0.0; update it for this version");
  });

  it('builds, and puts legal/ in both archives', () => {
    expect(first.code, first.log).toBe(0);
    const legal = [
      'legal/COPYING.GPLv3', 'legal/COPYING.LGPLv3', 'legal/CREDITS', 'legal/LICENSE-NOTICE.txt', 'legal/LICENSE.md', 'legal/SOURCE_OFFER.txt',
      'legal/licenses/alpha/COPYING', 'legal/licenses/alpha/docs/NOTICE.txt', 'legal/licenses/beta/LICENSE', 'legal/licenses/beta/LICENSE.md',
      'legal/licenses/libfoo.so/NOTICE', 'legal/licenses/patches-acme/LICENSE',
    ];
    expect(listing(`${first.name}.tar.gz`).filter((f) => f.startsWith('legal/'))).toEqual(legal);
    expect(listing(`${first.name}-dev.tar.gz`).filter((f) => f.startsWith('legal/'))).toEqual(legal);
    expect(fileIn(`${first.name}.tar.gz`, 'legal/licenses/alpha/docs/NOTICE.txt')).toBe('alpha notice\n');
    expect(fileIn(`${first.name}.tar.gz`, 'legal/licenses/beta/LICENSE')).toBe('beta licence, kept beside the recipe\n');
    expect(fileIn(`${first.name}.tar.gz`, 'legal/licenses/patches-acme/LICENSE')).toBe('Acme licence\n');
    expect(fileIn(`${first.name}.tar.gz`, 'legal/licenses/libfoo.so/NOTICE')).toBe('libfoo notice\n');
    expect(fileIn(`${first.name}.tar.gz`, 'legal/LICENSE-NOTICE.txt')).toBe('notice for lgplv3\n');
  });

  it('fills SOURCE_OFFER.txt: version, licence, target, repository and commit, and an unreleased build says so', () => {
    const offer = fileIn(`${first.name}.tar.gz`, 'legal/SOURCE_OFFER.txt');
    expect(offer).toContain('FFmpeg 9.0.0 — lgplv3 build (linux-x64, target fake-lgplv3)');
    expect(offer).toContain('    https://example.com/acme/media (commit c0ffee)');
    expect(offer).toContain('This build is unreleased');
    expect(offer).toContain(`${first.name}.sources.json`);
    expect(offer).toContain('ffmpeg-9.0.0-sources.tar.gz');
    expect(offer).toContain('as required by the GNU lgplv3');
    expect(offer).not.toMatch(/@[A-Z_]+@/);
  });

  it('keeps every source in the cache and lists them in <name>.sources.json', () => {
    const s = sources(first.name);
    expect(s).toMatchObject({ artifact: first.name, target: 'fake-lgplv3', platform: 'linux-x64', license: 'lgplv3', release: null, patches: [{ name: 'acme', sha256: 'ab'.repeat(32) }] });
    expect(s.ffmpeg).toEqual({ name: 'ffmpeg', version: '9.0.0', origin: `file://${sh(T)}/dl/ffmpeg-9.0.0.tar.gz`, file: 'ffmpeg/ffmpeg-9.0.0.tar.gz', sha256: sha256(join(T, 'dl', 'ffmpeg-9.0.0.tar.gz')) });
    const [alpha, beta] = s.libraries;
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
      const r = drive(license, [ALPHA, BETA], 'acme-9.0.0.4');
      expect(r.code, r.log).toBe(0);
      expect(r.log).toContain('alpha 1.0: from cache');
      const files = listing(`${r.name}.tar.gz`);
      expect(files.filter((f) => /^legal\/COPYING/.test(f))).toEqual(GOVERNING_TEXTS[license].map((t) => `legal/${t}`).sort());
      expect(files).toEqual(expect.arrayContaining(['legal/licenses/alpha/COPYING', 'legal/licenses/beta/LICENSE.md', 'legal/licenses/beta/LICENSE']));
      expect(sources(r.name).libraries.map((l: { cached: boolean }) => l.cached)).toEqual([true, true]);
      expect(sources(r.name).release).toBe('acme-9.0.0.4');
      const offer = fileIn(`${r.name}.tar.gz`, 'legal/SOURCE_OFFER.txt');
      expect(offer).toContain('It ships in release acme-9.0.0.4. That release\'s sources archive, ffmpeg-9.0.0-sources.tar.gz,');
      // a nonfree build says it isn't offered to anyone
      expect(offer.includes('is for internal use only and is not\noffered for redistribution'), license).toBe(license === 'nonfree');
      expect(offer.endsWith('alongside the governing license text for this build.\n'), license).toBe(license !== 'nonfree');
    }
  }, 300_000);

  it('rebuilds a cached library whose kept source no longer matches its record, and keeps it again', () => {
    const beta = sources(first.name).libraries[1];
    writeFileSync(join(T, 'cache', 'sources', beta.file), 'not the archive');
    const r = drive('lgplv3');
    expect(r.code, r.log).toBe(0);
    expect(r.log).toContain("beta 1.0: the cache entry's source isn't on file under sources/ as recorded; building it again");
    expect(r.log).toContain('alpha 1.0: from cache');
    const again = sources(r.name).libraries[1];
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
    expect(sources(r.name).libraries.map((l: { cached: boolean }) => l.cached)).toEqual([false, true]);
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
