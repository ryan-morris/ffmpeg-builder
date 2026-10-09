// The discovery lint (release design, 6a): in a library's source, every COPYING*, LICENSE*, LICENCE*, COPYRIGHT* or
// NOTICE* file at any depth that its recipe doesn't declare in license-files is listed.
//
// It lists, it doesn't fail. license-files is the source of truth, reviewed per recipe; most candidates are licences of
// code that isn't built into the library (tests, examples, vendored copies of dependencies the build takes from
// another recipe, tools that only run at build time). Failing on them would push recipes into declaring texts
// that don't apply, or grow an ignore list that is just a second, unreviewed license-files. What does fail: a
// declared file that isn't in the source.
//
// The lint itself runs on a fixture every time. Over real sources it runs on what a build kept: point
// FFMPEG_BUILD_LINT_SOURCES at a build's <name>.sources.json (or a folder of them); each library is linted in the
// kept source of the exact version that build used, found in the cache (FFMPEG_BUILD_CACHE, default
// ~/.cache/ffmpeg-build). vitest hides a passing test's output; to read the list:
//   FFMPEG_BUILD_LINT_SOURCES=dist FFMPEG_BUILD_CACHE=<cache> npx vitest run tests/license-lint.test.ts --silent=false
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import type { LicenseFile } from '../src/schema/engine.ts';

const CANDIDATE = /^(COPYING|LICENSE|LICENCE|COPYRIGHT|NOTICE)/i;

/** The files in a kept source, relative to its top folder (tar reads .tar.gz, .tar.xz and .tar.bz2 alike). */
function filesIn(archive: string): string[] {
  // run beside it, by its name: GNU tar reads a drive letter (C:) as a remote host
  const out = execFileSync('tar', ['-tf', basename(archive)], { cwd: dirname(archive), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, '').split('/').slice(1).join('/'));
}

/** What the lint finds in a source's files: declared files it lacks (a failure), undeclared candidates (a list). */
function lint(declaredFiles: readonly LicenseFile[], files: readonly string[]): { missing: string[]; undeclared: string[] } {
  const declared = declaredFiles.filter((f) => !f.recipe).map((f) => f.path);
  return {
    missing: declared.filter((d) => !files.includes(d)),
    undeclared: files.filter((f) => CANDIDATE.test(f.split('/').pop()!) && !declared.includes(f)),
  };
}

describe('the discovery lint', () => {
  it('lists undeclared candidates at any depth and finds declared files a source lacks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-lint-'));
    for (const f of ['COPYING', 'README', 'test/data/LICENSE.txt', 'third_party/x/Copyright', 'docs/notice.md', 'src/main.c']) {
      mkdirSync(dirname(join(dir, 'x-1.0', f)), { recursive: true });
      writeFileSync(join(dir, 'x-1.0', f), f);
    }
    execFileSync('tar', ['-czf', 'x-1.0.tar.gz', 'x-1.0'], { cwd: dir });
    const files = filesIn(join(dir, 'x-1.0.tar.gz'));
    expect(lint([{ path: 'COPYING' }, { path: 'PATENTS' }, { path: 'LICENSE', recipe: true }], files)).toEqual({
      missing: ['PATENTS'],
      undeclared: expect.arrayContaining(['test/data/LICENSE.txt', 'third_party/x/Copyright', 'docs/notice.md']),
    });
    expect(lint([{ path: 'COPYING' }], files).undeclared).toHaveLength(3);
  });
});

// the library records of the builds named by FFMPEG_BUILD_LINT_SOURCES: each kept source at the version it was built
const data = loadEngineData(packageRoot);
const cacheSources = join(resolve(process.env.FFMPEG_BUILD_CACHE ?? join(homedir(), '.cache', 'ffmpeg-build')), 'sources');
const records = (() => {
  const at = process.env.FFMPEG_BUILD_LINT_SOURCES;
  if (!at) return [];
  const files = statSync(at).isDirectory() ? readdirSync(at).filter((f) => f.endsWith('.sources.json')).map((f) => join(at, f)) : [at];
  const seen = new Map<string, { recipe: string; version: string; archive: string }>();
  for (const f of files) {
    for (const l of JSON.parse(readFileSync(f, 'utf8')).libraries as { name: string; version: string; file: string }[]) {
      if (data.recipes.has(l.name)) seen.set(`${l.name}@${l.version}`, { recipe: l.name, version: l.version, archive: join(cacheSources, l.file) });
    }
  }
  return [...seen.values()];
})();

describe.skipIf(!records.length)('licence files in the kept sources of a build (FFMPEG_BUILD_LINT_SOURCES)', () => {
  it.each(records)('$recipe $version', ({ recipe, archive }) => {
    expect(existsSync(archive), `${archive} is not in the cache`).toBe(true);
    const { missing, undeclared } = lint(data.recipes.get(recipe)!['license-files'], filesIn(archive));
    expect(missing, `declared but not in ${archive}`).toEqual([]);
    if (undeclared.length) console.log(`${recipe}: not declared (review, then declare what is built in): ${undeclared.join(', ')}`);
  });
});
