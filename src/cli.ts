#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { BuildError } from './build/docker.ts';
import { runTargetBuild } from './commands/build.ts';
import { runFolderLockOrUpdate, runFolderOutdated } from './commands/folder-versions.ts';
import { FolderError, openFolder, runFolderCheck, runFolderEdit, runFolderInit, runFolderMissing, runFolderPlan, runShow, runShowHas, runTargets } from './commands/folder.ts';
import { runMigrate } from './commands/migrate.ts';
import { runReleases } from './commands/releases.ts';
import { runOptions } from './commands/options.ts';
import { UpstreamFailure, WriteError } from './commands/versions.ts';
import { EngineDataError, loadEngineData } from './engine-data.ts';
import { fetchRelease, FetchError, updatePin } from './fetch.ts';
import { selectionFrom } from './folder-init.ts';
import { bundle, BundleError } from './bundle.ts';
import { LOCK_FILE, LockError, readFolderLock } from './lockfile.ts';
import { ManifestError, parseManifest } from './manifest.ts';
import { EditError } from './profile-edit.ts';
import { dataRoot, packageRoot, packageVersion } from './paths.ts';
import { GitMissingError } from './upstream.ts';

class UsageError extends Error {}

async function run(fn: () => { output: string; exitCode: number } | Promise<{ output: string; exitCode: number }>): Promise<void> {
  try {
    const { output, exitCode } = await fn();
    console.log(output);
    process.exitCode = exitCode;
  } catch (e) {
    if (e instanceof FetchError) {
      console.log(e.message);
      process.exitCode = e.exitCode;
      return;
    }
    if (e instanceof UsageError || e instanceof EngineDataError || e instanceof UpstreamFailure || e instanceof GitMissingError || e instanceof LockError || e instanceof WriteError || e instanceof BuildError || e instanceof EditError || e instanceof FolderError || e instanceof BundleError || e instanceof ManifestError) {
      console.log(e.message);
      process.exitCode = 2;
    } else {
      throw e;
    }
  }
}

const data = () => loadEngineData(dataRoot());
const only = (target?: string) => (target ? { target } : {});

const program = new Command('ffmpeg-build')
  .description('Build FFmpeg your way: ffmpeg-build.yml lists the builds (targets) and what each gets')
  .version(packageVersion())
  // exit 1 means "a target has problems"; a mistyped command or option is a usage error (2)
  .exitOverride((err) => process.exit(err.exitCode === 0 ? 0 : 2));

program
  .command('init')
  .description('write ffmpeg-build.yml from the shipped targets, narrowed to the licenses, platforms and FFmpeg you build')
  .option('--license <list>', 'licenses to build, e.g. lgplv3,gplv3')
  .option('--platforms <list>', 'platforms to build, e.g. linux-x64,win-*')
  .option('--ffmpeg <list>', 'FFmpeg series to build, e.g. 9 or 8,9 or latest (default: the newest)')
  .option('--from <shipped>', 'the shipped targets to start from', 'devenvy')
  .option('--empty', 'bare targets: add what you want with `profile add --to`')
  .action((opts: { license?: string; platforms?: string; ffmpeg?: string; from: string; empty?: boolean }) =>
    run(() => runFolderInit({ ...selectionFrom(opts), ...(opts.empty ? { empty: true } : {}) }, opts.from, data())),
  );

program
  .command('migrate')
  .description('turn the old matrix profiles here (and ffmpeg.lock) into ffmpeg-build.yml and one lock; keeps the old files as *.old')
  .action(() => run(() => runMigrate(data())));

program
  .command('check')
  .description('is every target possible? (offline)')
  .option('--target <name>', 'only this target')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean; target?: string }) => run(() => runFolderCheck(openFolder(), data(), { json: opts.json === true, ...only(opts.target) })));

program
  .command('plan')
  .description('what each target builds: options and libraries (offline)')
  .option('--target <name>', 'only this target')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean; target?: string }) => run(() => runFolderPlan(openFolder(), data(), { json: opts.json === true, ...only(opts.target) })));

