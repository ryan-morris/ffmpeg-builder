// `ffmpeg-build bundle`: after every target of a release has built into --dist, writes the rest of the release beside
// the archives: the sources archive, manifest.yml, SHA256SUMS, release-notes.md, and bundle.json (what to upload).
// It never uploads; the workflow does. It refuses anything that mustn't ship: a missing build, a component that
// disappeared since the last release, a nonfree build headed for a public repository. A licence's iOS / Mac Catalyst
// framework builds ship as its xcframework bundle (bundle --apple, src/bundle-apple.ts), one ios-<license> entry.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { EngineData } from './engine-data.ts';
import { ffmpegAtLeast, FetchError, listReleases, parseTag, repoIsPrivate } from './fetch.ts';
import type { FolderLock } from './lockfile.ts';
import { formatManifest, MANIFEST_FILE, parseManifest, type Manifest, type ManifestTarget } from './manifest.ts';
import { packageVersion } from './paths.ts';
import { planReleases, publishedTargets, removals, type PlannedRelease, type PlannedTarget } from './release.ts';
import { previousReleases, publishingRepo } from './release-remote.ts';
import { writeTarGz, type TarEntry } from './tar-write.ts';
import { artifactName, type Folder } from './targets.ts';

export class BundleError extends Error {}

/** One build's kept-source record (<name>.sources.json, written by the driver). */
interface SourceRecord { name: string; version: string; origin: string; file: string; sha256: string; commit?: string }
interface SourcesJson { artifact: string; target: string; ffmpeg: SourceRecord; libraries: SourceRecord[]; patches: { name: string; sha256: string }[] }

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** A licence's xcframework bundle: ffmpeg-<version>-ios-<license>.tar.gz, written by bundle --apple. */
export const appleBundleName = (ffmpeg: string, license: string) => `ffmpeg-${ffmpeg}-ios-${license}.tar.gz`;

/** Every file under `dir`, relative paths, sorted. */
function filesUnder(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name), base) : [relative(base, join(dir, e.name)).replaceAll('\\', '/')]));
}

export interface BundleOptions {
  tag: string;
  dist: string;
  engineRoot: string;
  previous?: Manifest; // the last release's manifest (default: looked up on GitHub)
  repo?: string; // owner/repo it publishes to (default: GITHUB_REPOSITORY or the folder's remote)
}

export interface BundleResult { tag: string; assets: string[]; latest: boolean; notes: string[] }

/** Finds the release `tag` names among the folder's releases. */
export function releaseOf(folder: Folder, data: EngineData, lock: FolderLock, engineRoot: string, tag: string): { rel: PlannedRelease; build: number } {
  const t = parseTag(tag);
  if (!t) throw new BundleError(`${tag} isn't a release tag: <ffmpeg>.<build> or <group>-<ffmpeg>.<build>`);
  const { releases, errors } = planReleases(folder, data, lock, engineRoot);
  if (errors.length) throw new BundleError(errors.join('\n'));
  const base = `${t.group ? `${t.group}-` : ''}${t.ffmpeg}`;
  const rel = releases.find((r) => r.base === base);
  if (!rel) throw new BundleError(`no release ${base} in this folder (it has ${releases.map((r) => r.base).join(', ') || 'none'})`);
  return { rel, build: t.build };
}

