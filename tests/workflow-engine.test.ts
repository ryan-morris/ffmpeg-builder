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

/** What npm was asked to do when the step's script runs with `vars` set, beside an ffmpeg.lock of `lock`. */
function npmCalls(step: Step, vars: Record<string, string>, lock = 'engine: 0.2.0\n'): string[] {
  const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-npm-'));
  const log = join(bin, 'log');
  // npm pack prints the file it made, last
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho "$*" >> "${log.replaceAll('\\', '/')}"\n[ "$1" = pack ] && echo ffmpeg-build-0.2.0.tgz\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'ffmpeg.lock'), lock);
  const r = spawnSync(bash!, ['-c', step.run!], { cwd: bin, encoding: 'utf8', env: { ...process.env, ...vars, GITHUB_WORKSPACE: bin, RUNNER_TEMP: '/tmp/rt', PATH: `${bin}${delimiter}${process.env.PATH}` } });
  expect(r.status, r.stderr).toBe(0);
  try {
    return readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

describe.skipIf(!bash)("the workflows' engine input", () => {
  for (const [file, count, variable] of [['build.yml', 5, 'ENGINE'], ['update.yml', 1, 'WANTED'], ['fetch-update.yml', 1, 'ENGINE']] as const) {
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

  it("update.yml takes npm's latest when neither the input nor the lock names an engine", () => {
    expect(npmCalls(engineSteps('update.yml')[0]!, { WANTED: '' }, '')).toEqual(['install --global ffmpeg-build@latest']);
  });

  it('the defaults are what docs/releases.md says: the lock (build, update), latest (fetch-update)', () => {
    const inputs = (file: string) => (parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as { on: { workflow_call: { inputs: Record<string, { default?: string }> } } }).on.workflow_call.inputs;
    expect(inputs('build.yml').engine!.default).toBe('');
    expect(inputs('update.yml').engine!.default).toBe('');
    expect(inputs('fetch-update.yml').engine!.default).toBe('latest');
    const docs = readFileSync(join(packageRoot, 'docs', 'releases.md'), 'utf8');
    expect(docs).not.toContain('every workflow defaults');
    expect(docs).toContain("- **`fetch-update.yml`:** `latest`, npm's newest release");
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

const jq = spawnSync('jq', ['--version']).status === 0;

/** Runs build.yml's plan step with a stand-in ffmpeg-build whose `releases --json` prints `rows`; its outputs. */
function plan(rows: unknown, vars: Record<string, string> = {}): { status: number | null; out: Record<string, string>; stderr: string; calls: string[] } {
  const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-plan-'));
  const log = join(bin, 'log').replaceAll('\\', '/');
  writeFileSync(join(bin, 'rows.json'), JSON.stringify(rows));
  writeFileSync(join(bin, 'ffmpeg-build'), `#!/usr/bin/env bash\necho "$*" >> "${log}"\n[ "$1" = releases ] && cat "${join(bin, 'rows.json').replaceAll('\\', '/')}"\nexit 0\n`, { mode: 0o755 });
  const output = join(bin, 'output');
  const r = spawnSync(bash!, ['-e', '-c', step('build.yml', 'releases').run!], { cwd: bin, encoding: 'utf8', env: { ...process.env, PUBLISH: 'changed-only', TESTS: 'all', ...vars, RUNNER_TEMP: bin, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(bin, 'summary'), PATH: `${bin}${delimiter}${process.env.PATH}` } });
  let text = '';
  try { text = readFileSync(output, 'utf8'); } catch { /* none */ }
  let calls: string[] = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n'); } catch { /* none */ }
  return { status: r.status, stderr: `${r.stdout}${r.stderr}`, calls, out: Object.fromEntries(text.trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
}

describe.skipIf(!bash || !jq)('build.yml runs every build where it can, and releases only what passed', () => {
  const target = (name: string, platform: string, runner: string, testRunner = runner) => ({ name, platform, runner, testRunner, cacheKey: `k-${name}` });
  const rows = [{ tag: '9.0.2.0', due: true, reasons: ['never released'], targets: [
    target('lin', 'linux-x64', 'ubuntu-24.04'), target('win', 'win-x64', 'ubuntu-24.04', 'windows-2025'), target('arm', 'win-arm64', 'ubuntu-24.04', 'windows-11-arm'),
  ] }];

  it('gives the test job only the builds their build runner cannot run, on the runner that can', () => {
    const r = plan(rows);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.out.tests!)).toEqual({ include: [
      { release: '9.0.2.0', target: 'win', platform: 'win-x64', testRunner: 'windows-2025' },
      { release: '9.0.2.0', target: 'arm', platform: 'win-arm64', testRunner: 'windows-11-arm' },
    ] });
    expect(r.out.any_tests).toBe('true');
    expect(JSON.parse(r.out.matrix!).include[1]).toMatchObject({ target: 'win', runner: 'ubuntu-24.04', testRunner: 'windows-2025' });
    expect(plan([{ ...rows[0], targets: [rows[0]!.targets[0]] }]).out.any_tests).toBe('false');
  });

  it('needs the tests before it releases, and all-builds needs them too', () => {
    const jobs = (parse(readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8')) as { jobs: Record<string, { needs?: string[]; if?: string; 'runs-on'?: string; steps: Step[] }> }).jobs;
    expect(jobs.test!['runs-on']).toBe('${{ matrix.testRunner }}');
    expect(jobs.test!.if).toContain("inputs.tests == 'all'");
    expect(jobs.test!.steps.at(-1)!.run).toContain('--must-run');
    expect(jobs.release!.needs).toContain('test');
    expect(jobs.release!.if).toContain("(needs.test.result == 'success' || needs.test.result == 'skipped')");
    expect(jobs['all-builds']!.needs).toContain('test');
    // on its build runner a build must run when that is the runner meant to run it
    const t = jobs.build!.steps.find((s) => s.name === 'test ${{ matrix.target }}')!;
    expect(t.env).toEqual({ HERE: '${{ matrix.testRunner == matrix.runner }}' });
    expect(t.run).toContain('--must-run');
  });
});

describe.skipIf(!bash)("build.yml refuses an input it doesn't know before anything builds", () => {
  const check = (vars: Record<string, string>) => {
    const s = step('build.yml', 'inputs');
    const r = spawnSync(bash!, ['-e', '-c', s.run!], { encoding: 'utf8', env: { ...process.env, PUBLISH: 'changed-only', TESTS: 'all', ...vars } });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("is the plan job's first step, reading the inputs through env", () => {
    const jobs = (parse(readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8')) as Workflow).jobs;
    const first = jobs.plan!.steps[0]!;
    expect(first.name).toBe('inputs');
    expect(first.env).toEqual({ PUBLISH: '${{ inputs.publish }}', TESTS: '${{ inputs.tests }}' });
    expect(first.run).not.toContain('${{');
  });

  it('takes exactly the documented values', () => {
    for (const publish of ['changed-only', 'always', 'never']) {
      for (const tests of ['all', 'build-runner', 'none']) expect(check({ PUBLISH: publish, TESTS: tests }).status).toBe(0);
    }
  });

  it('stops on anything else, naming the input and what it takes', () => {
    // before, "changed_only" built every release and "Never" published
    for (const publish of ['changed_only', 'Never', 'no', '']) {
      const r = check({ PUBLISH: publish });
      expect(r.status, publish).toBe(1);
      expect(r.out).toContain(`::error::build.yml input publish is "${publish}"; it takes changed-only, always or never`);
    }
    const r = check({ TESTS: 'windows' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('::error::build.yml input tests is "windows"; it takes all, build-runner or none');
  });
});