program
  .command('show')
  .description('what one target gets, and from which base; or with --has, which targets get something (offline)')
  .argument('[target]', 'the target')
  .option('--has <name>', 'which targets get this option, and why the others do not')
  .option('--json', 'machine-readable output')
  .action((target: string | undefined, opts: { has?: string; json?: boolean }) =>
    run(() => {
      const folder = openFolder();
      if (opts.has) return runShowHas(folder, data(), opts.has, opts.json === true);
      if (!target) throw new UsageError('name a target (`ffmpeg-build targets` lists them), or pass --has <name>');
      return runShow(folder, data(), target, opts.json === true);
    }),
  );

program
  .command('targets')
  .description("the folder's targets: platform, license, FFmpeg series (and its locked release); --json for CI matrices")
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => run(() => runTargets(openFolder(), opts.json === true)));

program
  .command('lock')
  .description('write ffmpeg.lock: keep what is locked, look up only what is missing or no longer allowed')
  .action(() => run(() => runFolderLockOrUpdate(openFolder(), data(), { mode: 'keep' })));

program
  .command('update')
  .description('move ffmpeg.lock to the newest versions the targets allow (asks upstream)')
  .option('--summary <file>', 'also write the update PR text to this file')
  .action((opts: { summary?: string }) =>
    run(() => runFolderLockOrUpdate(openFolder(), data(), { mode: 'update', ...(opts.summary ? { summary: opts.summary } : {}) })),
  );

program
  .command('outdated')
  .description('what is newer upstream, and what update would do (read-only)')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => run(() => runFolderOutdated(openFolder(), data(), { json: opts.json === true })));

program
  .command('releases')
  .description('the releases: next tag, whether each is due (changed since its last release) and why, targets and runners')
  .option('--due', 'only the releases that are due')
  .option('--offline', "don't look up the last releases (every release counts as new)")
  .option('--json', 'machine-readable output (the CI build matrix)')
  .action((opts: { due?: boolean; offline?: boolean; json?: boolean }) =>
    run(() => runReleases(openFolder(), data(), { due: opts.due === true, offline: opts.offline === true, json: opts.json === true })),
  );

program
  .command('bundle')
  .description("write a release's sources archive, manifest.yml, SHA256SUMS and release notes beside its built targets")
  .requiredOption('--release <tag>', 'the release, e.g. 9.0.2.3 (`ffmpeg-build releases` says which is next)')
  .option('--dist <dir>', 'where the targets were built (build --out)', 'dist')
  .option('--previous <manifest>', "the last release's manifest.yml (default: looked up on GitHub)")
  .action((opts: { release: string; dist: string; previous?: string }) =>
    run(async () => {
      const folder = openFolder();
      const lock = readFolderLock(join(folder.dir, LOCK_FILE));
      if (!lock) throw new UsageError(`no ${LOCK_FILE} here; run ffmpeg-build lock first`);
      const previous = opts.previous ? parseManifest(readFileSync(opts.previous, 'utf8'), opts.previous) : undefined;
      const r = await bundle(folder, data(), lock, { tag: opts.release, dist: opts.dist, engineRoot: packageRoot, ...(previous ? { previous } : {}) });
      return { output: [...r.notes, `${r.tag}: ${r.assets.join(', ')}${r.latest ? ' (latest)' : ''}`].join('\n'), exitCode: 0 };
    }),
  );

program
  .command('build')
  .description('build one target, in its pinned toolchain')
  .option('--target <name>', 'the target to build (`ffmpeg-build targets` lists them)')
  .option('--out <dir>', 'where the archives go', 'dist')
  .option('--dry-run', 'say what would be built, and in which toolchain, without building')
  .option('--only <recipes>', 'build just these libraries (and what they need), without FFmpeg: a recipe check')
  .action((opts: { target?: string; out: string; dryRun?: boolean; only?: string }) =>
    run(() => {
      const folder = openFolder();
      if (!opts.target) throw new UsageError('name the target to build: --target <name> (`ffmpeg-build targets` lists them)');
      const only = opts.only?.split(',').map((s) => s.trim()).filter(Boolean);
      return runTargetBuild(folder, opts.target, data(), { out: opts.out, dryRun: opts.dryRun === true, ...(only ? { only } : {}) });
    }),
  );