/** The archives and source record of one target in --dist, checked against each other. */
export function builtTarget(dist: string, p: PlannedTarget): { runtime: string; dev: string; sources: SourcesJson } {
  const name = artifactName(p.target, p.facts.ffmpeg);
  const files = { runtime: `${name}.tar.gz`, dev: `${name}-dev.tar.gz`, json: `${name}.sources.json` };
  const missing = Object.values(files).filter((f) => !existsSync(join(dist, f)));
  if (missing.length) throw new BundleError(`${p.target.name} isn't built in ${dist}: ${missing.join(', ')} missing (ffmpeg-build build --target ${p.target.name} --out ${dist})`);
  const sources = JSON.parse(readFileSync(join(dist, files.json), 'utf8')) as SourcesJson;
  for (const s of [sources.ffmpeg, ...sources.libraries]) {
    const kept = join(dist, `${name}.sources`, s.file);
    if (!existsSync(kept)) throw new BundleError(`${p.target.name}: the kept source ${s.file} isn't in ${name}.sources/ (build it again)`);
    if (sha256(kept) !== s.sha256) throw new BundleError(`${p.target.name}: ${name}.sources/${s.file} doesn't match its record; build it again`);
  }
  const applied = sources.patches.map((x) => x.sha256).sort().join(' ');
  if (applied !== p.facts.patches.map((x) => x.sha256).sort().join(' ')) throw new BundleError(`${p.target.name} was built with other patches than the folder has now; build it again`);
  const built = new Set(sources.libraries.map((l) => `${l.name} ${l.version}`));
  const planned = Object.entries(p.facts.components).map(([n, v]) => `${n} ${v}`).filter((x) => !built.has(x));
  if (planned.length) throw new BundleError(`${p.target.name} was built from other versions than ffmpeg.lock says (${planned.join(', ')}); build it again`);
  return { runtime: files.runtime, dev: files.dev, sources };
}

/**
 * Where each kept source goes in the sources archive. A file each build used is kept once; the same name with other
 * bytes (a git commit archived by another machine's tar and gzip) goes beside it under its sha256's first 12 digits,
 * so every build's exact source is there.
 */
function archivedPaths(rel: PlannedRelease, built: Map<string, SourcesJson>): Map<string, string> {
  const byName = new Map<string, string>(); // file -> the sha256 that got the plain path
  const at = new Map<string, string>(); // file\0sha256 -> path in the archive
  for (const p of rel.targets) {
    const s = built.get(p.target.name)!;
    for (const r of [s.ffmpeg, ...s.libraries]) {
      const key = `${r.file}\0${r.sha256}`;
      if (at.has(key)) continue;
      const first = byName.get(r.file);
      if (!first) byName.set(r.file, r.sha256);
      const dir = r.file.includes('/') ? r.file.slice(0, r.file.lastIndexOf('/')) : '.';
      at.set(key, !first ? `sources/${r.file}` : `sources/${dir}/${r.sha256.slice(0, 12)}/${basename(r.file)}`);
    }
  }
  return at;
}

/** The release's sources archive: each build's kept sources, the build definition, and the engine files it used. */
async function writeSources(out: string, root: string, folder: Folder, rel: PlannedRelease, built: Map<string, SourcesJson>, data: EngineData, engineRoot: string, dist: string): Promise<void> {
  const archived = archivedPaths(rel, built);
  const entries: TarEntry[] = [];
  for (const p of rel.targets) {
    const s = built.get(p.target.name)!;
    for (const r of [s.ffmpeg, ...s.libraries]) {
      const at = archived.get(`${r.file}\0${r.sha256}`)!;
      if (entries.some((e) => e.path === `${root}/${at}`)) continue;
      entries.push({ path: `${root}/${at}`, file: join(dist, `${s.artifact}.sources`, r.file) });
    }
  }
  // the build definition: the folder's file and lock, and the patch sets the targets apply
  for (const f of ['ffmpeg-build.yml', 'ffmpeg.lock']) entries.push({ path: `${root}/build/${f}`, file: join(folder.dir, f) });
  for (const set of [...new Set(rel.targets.flatMap((p) => p.target.patches))].sort()) {
    for (const f of filesUnder(join(folder.dir, set))) entries.push({ path: `${root}/build/${set}/${f}`, file: join(folder.dir, set, f) });
  }
  // the engine at its version: every recipe a target used, the platform scripts and the toolchain images
  const recipes = [...new Set(rel.targets.flatMap((p) => p.cell.recipes))].sort();
  const images = [...new Set(rel.targets.map((p) => data.platforms.get(p.target.platform)!.image).filter((i) => i !== 'macos'))].sort();
  const fromEngine = ['package.json', ...filesUnder(join(engineRoot, 'platforms')).map((f) => `platforms/${f}`), ...images.flatMap((i) => filesUnder(join(engineRoot, 'images', i)).map((f) => `images/${i}/${f}`))];
  const fromData = [
    'platforms.yml', 'licenses.yml', 'ffmpeg/source.yml', `ffmpeg/${rel.ffmpeg.split('.')[0]}.yml`, 'recipes/lib.sh',
    ...recipes.flatMap((r) => filesUnder(join(data.root, 'recipes', r)).map((f) => `recipes/${r}/${f}`)),
  ];
  for (const [base, files] of [[engineRoot, fromEngine], [data.root, fromData]] as const) {
    for (const f of files) {
      if (!existsSync(join(base, f))) throw new BundleError(`the engine file ${f} is missing from ${base}; the sources archive would be incomplete`);
      entries.push({ path: `${root}/engine/${f}`, file: join(base, f) });
    }
  }
  entries.push({ path: `${root}/SOURCES.md`, text: sourcesIndex(rel, built, archived) });
  await writeTarGz(out, entries);
}

