import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { aboutSchema } from '../check.ts';
import { versionInCell } from '../choose.ts';
import { depsOn, optionRecipe, optionsOf, type EngineData } from '../engine-data.ts';
import { allowedBy } from '../licenses.ts';
import type { LockedProfile } from '../lockfile.ts';
import { packageVersion } from '../paths.ts';
import type { Profile } from '../profile.ts';
import { availability, type CellPlan } from '../resolve.ts';
import type { LicenseFile } from '../schema/engine.ts';
import type { License } from '../schema/profile.ts';
import { unique } from '../text.ts';
import { parseYaml } from '../yaml.ts';

/**
 * The libraries' install prefix inside every build container; fixed, so absolute paths in .pc files stay valid. A
 * native (macOS) build uses its own fixed folder instead and passes it as `depsDir`.
 */
export const DEPS_DIR = '/opt/ffmpeg-build/deps';

/** {version}, {major}, {minor}, {patch}, and {version_} / {version-} for tags that use _ or - between numbers. */
export function expandTemplate(template: string, version: string): string {
  const [major = '', minor = '', patch = ''] = version.split('.');
  return template
    .replaceAll('{version_}', version.replaceAll('.', '_'))
    .replaceAll('{version-}', version.replaceAll('.', '-'))
    .replaceAll('{version}', version)
    .replaceAll('{major}', major)
    .replaceAll('{minor}', minor)
    .replaceAll('{patch}', patch);
}

export type Source = { git: string; ref: string; mirror?: string } | { git: string; commit: string; mirror?: string } | { archives: string[] };

/** Where to fetch `recipe` at `version`: a git tag/branch ref, a commit (branch libraries), or tarballs in order. */
export function sourceOf(data: EngineData, recipe: string, version: string): Source {
  const r = data.recipes.get(recipe)!;
  const s = r.source;
  if ('url' in s) return { archives: [s.url, ...(s.mirrors ?? [])].map((u) => expandTemplate(u, version)) };
  const mirror = s.mirror ? { mirror: s.mirror } : {};
  if ('git-branch' in r.versions) return { git: s.git, commit: version, ...mirror };
  return { git: s.git, ref: expandTemplate(s.ref, version), ...mirror };
}

// Upstream devenvy/ffmpeg scripts/steps/07_build_ffmpeg.sh: shared FFmpeg libraries, static dependencies,
// nothing picked up from the build machine by accident (--disable-autodetect). What differs by platform (programs,
// threads, PIC, cross-compiling) is in platforms.yml.
const COMMON_FLAGS = ['--enable-shared', '--disable-static', '--disable-doc', '--disable-debug', '--disable-autodetect', '--pkg-config-flags=--static'];
// Explicit --disable-gpl / --disable-nonfree as upstream passes them, so `ffmpeg -buildconf` matches today's builds.
const LICENSE_FLAGS: Record<License, string[]> = {
  lgplv2: ['--disable-gpl', '--disable-nonfree'],
  lgplv3: ['--disable-gpl', '--enable-version3', '--disable-nonfree'],
  gplv2: ['--enable-gpl', '--disable-nonfree'],
  gplv3: ['--enable-gpl', '--enable-version3', '--disable-nonfree'],
  nonfree: ['--enable-gpl', '--enable-version3', '--enable-nonfree'],
};

/**
 * Each option's FFmpeg flags: its own `configure:` (for a library behind several options), else its recipe's;
 * a built-in option without either is `--enable-<name>`.
 */
function optionFlags(data: EngineData, plan: CellPlan): string[] {
  const options = optionsOf(data, plan.cell.major);
  return unique(plan.options.flatMap((o) => {
    const info = options.get(o);
    if (info?.configure) return info.configure;
    const lib = info && optionRecipe(info, plan.cell.platform);
    return lib ? data.recipes.get(lib)!.configure : [`--enable-${o}`];
  }));
}

export function configureFlags(data: EngineData, plan: CellPlan, depsDir = DEPS_DIR): string[] {
  return unique([
    ...COMMON_FLAGS,
    `--extra-cflags=-I${depsDir}/include`,
    `--extra-ldflags=-L${depsDir}/lib`,
    ...(data.platforms.get(plan.cell.platform)?.configure ?? []),
    ...LICENSE_FLAGS[plan.cell.license],
    ...optionFlags(data, plan),
  ]);
}

