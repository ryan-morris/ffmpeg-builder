import { z } from 'zod';
import { flag, name, oneOrMany, text, version } from './common.ts';

export const FFMPEG_LICENSE_CLASSES = ['gpl', 'version3', 'nonfree'] as const;
export type FfmpegLicenseClass = (typeof FFMPEG_LICENSE_CLASSES)[number];

const platforms = oneOrMany(text, 'expected all, or a list of platform patterns like linux-* or win-x64');

/** A dependency: a recipe name, or `{ <name>: { platforms: [...] } }` for one only some platforms need. */
export interface Dep { name: string; platforms?: string[] }
const dep = z.union(
  [
    name.transform((n): Dep => ({ name: n })),
    z
      .record(name, z.strictObject({ platforms: z.array(text).min(1) }))
      .refine((o) => Object.keys(o).length === 1, { error: 'each dependency names exactly one recipe' })
      .transform((o): Dep => {
        const [n, cond] = Object.entries(o)[0]!;
        return { name: n, platforms: cond.platforms };
      }),
  ],
  { error: 'expected a recipe name, or one limited to platforms like `vulkan-shim: { platforms: [win-*] }`' },
);

/** One option FFmpeg's configure offers, as recorded in ffmpeg/<major>.yml. */
const option = z
  .strictObject({
    builtin: flag.optional(),
    // its library: one recipe, or one per platform like [{ vulkan-loader: { platforms: [linux-*] } }, ...]
    needs: z.union([name.transform((n): Dep[] => [{ name: n }]), z.array(dep).min(1)]).optional(),
    kind: text.optional(),
    since: version.optional(),
    min: version.optional(),
    'ffmpeg-license': z.enum(FFMPEG_LICENSE_CLASSES, { error: 'expected gpl, version3 or nonfree' }).optional(),
    platforms: platforms.optional(),
    group: name.optional(),
    configure: z.array(text).optional(), // overrides the recipe's flags, for a library behind several options
  })
  .refine((o) => (o.builtin === true) !== (o.needs !== undefined), {
    error: 'an option is either `builtin: true` or `needs: <recipe>` (or a list per platform), not both or neither',
  });

export const ffmpegDataSchema = z.strictObject({
  major: z.string({ error: 'expected a major version' }).regex(/^\d+$/, { error: 'expected a major version like 9' }),
  releases: z.array(version).min(1),
  options: z.record(name, option),
});
export type FfmpegData = z.output<typeof ffmpegDataSchema>;

/** Where a library's versions come from: git tags, a branch head, or a release listing page. */
const versionsSchema = z.union(
  [
    z.strictObject({ 'git-tags': text, repo: text.optional() }),
    z.strictObject({ listing: text, files: text }),
    z.strictObject({ 'git-branch': text, repo: text.optional() }),
  ],
  { error: 'expected one of: `git-tags: <regex>`, `listing: <url>` with `files: <regex>`, or `git-branch: <name>`' },
);

/** Where a library's source comes from: a git repo checked out at `ref`, or a tarball (with fallbacks). */
const sourceSchema = z.union(
  [
    z.strictObject({ git: text, ref: text.default('{version}'), mirror: text.optional() }),
    z.strictObject({ url: text, mirrors: z.array(text).optional() }),
  ],
  { error: 'expected `git: <url>` (with `ref:` and an optional `mirror:`) or `url: <tarball url>` (with optional `mirrors:`)' },
);

/** A relative path that stays inside its folder: no leading /, no `..`, no backslashes. */
export const relativePath = text.refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '.' || s === ''), {
  error: 'expected a relative path inside the folder, like COPYING or docs/FTL.TXT',
});

/**
 * One licence file a library ships with: a path in its source (`COPYING`), or `{ recipe: <file> }` for a file kept
 * beside recipe.yml, for sources that have none (header-only drops).
 */
export interface LicenseFile { path: string; recipe?: true }
const licenseFile = z.union(
  [
    relativePath.transform((path): LicenseFile => ({ path })),
    z.strictObject({ recipe: relativePath }).transform((o): LicenseFile => ({ path: o.recipe, recipe: true })),
  ],
  { error: 'expected a path in the source like COPYING, or `{ recipe: LICENSE }` for a file beside recipe.yml' },
);

/** recipes/<name>/recipe.yml: facts about one library. Never a version. */
export const recipeSchema = z.strictObject({
  name,
  provides: name.optional(), // the FFmpeg option this library is for; checked against ffmpeg/<major>.yml
  license: text, // SPDX expression; checked against profile licenses in a later step
  // the licence texts the archives carry in THIRD-PARTY-NOTICES.txt; a build fails when one is missing
  'license-files': z.array(licenseFile, { error: 'expected a list of licence files, like [COPYING]' }).min(1, { error: 'name at least one licence file' }),
  configure: z.array(text).default([]),
  needs: z.array(dep).default([]),
  uses: z.array(dep).default([]), // optional pieces, built in where the build's license and platform allow
  group: name.optional(),
  source: sourceSchema,
  versions: versionsSchema,
  notes: z.record(z.string(), text).optional(),
  // globs under DEPS_DIR that ship next to FFmpeg's libraries; relative and inside it
  runtime: z.array(text.refine((g) => !g.startsWith('/') && !g.split('/').includes('..'), { error: 'expected a path inside the deps folder, like lib/libvulkan.so*' })).optional(),
  platforms,
});
export type Recipe = z.output<typeof recipeSchema>;

/** ffmpeg/source.yml: where FFmpeg's own versions come from. */
export const ffmpegSourceSchema = z.strictObject({
  git: text,
  versions: z.strictObject({ 'git-tags': text }),
  url: text,
  mirrors: z.array(text).default([]),
});

/** platforms.yml: what every build for a platform needs (its toolchain image, setup script and configure flags). */
export const platformsSchema = z.strictObject({
  platforms: z.record(
    text,
    z.strictObject({
      image: text,
      setup: name,
      runner: text.optional(), // the CI runner it builds on (default ubuntu-24.04)
      configure: z.array(text).optional(),
      // files the archives carry besides FFmpeg's and the recipes': name -> its SPDX licence and its notice file, a path
      // in the toolchain where ${VAR} is a variable of the platform's setup (its text goes into THIRD-PARTY-NOTICES.txt)
      ships: z.record(text, z.strictObject({ license: text, notice: text }, { error: 'expected { license: <SPDX>, notice: <path of its licence text> }' })).optional(),
    }),
  ),
});
export interface Shipped { license: string; notice: string }
export type PlatformEntry = { image: string; setup: string; runner?: string; configure: string[]; ships: Record<string, Shipped> };