function sourcesIndex(rel: PlannedRelease, built: Map<string, SourcesJson>, archived: Map<string, string>): string {
  const out = [
    `# Sources of FFmpeg ${rel.ffmpeg}${rel.group ? ` (${rel.group})` : ''}`,
    '',
    'Everything each build in this release was made from. `sources/` holds every source exactly as the build used it',
    '(a release tarball as downloaded, a git checkout as an archive of its exact commit), `build/` the folder that',
    'defines the builds (ffmpeg-build.yml, ffmpeg.lock, patch sets), and `engine/` the ffmpeg-build files that turn',
    `them into a build: recipes, platform scripts, toolchain images (ffmpeg-build ${packageVersion()}).`,
    '',
    'To build a target again: `npm install --global ffmpeg-build@' + packageVersion() + '`, then in `build/`:',
    '`ffmpeg-build build --target <name>`.',
  ];
  for (const p of rel.targets) {
    const s = built.get(p.target.name)!;
    out.push('', `## ${p.target.name}`, '', '| component | version | origin | commit | file | sha256 |', '|---|---|---|---|---|---|');
    for (const r of [s.ffmpeg, ...s.libraries]) out.push(`| ${r.name} | ${r.version} | ${r.origin} | ${r.commit ?? ''} | ${archived.get(`${r.file}\0${r.sha256}`)} | ${r.sha256} |`);
    if (s.patches.length) out.push('', `Patch sets: ${s.patches.map((x) => `${x.name} (sha256 ${x.sha256})`).join(', ')}`);
  }
  return `${out.join('\n')}\n`;
}