/** `--enable-libx265` → `LIBX265`: what must read `CONFIG_LIBX265=yes` in ffbuild/config.mak after configure. */
export function verifyNames(data: EngineData, plan: CellPlan): string[] {
  return optionFlags(data, plan)
    .filter((f) => f.startsWith('--enable-'))
    .map((f) => {
      // --enable-hwaccel=h264_mediacodec is CONFIG_H264_MEDIACODEC_HWACCEL; --enable-libx265 is CONFIG_LIBX265
      const [what, name] = f.slice('--enable-'.length).split('=') as [string, string | undefined];
      return (name ? `${name}_${what}` : what).replaceAll('-', '_').toUpperCase();
    });
}

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]));
}

/**
 * A hash of every file in recipes/<name>/ plus recipes/lib.sh (missing lib.sh counts as empty). `withoutLicenses`
 * leaves out what only says which licence texts it ships (recipe.yml's license-files and the texts kept beside it),
 * which can't change what a library that builds against it gets.
 */
export function recipeFilesHash(root: string, recipe: string, withoutLicenses?: readonly LicenseFile[]): string {
  const hash = createHash('sha256');
  const dir = join(root, 'recipes', recipe);
  const beside = new Set((withoutLicenses ?? []).filter((f) => f.recipe).map((f) => f.path));
  for (const file of filesUnder(dir).filter((f) => !beside.has(f))) {
    let content: string | Buffer = readFileSync(join(dir, file));
    if (withoutLicenses && file === 'recipe.yml') content = content.toString('utf8').replace(/^license-files:.*(?:\r?\n[ \t]+-.*)*(?:\r?\n|$)/m, '');
    hash.update(`${file}\0`).update(content).update('\0');
  }
  const lib = join(root, 'recipes', 'lib.sh');
  hash.update('lib.sh\0').update(existsSync(lib) ? readFileSync(lib) : '');
  return hash.digest('hex');
}

/**
 * The setup script and every setup helper it sources (`source "${ENGINE}/setup/<name>.sh"` or `. "..."`), each once.
 * Only that spelling is followed; a missing file is an error, never an empty hash.
 */
