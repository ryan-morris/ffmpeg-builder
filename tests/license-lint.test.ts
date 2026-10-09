// The discovery lint (release design, 6a): for every recipe whose source a build has kept in the cache
// (FFMPEG_BUILD_CACHE, default ~/.cache/ffmpeg-build, under sources/<recipe>/), every COPYING*, LICENSE*, LICENCE*,
// COPYRIGHT* or NOTICE* file at any depth that the recipe doesn't declare in license-files is listed.
//
// It lists, it doesn't fail. license-files is the source of truth, reviewed per recipe; most candidates are licences of
// code that isn't built into the library (tests, examples, vendored copies of dependencies the build takes from
// another recipe, tools that only run at build time). Failing on them would push recipes into declaring texts
// that don't apply, or grow an ignore list that is just a second, unreviewed license-files. What does fail: a
// declared file that isn't in the kept source (the build would have failed too, so this catches a kept source that
// doesn't match its recipe). vitest hides a passing test's output; to read the list:
//   FFMPEG_BUILD_CACHE=<cache> npx vitest run tests/license-lint.test.ts --silent=false
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const sources = join(resolve(process.env.FFMPEG_BUILD_CACHE ?? join(homedir(), '.cache', 'ffmpeg-build')), 'sources');
const CANDIDATE = /^(COPYING|LICENSE|LICENCE|COPYRIGHT|NOTICE)/i;

/** The newest kept source of a recipe, if a build kept one. */
function keptSource(recipe: string): string | undefined {
  const dir = join(sources, recipe);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => !f.includes('.tmp.')).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** The files in a kept source, relative to its top folder (tar reads .tar.gz, .tar.xz and .tar.bz2 alike). */
function filesIn(archive: string): string[] {
  // run beside it, by its name: GNU tar reads a drive letter (C:) as a remote host
  const out = execFileSync('tar', ['-tf', basename(archive)], { cwd: dirname(archive), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, '').split('/').slice(1).join('/'));
}

const kept = [...data.recipes.keys()].map((r) => ({ recipe: r, archive: keptSource(r) })).filter((k): k is { recipe: string; archive: string } => !!k.archive);

describe.skipIf(!kept.length)('licence files in the kept sources (discovery lint)', () => {
  it.each(kept)('$recipe', ({ recipe, archive }) => {
    const files = filesIn(archive);
    const declared = data.recipes.get(recipe)!['license-files'].filter((f) => !f.recipe).map((f) => f.path);
    expect(declared.filter((d) => !files.includes(d)), `declared but not in ${archive}`).toEqual([]);
    const undeclared = files.filter((f) => CANDIDATE.test(f.split('/').pop()!) && !declared.includes(f));
    if (undeclared.length) console.log(`${recipe}: not declared (review, then declare what is built in): ${undeclared.join(', ')}`);
  });
});