function releaseNotes(m: Manifest, rel: PlannedRelease, repo: string | undefined): string {
  const out = [`# ${m.release}: FFmpeg ${m.ffmpeg}${m.group ? ` (${m.group})` : ''}`, ''];
  if (m.targets.some((t) => t.redistributable === 'false')) out.push('> **Internal use only:** it holds nonfree builds, which may not be redistributed.', '');
  out.push(`Built by ffmpeg-build ${m.engine}. \`manifest.yml\` lists every asset with its sha256 (\`SHA256SUMS\` too); \`${m.sources.name}\` holds the complete corresponding source of every build.`, '');
  out.push('| Target | License | Download | |', '|---|---|---|---|');
  for (const t of m.targets) {
    const dev = t.assets.dev.name === t.assets.runtime.name ? 'headers included (xcframeworks)' : `dev: \`${t.assets.dev.name}\``;
    out.push(`| ${t.name} | ${t.license} | \`${t.assets.runtime.name}\` | ${dev} |`);
  }
  const pins = rel.targets.flatMap((p) => Object.entries(p.cell.pins).map(([lib, v]) => `${lib} ${v} (${p.target.name})`));
  if (pins.length) out.push('', `**Pinned:** ${[...new Set(pins)].join(', ')}.`);
  const left = m.targets.flatMap((t) => t['not-included'].map((n) => `${t.name}: ${n}`));
  out.push('', left.length ? `**Not included:** ${left.join('; ')}.` : '**Not included:** nothing asked for was left out.');
  const components = [...new Set(m.targets.flatMap((t) => Object.keys(t.components)))].sort();
  out.push('', '<details><summary>What is in each build</summary>', '', `| Component | ${m.targets.map((t) => t.name).join(' | ')} |`, `|---|${m.targets.map(() => '---').join('|')}|`);
  for (const c of components) out.push(`| ${c} | ${m.targets.map((t) => t.components[c] ?? '').join(' | ')} |`);
  out.push('', '</details>');
  if (repo) out.push('', `Fetch one with \`ffmpeg-build fetch ${repo}@${m.release} --target <name>\`.`);
  return `${out.join('\n')}\n`;
}

/**
 * Whether these targets may be published to `repo`. A public repository takes no nonfree build. A private one takes a
 * release only when the folder says `private-release: internal`: its builds, and the source their notices link to,
 * then reach only people with access to that repository. `strict` (bundle) also refuses when the repository or its
 * visibility can't be told; otherwise (planning, local runs) that is no problem.
 */
export async function publishingProblems(folder: Folder, targets: { name: string; license: string }[], repo: string | undefined, o: { strict: boolean }): Promise<string[]> {
  const nonfree = targets.filter((t) => t.license === 'nonfree').map((t) => t.name);
  const which = (names: string[]) => `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'}`;
  if (!repo) return o.strict && nonfree.length ? [`${which(nonfree)} nonfree, and there's no repository to check is private (GITHUB_REPOSITORY or the folder's git remote)`] : [];
  let priv: boolean;
  try {
    priv = await repoIsPrivate(repo);
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    return o.strict ? [`${repo}'s visibility can't be read, so whether it may take these builds can't be told: ${e.message}`] : [];
  }
  if (!priv) return nonfree.length ? [`${which(nonfree)} nonfree: internal use only, never published to a public repository (${repo} is public)`] : [];
  if (folder.privateRelease !== 'internal') {
    return [`${repo} is private: its releases, and the source their notices link to, reach only people with access to it. Say that is intended with private-release: internal at the top of ffmpeg-build.yml`];
  }
  return [];
}

/**
 * Bundles the release `tag` from the builds in `dist`. Refuses (BundleError) when a build is missing or doesn't match
 * the lock, when a component disappeared since the last release, or when a nonfree build would go to a public (or an
 * unacknowledged private) repository.
 */
