// The reusable workflows' engine input: "source", an npm version, or a git/npm spec (github:owner/repo#ref), passed
// through env and installed by each workflow's engine step. Runs those steps' scripts with a stand-in npm.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

interface Step { name?: string; run?: string; env?: Record<string, string> }
interface Workflow { jobs: Record<string, { steps: Step[] }> }

const engineSteps = (file: string): Step[] =>
  Object.values((parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as Workflow).jobs)
    .flatMap((j) => j.steps)
    .filter((s) => s.run?.includes('npm install --global'));

const bash = process.platform === 'win32' ? gitBash() : 'bash';

/** What npm was asked to do when the step's script runs with `vars` set. */
function npmCalls(step: Step, vars: Record<string, string>): string[] {
  const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-npm-'));
  const log = join(bin, 'log');
  // npm pack prints the file it made, last
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho "$*" >> "${log.replaceAll('\\', '/')}"\n[ "$1" = pack ] && echo ffmpeg-build-0.2.0.tgz\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'ffmpeg.lock'), 'engine: 0.2.0\n');
  const r = spawnSync(bash!, ['-c', step.run!], { cwd: bin, encoding: 'utf8', env: { ...process.env, ...vars, GITHUB_WORKSPACE: bin, RUNNER_TEMP: '/tmp/rt', PATH: `${bin}${delimiter}${process.env.PATH}` } });
  expect(r.status, r.stderr).toBe(0);
  try {
    return readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

describe.skipIf(!bash)("the workflows' engine input", () => {
  for (const [file, count, variable] of [['build.yml', 4, 'ENGINE'], ['update.yml', 1, 'WANTED'], ['fetch-update.yml', 1, 'ENGINE']] as const) {
    it(`${file}: a git spec packed then installed, a version from npm, source from this repository; never in the script text`, () => {
      const steps = engineSteps(file);
      expect(steps).toHaveLength(count);
      for (const step of steps) {
        expect(step.run).not.toContain('${{'); // the input reaches the script through env only
        // packed first: npm install --global <git spec> runs its prepare without its devDependencies (no tsc)
        expect(npmCalls(step, { [variable]: 'github:ryan-morris/ffmpeg-builder#main' })).toEqual([
          'pack --silent --pack-destination /tmp/rt github:ryan-morris/ffmpeg-builder#main',
          'install --global /tmp/rt/ffmpeg-build-0.2.0.tgz',
        ]);
        expect(npmCalls(step, { [variable]: '0.3.0' })).toEqual(['install --global ffmpeg-build@0.3.0']);
        expect(npmCalls(step, { [variable]: 'source' })).toEqual(['ci', 'run build', 'link']);
      }
    });
  }

  it("update.yml takes the lock's engine version when the input is empty", () => {
    expect(npmCalls(engineSteps('update.yml')[0]!, { WANTED: '' })).toEqual(['install --global ffmpeg-build@0.2.0']);
  });
});

const step = (file: string, name: string): Step =>
  Object.values((parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as Workflow).jobs)
    .flatMap((j) => j.steps)
    .find((s) => s.name === name)!;

/**
 * The gh (and git) calls a step's script makes, with stand-ins: git succeeds (and `git diff --quiet` says "changed"),
 * gh prints `ghOut` for `gh pr list`. Each call is logged with the GH_TOKEN it ran with.
 */
function calls(s: Step, vars: Record<string, string>, ghOut = ''): string[] {
  const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-gh-'));
  const log = join(bin, 'log').replaceAll('\\', '/');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "gh[$GH_TOKEN] $*" >> "${log}"\n[ "$1 $2" = "pr list" ] && printf '%s' "${ghOut}"\nexit 0\n`, { mode: 0o755 });
  // git as a function: it wins over any git on PATH (Git Bash puts its own first)
  const fakeGit = 'git() { if [ "$1" = diff ]; then return 1; fi; return 0; }\n';
  const r = spawnSync(bash!, ['-e', '-c', fakeGit + s.run!], { cwd: bin, encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'job-token', GITHUB_STEP_SUMMARY: join(bin, 'summary'), RUNNER_TEMP: bin, BRANCH: 'ffmpeg-build/update', ...vars, PATH: `${bin}${delimiter}${process.env.PATH}` } });
  expect(r.status, r.stderr).toBe(0);
  try {
    return readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

describe.skipIf(!bash)("the PR's CI and automerge, without a token or repository settings", () => {
  const base = { FOLDER: '.', CHANGE: 'ffmpeg.version: o/r@9.0.2.3', CI_WORKFLOW: 'ci.yml', DISPATCH_TOKEN: 'github-token', LABEL: 'ffmpeg-build:automerge' };
  for (const [file, name] of [['update.yml', 'open or refresh the pull request'], ['fetch-update.yml', 'open or refresh the pull request']] as const) {
    it(`${file}: dispatches CI with GITHUB_TOKEN when no token was given, and labels instead of gh pr merge --auto`, () => {
      const s = step(file, name);
      expect(s.run).not.toContain('--auto');
      const without = calls(s, { ...base, HAS_TOKEN: 'false', AUTOMERGE: 'true' });
      expect(without).toContain('gh[github-token] workflow run ci.yml --ref ffmpeg-build/update');
      expect(without).toContain('gh[job-token] label create ffmpeg-build:automerge --force --color 0e8a16 --description ffmpeg-build merges this PR once its CI passes');
      expect(without).toContain('gh[job-token] pr edit ffmpeg-build/update --add-label ffmpeg-build:automerge');
      // a token's push starts CI itself; no automerge, no label; an empty ci-workflow dispatches nothing
      const withToken = calls(s, { ...base, HAS_TOKEN: 'true', AUTOMERGE: 'false' });
      expect(withToken.filter((c) => / workflow run | label /.test(c))).toEqual([]);
      expect(calls(s, { ...base, HAS_TOKEN: 'false', AUTOMERGE: 'false', CI_WORKFLOW: '' }).filter((c) => c.includes('workflow run'))).toEqual([]);
    });
  }

  it('ffmpeg-support.yml dispatches the engine ci.yml after a GITHUB_TOKEN push only', () => {
    const s = step('ffmpeg-support.yml', 'open or refresh the pull request');
    writeFileSync(join(tmpdir(), 'support.md'), '**new in 9.1.0**\n');
    const vars = { BRANCH: 'ffmpeg-build/ffmpeg-support', DISPATCH_TOKEN: 'github-token', RUNNER_TEMP: tmpdir() };
    expect(calls(s, { ...vars, HAS_TOKEN: 'false' })).toContain('gh[github-token] workflow run ci.yml --ref ffmpeg-build/ffmpeg-support');
    expect(calls(s, { ...vars, HAS_TOKEN: 'true' }).filter((c) => c.includes('workflow run'))).toEqual([]);
  });

  describe('automerge.yml', () => {
    const s = step('automerge.yml', 'merge the labelled pull request the run tested');
    const vars = { BRANCH: 'ffmpeg-build/update', SHA: 'abc123', LABEL: 'ffmpeg-build:automerge' };

    it('merges the labelled ffmpeg-build PR whose head is the commit the passing run tested', () => {
      const c = calls(s, vars, '7 abc123');
      expect(c[0]).toBe('gh[job-token] pr list --head ffmpeg-build/update --state open --label ffmpeg-build:automerge --json number,headRefOid --jq .[] | "\\(.number) \\(.headRefOid)"');
      expect(c).toContain('gh[job-token] pr merge 7 --squash --match-head-commit abc123');
    });

    it("never merges a newer push, an unlabelled PR, or another branch", () => {
      expect(calls(s, vars, '7 def456').filter((c) => c.includes('pr merge'))).toEqual([]);
      expect(calls(s, vars, '').filter((c) => c.includes('pr merge'))).toEqual([]);
      expect(calls(s, { ...vars, BRANCH: 'feature/x' }, '7 abc123')).toEqual([]);
    });
  });
});
