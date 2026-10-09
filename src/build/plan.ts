import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { aboutSchema } from '../check.ts';
import { versionInCell } from '../choose.ts';
import { depsOn, optionRecipe, optionsOf, type EngineData } from '../engine-data.ts';
import { allowedBy } from '../licenses.ts';
import type { LockedProfile } from '../lockfile.ts';
import type { Profile } from '../profile.ts';
import type { CellPlan } from '../resolve.ts';
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

/** A hash of every file in recipes/<name>/ plus recipes/lib.sh (missing lib.sh counts as empty). */
export function recipeFilesHash(root: string, recipe: string): string {
  const hash = createHash('sha256');
  const dir = join(root, 'recipes', recipe);
  for (const file of filesUnder(dir)) hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update('\0');
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
 * (`needs`, plus any `uses` member that is in this build), so a changed dependency rebuilds its dependents.
 */
export function cacheKeys(data: EngineData, recipes: readonly string[], versionOf: (recipe: string) => string, platform: string, toolchain: string): Map<string, string> {
  const keys = new Map<string, string>();
  const inBuild = new Set(recipes);
  const keyOf = (recipe: string): string => {
    const known = keys.get(recipe);
    if (known) return known;
    const r = data.recipes.get(recipe)!;
    const against = [...depsOn(r, 'needs', platform), ...depsOn(r, 'uses', platform).filter((n) => inBuild.has(n))].map(keyOf);
    const fact = JSON.stringify({ recipe, version: versionOf(recipe), platform, toolchain, files: recipeFilesHash(data.root, recipe), against });
    const key = createHash('sha256').update(fact).digest('hex');
    keys.set(recipe, key);
    return key;
  };
  recipes.forEach(keyOf);
  return keys;
}

function setupOf(data: EngineData, platform: string): string {
  const entry = data.platforms.get(platform);
  if (!entry) throw new Error(`${platform} isn't in platforms.yml`); // runBuild checks first; this is a guard
  return entry.setup;
}

/** A patch set the target names: its folder's name, a hash of its patches for this FFmpeg major, its licence texts. */
export interface PlannedPatchSet { name: string; sha256: string; licenses: { path: string; text: string }[] }

export interface BuildPlan {
  platform: string;
  setup: string; // platforms/setup/<setup>.sh
  name: string;
  target: string; // the target (or profile variant) this build is
  license: License;
  release?: string; // the release tag it ships in; none for a build outside a release
  sourcesArchive: string; // the release's sources archive, named in legal/SOURCE_OFFER.txt
  libraries: { name: string; version: string; key: string; cached: boolean; source: Source; licenseFiles: LicenseFile[] }[];
  runtime: string[]; // globs under DEPS_DIR that ship next to FFmpeg's libraries (e.g. lib/libvulkan.so*)
  ships: { file: string; notice: string }[]; // platform files the archives carry, with their notice's path in the toolchain
  patches: PlannedPatchSet[];
  legal: { label: string; governing: string[]; notice: string }; // legal/: FFmpeg's texts to copy, LICENSE-NOTICE.txt
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
const V2_OF: Partial<Record<License, License>> = { lgplv3: 'lgplv2', gplv3: 'gplv2', nonfree: 'gplv2' };

/**
 * legal/LICENSE-NOTICE.txt: the effective licence, and why. A v3 build names the libraries whose own licence the
 * version 2 licence doesn't allow (the Apache-2.0 parts); a v2 build names its TLS member (or says it has none);
 * a nonfree build names what makes it nonfree.
 */
export function licenseNotice(data: EngineData, cell: CellPlan, target: string): string {
  const license = cell.cell.license;
  const spdx = (r: string) => data.recipes.get(r)!.license;
  const allows = (r: string, l: License) => {
    const verdict = allowedBy(spdx(r), data.licenses);
    return 'allowed' in verdict && verdict.allowed.includes(l);
  };
  const tls = cell.groups.tls;
  const tlsLine = !tls
    ? `This build has no TLS: no TLS library ${LICENSE_LABEL[license]} allows is available for ${cell.cell.platform}.`
    : data.recipes.has(tls)
      ? `TLS is ${tls} (${spdx(tls)}).`
      : `TLS is the operating system's ${tls} backend, which bundles no library.`;
  const governing = GOVERNING_TEXTS[license];
  const lines = [
    `FFmpeg ${cell.cell.version} — ${cell.cell.platform} (${target})`,
    '',
    `EFFECTIVE LICENSE:  ${LICENSE_LABEL[license]} (${LICENSE_NAME[license]})`,
    '',
    `Governing license text: ${governing[0]}${governing[1] ? ` (plus ${governing[1]}, which it extends)` : ''}${license === 'nonfree' ? ', for FFmpeg\'s own code' : ''}`,
    '',
  ];
  const list = (rs: string[]) => rs.map((r) => `  ${r} (${spdx(r)})`);
  if (license === 'nonfree') {
    const parts = cell.recipes.filter((r) => !allows(r, 'gplv3'));
    lines.push(
      'This build uses --enable-nonfree, so it may not be redistributed.',
      ...(parts.length ? ['It links libraries whose licences no GPL build allows:', ...list(parts)] : ['None of its libraries needs it; FFmpeg\'s nonfree code does.']),
      '',
    );
  }
  const v2 = V2_OF[license];
  if (v2) {
    const parts = cell.recipes.filter((r) => allows(r, license) && !allows(r, v2));
    lines.push(
      ...(parts.length
        ? ['This build uses --enable-version3 because it links libraries (the Apache-2.0 parts) whose licences are', 'compatible with version 3 of the (L)GPL but not with version 2.1/2:', ...list(parts), 'Its effective license is therefore version 3.']
        : ['This build uses --enable-version3, though none of its libraries needs it.']),
      tlsLine,
      '',
    );
  } else {
    lines.push(`This is a version 2 build: it doesn't use --enable-version3 and links no library that needs version 3.`, tlsLine, '');
  }
  lines.push(
    'Bundled third-party libraries: each one\'s own license text is in licenses/<library>/ in this directory;',
    'that attribution travels with the binary as required.',
    '',
    'Corresponding source: see SOURCE_OFFER.txt in this directory.',
    '',
  );
  return lines.join('\n');
}

/** The patch sets a profile names, read from their folders: about.yml (checked already), patches and licence texts. */
export function plannedPatches(profile: Profile, major: string): PlannedPatchSet[] {
  return profile.patches.map((p) => {
    const dir = join(profile.dir ?? '.', p);
    const about = aboutSchema.parse(parseYaml(readFileSync(join(dir, 'about.yml'), 'utf8'), `${p}/about.yml`));
    const hash = createHash('sha256');
    const patchDir = join(dir, major);
    if (existsSync(patchDir)) for (const file of filesUnder(patchDir)) hash.update(`${file}\0`).update(readFileSync(join(patchDir, file))).update('\0');
    return {
      name: basename(dir),
      sha256: hash.digest('hex'),
      licenses: about['license-files'].map((path) => ({ path, text: readFileSync(join(dir, path), 'utf8') })),
    };
  });
}

export function makeBuildPlan(args: { profile: Profile; data: EngineData; locked: LockedProfile; cell: CellPlan; variant: string; imageId: string; cacheDir: string; depsDir?: string; name?: string; release?: string }): BuildPlan {
  const { profile, data, locked, cell } = args;
  const versionOf = (recipe: string) => versionInCell(profile, data, locked, cell.cell, recipe)!;
  const keys = cacheKeys(data, cell.recipes, versionOf, cell.cell.platform, args.imageId);
  const version = cell.cell.version;
  const license = cell.cell.license;
  return {
    platform: cell.cell.platform,
    setup: setupOf(data, cell.cell.platform),
    name: args.name ?? `ffmpeg-${version}-${cell.cell.platform}-${args.variant}`,
    target: args.variant,
    license,
    ...(args.release ? { release: args.release } : {}),
    sourcesArchive: `ffmpeg-${version}-sources.tar.gz`,
    libraries: cell.recipes.map((name) => {
      const key = keys.get(name)!;
      const licenseFiles = data.recipes.get(name)!['license-files'];
      return { name, version: versionOf(name), key, cached: existsSync(join(args.cacheDir, `${key}.tar.gz`)), source: sourceOf(data, name, versionOf(name)), licenseFiles };
    }),
    runtime: unique(cell.recipes.flatMap((r) => data.recipes.get(r)!.runtime ?? [])),
    ships: Object.entries(data.platforms.get(cell.cell.platform)?.ships ?? {}).map(([file, s]) => ({ file, notice: s.notice })),
    patches: plannedPatches(profile, cell.cell.major),
    legal: { label: LICENSE_LABEL[license], governing: GOVERNING_TEXTS[license], notice: licenseNotice(data, cell, args.variant) },
    ffmpeg: {
      version,
      archives: [data.ffmpegSource.url, ...data.ffmpegSource.mirrors].map((u) => expandTemplate(u, version)),
      configure: configureFlags(data, cell, args.depsDir),
      verify: verifyNames(data, cell),
    },
  };
}