export async function bundle(folder: Folder, data: EngineData, lock: FolderLock, o: BundleOptions): Promise<BundleResult> {
  const { rel, build } = releaseOf(folder, data, lock, o.engineRoot, o.tag);
  const repo = o.repo ?? publishingRepo(folder.dir);

  const refused = await publishingProblems(folder, rel.targets.map((p) => ({ name: p.target.name, license: p.target.license })), repo, { strict: true });
  if (refused.length) throw new BundleError(refused.join('\n'));

  // the always-on guard: the last release of this base
  let previous = o.previous;
  if (!previous && repo) {
    try {
      previous = (await previousReleases(repo, rel.group, rel.ffmpeg)).lastInMajor?.manifest;
    } catch (e) {
      if (e instanceof FetchError) throw new BundleError(`can't read ${repo}'s last release to check nothing was removed: ${e.message}`);
      throw e;
    }
  }
  const gone = removals(rel, previous, folder);
  if (gone.length) throw new BundleError(gone.join('\n'));

  // every build is checked, the framework slices too: their sources go into the sources archive
  const built = new Map<string, SourcesJson>();
  const archives = new Map<string, { runtime: string; dev: string }>();
  for (const p of rel.targets) {
    const b = builtTarget(o.dist, p);
    built.set(p.target.name, b.sources);
    archives.set(p.target.name, b);
  }
  const targets: ManifestTarget[] = [];
  for (const t of publishedTargets(rel)) {
    let runtime: string;
    let dev: string;
    if (t.platform === 'ios') {
      // the xcframeworks carry each library's headers, so one file serves as both runtime and dev
      runtime = dev = appleBundleName(rel.ffmpeg, t.license);
      if (!existsSync(join(o.dist, runtime))) {
        throw new BundleError(`${runtime} (the ${t.license} xcframework bundle) isn't in ${o.dist}: make it on a Mac with ffmpeg-build bundle --apple --release ${o.tag} --dist ${o.dist}`);
      }
    } else {
      ({ runtime, dev } = archives.get(t.name)!);
    }
    targets.push({
      name: t.name, platform: t.platform, license: t.license,
      redistributable: t.license === 'nonfree' ? 'false' : 'true',
      assets: { runtime: { name: runtime, sha256: sha256(join(o.dist, runtime)) }, dev: { name: dev, sha256: sha256(join(o.dist, dev)) } },
      toolchain: t.facts.toolchain,
      components: t.facts.components,
      patches: t.facts.patches,
      'not-included': t.slices.flatMap((p) => p.cell.leftOut.map((l) => `${t.slices.length > 1 ? `${p.target.platform}: ` : ''}${l.uses} (${l.reason})`)),
      definition: t.facts.definition,
    });
  }

  const sourcesName = `ffmpeg-${rel.ffmpeg}${rel.group ? `-${rel.group}` : ''}-sources.tar.gz`;
  await writeSources(join(o.dist, sourcesName), basename(sourcesName, '.tar.gz'), folder, rel, built, data, o.engineRoot, o.dist);

  const manifest: Manifest = {
    release: o.tag, ffmpeg: rel.ffmpeg, build: String(build), engine: packageVersion(), ...(rel.group ? { group: rel.group } : {}),
    targets, sources: { name: sourcesName, sha256: sha256(join(o.dist, sourcesName)) },
  };
  parseManifest(formatManifest(manifest)); // what fetch will read: refuse to write one it couldn't
  writeFileSync(join(o.dist, MANIFEST_FILE), formatManifest(manifest));
  writeFileSync(join(o.dist, 'release-notes.md'), releaseNotes(manifest, rel, repo));

  const assets = [...new Set(targets.flatMap((t) => [t.assets.runtime.name, t.assets.dev.name])), sourcesName, MANIFEST_FILE];
  const sums = assets.map((a) => `${sha256(join(o.dist, a))}  ${a}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  writeFileSync(join(o.dist, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  assets.push('SHA256SUMS');

  // "Latest" on GitHub goes to the release with the highest FFmpeg of its group
  let latest = true;
  const notes: string[] = [];
  if (repo) {
    try {
      for (const r of await listReleases(repo)) {
        const t = parseTag(r.tag_name);
        // GitHub has one "latest" per repository, whatever the group
        if (!r.draft && !r.prerelease && t && !ffmpegAtLeast(rel.ffmpeg, t.ffmpeg)) latest = false;
      }
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      notes.push(`note: couldn't list ${repo}'s releases to decide "latest" (${e.message}); marking this one latest`);
    }
  }
  const result: BundleResult = { tag: o.tag, assets, latest, notes };
  writeFileSync(join(o.dist, 'bundle.json'), `${JSON.stringify({ tag: result.tag, assets, latest }, null, 2)}\n`);
  for (const a of assets) if (!statSync(join(o.dist, a)).isFile()) throw new BundleError(`${a} wasn't written`);
  return result;
}