program
  .command('fetch')
  .description("download a published build (owner/repo@tag, or a file holding it), check its sha256, unpack it")
  .argument('[pin]', 'owner/repo@tag, or a pin file such as ffmpeg.version')
  .option('--target <name>', 'the target to take from the release')
  .option('--platform <platform>', 'or the platform, when the release has one target for it')
  .option('--dev', 'also unpack the dev archive (headers, import libraries, pkg-config files)')
  .option('--out <dir>', 'where to unpack (replaced whole)', 'ffmpeg')
  .option('--update <pin-file>', 'move the pin file to the newest release of the same group and FFmpeg major')
  .action((pin: string | undefined, opts: { target?: string; platform?: string; dev?: boolean; out: string; update?: string }) =>
    run(async () => {
      const sel = { ...(opts.target ? { target: opts.target } : {}), ...(opts.platform ? { platform: opts.platform } : {}) };
      if (opts.update) {
        const change = await updatePin(opts.update, sel);
        return { output: change ?? `${opts.update}: up to date (${readFileSync(opts.update, 'utf8').trim()})`, exitCode: 0 };
      }
      if (!pin) throw new UsageError('say what to fetch: owner/repo@tag, or a pin file (e.g. ffmpeg.version)');
      const text = existsSync(pin) && statSync(pin).isFile() ? readFileSync(pin, 'utf8') : pin;
      return { output: await fetchRelease(text, { ...sel, dev: opts.dev === true }, opts.out), exitCode: 0 };
    }),
  );

program
  .command('options')
  .description("what a target can list, with each one's library, licenses and platforms (offline)")
  .option('--ffmpeg <major>', 'the FFmpeg major (default: the newest)')
  .option('--json', 'machine-readable output')
  .action((opts: { ffmpeg?: string; json?: boolean }) => run(() => runOptions(opts.ffmpeg, data(), opts.json === true)));

program
  .command('guide')
  .description('how to use ffmpeg-build, step by step (for people, scripts and AI agents)')
  .action(() => run(() => ({ output: readFileSync(join(packageRoot, 'AGENTS.md'), 'utf8').trimEnd(), exitCode: 0 })));

const profileCmd = program.command('profile').description('edit ffmpeg-build.yml in place, keeping its comments (checks every target an edit reaches)');

profileCmd
  .command('add')
  .description('add options to a base (every target using it) or to one target')
  .argument('<names...>', 'what to add, e.g. x265 srt')
  .option('--to <base or target>', 'the base or target to add to')
  .action((names: string[], opts: { to?: string }) =>
    run(() => {
      const folder = openFolder();
      if (!opts.to) throw new UsageError(`say where to add: --to <base or target> (bases: ${Object.keys(folder.bases).join(', ') || 'none'}; \`ffmpeg-build targets\` lists the targets)`);
      return runFolderEdit('add', names, opts.to, data());
    }),
  );

profileCmd
  .command('remove')
  .description('remove options from a base, or from one target (a target turns down what a base gives it)')
  .argument('<names...>', 'what to remove')
  .option('--from <base or target>', 'the base or target to remove from')
  .action((names: string[], opts: { from?: string }) =>
    run(() => {
      openFolder();
      if (!opts.from) throw new UsageError('say where to remove from: --from <base or target>');
      return runFolderEdit('remove', names, opts.from, data());
    }),
  );

profileCmd
  .command('missing')
  .description('what targets could add but neither list nor turn down (exit 1 when there is any)')
  .option('--target <name>', 'only this target')
  .option('--json', 'machine-readable output')
  .action((opts: { target?: string; json?: boolean }) => run(() => runFolderMissing(openFolder(), data(), { json: opts.json === true, ...only(opts.target) })));

await program.parseAsync();