export function setupFiles(engineRoot: string, setup: string, seen = new Set<string>()): string[] {
  if (seen.has(setup)) return [];
  seen.add(setup);
  const path = join(engineRoot, 'platforms', 'setup', `${setup}.sh`);
  if (!existsSync(path)) throw new Error(`platforms/setup/${setup}.sh is missing from the engine`);
  const sourced = [...readFileSync(path, 'utf8').matchAll(/(?:^|[\s;&|])(?:source|\.)\s+"?\$\{?ENGINE\}?\/setup\/([a-z0-9-]+)\.sh/gm)].map((m) => m[1]!);
  return [path, ...sourced.flatMap((name) => setupFiles(engineRoot, name, seen))];
}

/**
 * What builds every library besides its recipe: the toolchain image (its Docker ID), the driver, and the platform's
 * setup with the helpers it sources (compilers, CFLAGS, cross files). Changing any of them rebuilds that platform's
 * libraries; another platform's setup doesn't.
 */
export function toolchainIdentity(engineRoot: string, imageId: string, setup: string): string {
  const hash = createHash('sha256').update(`${imageId}\0`).update(readFileSync(join(engineRoot, 'platforms', 'driver.sh')));
  for (const file of setupFiles(engineRoot, setup)) hash.update(`\0${file.slice(engineRoot.length)}\0`).update(readFileSync(file));
  return hash.digest('hex');
}

/**
 * One key per library: its facts, its files, the toolchain, and the keys of the libraries it builds against
 * (`needs`, plus any `uses` member that is in this build), so a changed dependency rebuilds its dependents. What a
 * dependent counts of a dependency leaves out the dependency's licence files: changing which texts a library ships
 * rebuilds that library only.
 */
export function cacheKeys(data: EngineData, recipes: readonly string[], versionOf: (recipe: string) => string, platform: string, toolchain: string): Map<string, string> {
  const ids = new Map<string, { key: string; asDependency: string }>();
  const inBuild = new Set(recipes);
  const sha = (fact: object) => createHash('sha256').update(JSON.stringify(fact)).digest('hex');
  const idOf = (recipe: string): { key: string; asDependency: string } => {
    const known = ids.get(recipe);
    if (known) return known;
    const r = data.recipes.get(recipe)!;
    const against = [...depsOn(r, 'needs', platform), ...depsOn(r, 'uses', platform).filter((n) => inBuild.has(n))].map((n) => idOf(n).asDependency);
    const fact = { recipe, version: versionOf(recipe), platform, toolchain, against };
    const id = { key: sha({ ...fact, files: recipeFilesHash(data.root, recipe) }), asDependency: sha({ ...fact, files: recipeFilesHash(data.root, recipe, r['license-files']) }) };
    ids.set(recipe, id);
    return id;
  };
  recipes.forEach(idOf);
  return new Map(recipes.map((r) => [r, ids.get(r)!.key]));
}

function setupOf(data: EngineData, platform: string): string {
  const entry = data.platforms.get(platform);
  if (!entry) throw new Error(`${platform} isn't in platforms.yml`); // runBuild checks first; this is a guard
  return entry.setup;
}

/**
 * A patch set the target names: its folder's name, its licence (about.yml), a hash of its patches for this FFmpeg
 * major, those patches (in name order, applied in that order) and its licence texts.
 */
export interface PlannedPatchSet { name: string; license: string; sha256: string; files: { name: string; text: string }[]; licenses: { path: string; text: string }[] }

/** Where the build's definition came from: the repository URL and commit (`-dirty` when it had local changes). */
export interface BuildSource { repo?: string; ref?: string }

export interface BuildPlan {
  platform: string;
  setup: string; // platforms/setup/<setup>.sh
  image: string; // platforms.yml image: the toolchain image's folder, or macos
  toolchain: string; // the toolchain identity: part of every library's cache key
  engine: string; // the ffmpeg-build version that made the plan
  name: string;
  target: string; // the target (or profile variant) this build is
  license: License;
  release?: string; // the release tag it ships in; none for a build outside a release
  repository?: string; // owner/repo the release is published in
  sourcesArchive: string; // the release's sources archive
  libraries: { name: string; version: string; license: string; key: string; cached: boolean; source: Source; licenseFiles: LicenseFile[] }[];
  runtime: string[]; // globs under DEPS_DIR that ship next to FFmpeg's libraries (e.g. lib/libvulkan.so*)
  ships: { file: string; license: string; notice: string }[]; // platform files the archives carry, with their notice's path in the toolchain
  patches: PlannedPatchSet[];
  // THIRD-PARTY-NOTICES.txt: the governing COPYING texts of FFmpeg to include, and the sections the plan can write
  notices: { governing: string[]; header: string; build: string; source: string };
  ffmpeg: { version: string; archives: string[]; configure: string[]; verify: string[] };
}

// How upstream devenvy/ffmpeg 10_write_legal.sh names each licence, and which of FFmpeg's COPYING texts govern it.
const LICENSE_LABEL: Record<License, string> = { lgplv2: 'LGPLv2.1', lgplv3: 'LGPLv3', gplv2: 'GPLv2', gplv3: 'GPLv3', nonfree: 'nonfree' };
const LICENSE_NAME: Record<License, string> = {
  lgplv2: 'GNU Lesser General Public License, version 2.1',
  lgplv3: 'GNU Lesser General Public License, version 3',
  gplv2: 'GNU General Public License, version 2',
  gplv3: 'GNU General Public License, version 3',
  nonfree: 'not redistributable: configured with --enable-nonfree',
};
export const GOVERNING_TEXTS: Record<License, string[]> = {
  lgplv2: ['COPYING.LGPLv2.1', 'COPYING.GPLv2'],
  lgplv3: ['COPYING.LGPLv3', 'COPYING.GPLv3'],
  gplv2: ['COPYING.GPLv2'],
  gplv3: ['COPYING.GPLv3'],
  nonfree: ['COPYING.GPLv3'],
};
// the version 2 licence a v3 build would otherwise be: what its libraries are measured against
const V2_OF: Partial<Record<License, License>> = { lgplv3: 'lgplv2', gplv3: 'gplv2' };

/**
 * The effective licence, and why (what upstream's LICENSE-NOTICE.txt said). A v3 build names the libraries whose own
 * licence the version 2 licence doesn't allow (the Apache-2.0 parts); a v2 build names its TLS member (or says it has
 * none); a nonfree build says it isn't redistributable and names what makes it nonfree.
 */
export function licenseNotice(data: EngineData, cell: CellPlan): string {
  const license = cell.cell.license;
  const spdx = (r: string) => data.recipes.get(r)!.license;
  const allows = (r: string, l: License) => {
    const verdict = allowedBy(spdx(r), data.licenses);
    return 'allowed' in verdict && verdict.allowed.includes(l);
  };
  const tls = cell.groups.tls;
  // with none chosen: whether any TLS option was open to this build, or none is under this licence and platform
  const tlsOpen = [...optionsOf(data, cell.cell.major).values()].some((o) => o.group === 'tls' && !availability(data, cell.cell, o.name));
  const tlsLine = !tls
    ? tlsOpen
      ? 'This build has no TLS library.'
      : `This build has no TLS: no TLS library ${LICENSE_LABEL[license]} allows is available for ${cell.cell.platform}.`
    : data.recipes.has(tls)
      ? `TLS is ${tls} (${spdx(tls)}).`
      : `TLS is the operating system's ${tls} backend, which bundles no library.`;
  const governing = GOVERNING_TEXTS[license];
  const lines = [
    `EFFECTIVE LICENSE:  ${LICENSE_LABEL[license]} (${LICENSE_NAME[license]})`,
    '',
    `Governing license text: ${governing[0]}${governing[1] ? ` (plus ${governing[1]}, which it extends)` : ''}${license === 'nonfree' ? ', for FFmpeg\'s own code' : ''}; in full under FFMPEG below.`,
    '',
  ];
  const list = (rs: string[]) => rs.map((r) => `  ${r} (${spdx(r)})`);
  const v2 = V2_OF[license];
  if (license === 'nonfree') {
    // no version paragraph: a nonfree build isn't under any version of the (L)GPL as a whole
    const parts = cell.recipes.filter((r) => !allows(r, 'gplv3'));
    lines.push(
      'This build is NOT REDISTRIBUTABLE. It uses --enable-nonfree: it combines FFmpeg with code whose licence is',
      'incompatible with the GPL, so it may not be distributed to anyone. It is for internal use only.',
      ...(parts.length ? ['The libraries that make it nonfree:', ...list(parts)] : ['None of its libraries makes it nonfree; FFmpeg\'s own nonfree code does.']),
      tlsLine,
    );
  } else if (v2) {
    const parts = cell.recipes.filter((r) => allows(r, license) && !allows(r, v2));
    lines.push(
      ...(parts.length
        ? ['This build uses --enable-version3 because it links libraries (the Apache-2.0 parts) whose licences are', 'compatible with version 3 of the (L)GPL but not with version 2.1/2:', ...list(parts), 'Its effective license is therefore version 3.']
        : ['This build uses --enable-version3, though none of its libraries needs it.']),
      tlsLine,
    );
  } else {
    lines.push(`This is a version 2 build: it doesn't use --enable-version3 and links no library that needs version 3.`, tlsLine);
  }
  return `${lines.join('\n')}\n`;
}

/** The top of THIRD-PARTY-NOTICES.txt: what this is, its effective licence and why, and FFmpeg's modifications. */
export function noticesHeader(a: { version: string; target: string; platform: string; engine: string; licence: string; patches: readonly PlannedPatchSet[] }): string {
  const lines = [`FFmpeg ${a.version} — ${a.target} (${a.platform}), built by ffmpeg-build ${a.engine}`, '', a.licence.trimEnd(), ''];
  if (a.patches.length) {
    lines.push(
      'FFmpeg was modified by these patch sets (applied to its source before it was configured; see PATCH SETS below):',
      ...a.patches.map((p) => `  ${p.name}: ${p.files.length} patch${p.files.length === 1 ? '' : 'es'} (${p.files.map((f) => f.name).join(', ') || 'none for this FFmpeg version'}), sha256 ${p.sha256}`),
      '',
    );
  }
  lines.push(
    'This file holds every licence and notice this build carries: FFmpeg\'s own texts first, then each bundled',
    'library\'s, with where its source comes from. Sections: BUILD, SOURCE, FFMPEG, COMPONENTS, then PATCH SETS and',
    'FILES THE PLATFORM SHIPS when the build has them. Each opens with a rule of = signs, its title in capitals and a',
    'rule (a licence text may hold a rule of its own); each component with "== <name> <version> ==", each text with',
    '"--- <file> ---".',
  );
  return `${lines.join('\n')}\n`;
}

/** The BUILD section, but for FFmpeg's configure line, which the driver reads from what it built. */
export function noticesBuild(a: { platform: string; setup: string; image: string; toolchain: string }): string {
  const where = a.image === 'macos' ? 'natively on macOS with Xcode' : `in the toolchain image images/${a.image}`;
  return [
    `Platform: ${a.platform}, built ${where}, set up by platforms/setup/${a.setup}.sh`,
    `Toolchain identity: ${a.toolchain}`,
    '  (a hash of the toolchain, the build driver and the platform\'s setup scripts; part of every library\'s cache key)',
    '',
  ].join('\n');
}

/** A repository URL at a commit, as a link where the host has one (GitHub's /tree/<commit>). */
function atCommit(repo: string, ref: string): string {
  const commit = ref.replace(/-dirty$/, '');
  const link = /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo) ? `${repo}/tree/${commit}` : `${repo} at commit ${commit}`;
  return ref.endsWith('-dirty') ? `${link}\n  (built with local changes to that commit, so it isn't the whole build definition)` : link;
}

/**
 * The SOURCE section: where the complete corresponding source is, all of it public. Never an offer to send it on
 * request: a release names its sources archive by URL; an unreleased build says where its source is recorded and that
 * it must be published with that archive before it is distributed.
 */
export function noticesSource(a: { name: string; version: string; license: License; release?: string; repository?: string; sourcesArchive: string; source: BuildSource; ffmpegTarball: string; patchSets?: string[] }): string {
  const lines: string[] = [];
  if (a.release && a.repository) {
    lines.push(
      'Complete corresponding source, as required by the licences above:',
      `  https://github.com/${a.repository}/releases/download/${a.release}/${a.sourcesArchive}`,
      `This archive, published with release ${a.release}, holds the complete corresponding source for this build: FFmpeg's`,
      'release tarball, every library at the exact version (and commit) it was built from, the patches applied, and the',
      'build scripts and toolchain definitions (ffmpeg-build.yml, ffmpeg.lock, the engine\'s recipes, platform scripts and',
      'toolchain image Dockerfiles).',
    );
  } else if (a.release) {
    lines.push(
      `Complete corresponding source: ${a.sourcesArchive}, published with release ${a.release}. It holds FFmpeg's release`,
      'tarball, every library at the exact version (and commit) it was built from, the patches applied, and the build',
      'scripts and toolchain definitions.',
    );
  } else {
    lines.push(
      'This build was not published in a release (a local or unreleased build). Its source is recorded in',
      `${a.name}.sources.json beside it, every source with its sha256 (and commit), and kept in the build cache`,
      `under sources/. It must be published together with its sources archive (${a.sourcesArchive}) before it is`,
      'distributed.',
    );
  }
  lines.push('');
  lines.push(
    `Build definition: ${a.source.repo && a.source.ref ? atCommit(a.source.repo, a.source.ref) : a.source.repo ?? 'not recorded (the build had no FFMPEG_BUILD_SOURCE_REPO and no git remote)'}`,
    a.patchSets?.length
      ? `FFmpeg ${a.version}, upstream release, modified by the patch sets ${a.patchSets.join(', ')} (in the sources archive): ${a.ffmpegTarball}`
      : `FFmpeg ${a.version}, unmodified upstream: ${a.ffmpegTarball}`,
    'Each component below names its upstream origin, exact version and commit, so it can also be fetched from upstream',
    // a release publishes the list inside its sources archive; an unreleased build has it beside its archives
    a.release ? `directly. SOURCES.md in ${a.sourcesArchive} lists every source with its sha256.` : `directly. ${a.name}.sources.json lists every source with its sha256.`,
    '',
    'Everything is public; no request to the distributor is necessary to obtain it.',
  );
  if (a.license === 'nonfree') lines.push('', 'This is a nonfree build (--enable-nonfree): it is for internal use only and is not offered for redistribution.');
  return `${lines.join('\n')}\n`;
}

/** The patch sets a profile names, read from their folders: about.yml (checked already), patches and licence texts. */
export function plannedPatches(profile: Profile, major: string): PlannedPatchSet[] {
  return profile.patches.map((p) => {
    const dir = join(profile.dir ?? '.', p);
    const about = aboutSchema.parse(parseYaml(readFileSync(join(dir, 'about.yml'), 'utf8'), `${p}/about.yml`));
    const hash = createHash('sha256');
    const patchDir = join(dir, major);
    if (existsSync(patchDir)) for (const file of filesUnder(patchDir)) hash.update(`${file}\0`).update(readFileSync(join(patchDir, file))).update('\0');
    const files = existsSync(patchDir) ? filesUnder(patchDir).filter((f) => /\.(patch|diff)$/.test(f)).sort() : [];
    return {
      name: basename(dir),
      license: about.license,
      sha256: hash.digest('hex'),
      files: files.map((f) => ({ name: f, text: readFileSync(join(patchDir, f), 'utf8') })),
      licenses: about['license-files'].map((path) => ({ path, text: readFileSync(join(dir, path), 'utf8') })),
    };
  });
}

export function makeBuildPlan(args: {
  profile: Profile; data: EngineData; locked: LockedProfile; cell: CellPlan; variant: string; imageId: string; cacheDir: string;
  depsDir?: string; name?: string; release?: string; repository?: string; group?: string; source?: BuildSource;
}): BuildPlan {
  const { profile, data, locked, cell } = args;
  const versionOf = (recipe: string) => versionInCell(profile, data, locked, cell.cell, recipe)!;
  const keys = cacheKeys(data, cell.recipes, versionOf, cell.cell.platform, args.imageId);
  const version = cell.cell.version;
  const license = cell.cell.license;
  const platform = cell.cell.platform;
  const setup = setupOf(data, platform);
  const image = data.platforms.get(platform)!.image;
  const name = args.name ?? `ffmpeg-${version}-${platform}-${args.variant}`;
  const sourcesArchive = `ffmpeg-${version}${args.group ? `-${args.group}` : ''}-sources.tar.gz`;
  const archives = [data.ffmpegSource.url, ...data.ffmpegSource.mirrors].map((u) => expandTemplate(u, version));
  const patches = plannedPatches(profile, cell.cell.major);
  const engine = packageVersion();
  return {
    platform,
    setup,
    image,
    toolchain: args.imageId,
    engine,
    name,
    target: args.variant,
    license,
    ...(args.release ? { release: args.release } : {}),
    ...(args.repository ? { repository: args.repository } : {}),
    sourcesArchive,
    libraries: cell.recipes.map((lib) => {
      const key = keys.get(lib)!;
      const r = data.recipes.get(lib)!;
      return { name: lib, version: versionOf(lib), license: r.license, key, cached: existsSync(join(args.cacheDir, `${key}.tar.gz`)), source: sourceOf(data, lib, versionOf(lib)), licenseFiles: r['license-files'] };
    }),
    runtime: unique(cell.recipes.flatMap((r) => data.recipes.get(r)!.runtime ?? [])),
    ships: Object.entries(data.platforms.get(platform)?.ships ?? {}).map(([file, s]) => ({ file, license: s.license, notice: s.notice })),
    patches,
    notices: {
      governing: GOVERNING_TEXTS[license],
      header: noticesHeader({ version, target: args.variant, platform, engine, licence: licenseNotice(data, cell), patches }),
      build: noticesBuild({ platform, setup, image, toolchain: args.imageId }),
      source: noticesSource({ name, version, license, ...(args.release ? { release: args.release } : {}), ...(args.repository ? { repository: args.repository } : {}), sourcesArchive, source: args.source ?? {}, ffmpegTarball: archives[0]!, patchSets: profile.patches.map((p) => basename(p)) }),
    },
    ffmpeg: {
      version,
      archives,
      configure: configureFlags(data, cell, args.depsDir),
      verify: verifyNames(data, cell),
    },
  };
}
