import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOrder, EngineDataError, ffmpegVersionSource, knownMajors, loadEngineData, optionsOf, recipeForPin, resolveName, versionSource } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { fixtureData, fixtureProfilesDir, writeEngine } from './helpers.ts';
import { cellBuildOrder } from '../src/resolve.ts';

const okFfmpeg = 'major: 9\nreleases: [9.0.0]\noptions: {}\n';
const okRecipe = (name: string, extra = '') =>
  `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n${extra}`;

function errorsOf(files: Record<string, string>): string[] {
  try {
    loadEngineData(writeEngine(files));
  } catch (e) {
    if (e instanceof EngineDataError) return e.errors;
    throw e;
  }
  throw new Error('expected an EngineDataError');
}

describe('engine data', () => {
  it('loads the fixture', () => {
    const data = fixtureData();
    expect(knownMajors(data)).toEqual(['8', '9']);
    expect(data.recipes.size).toBe(15);
    expect(data.ffmpeg.get('9')!.releases).toContain('9.1.0');
  });

  it('loads the engine data shipped in this repo', () => {
    expect(() => loadEngineData(packageRoot)).not.toThrow();
  });

  it('takes the group from the recipe into the option', () => {
    const openssl = optionsOf(fixtureData(), '9').get('openssl')!;
    expect(openssl).toMatchObject({ name: 'openssl', builtin: false, recipe: 'openssl', group: 'tls' });
    expect(optionsOf(fixtureData(), '9').get('schannel')).toMatchObject({ builtin: true, group: 'tls', platforms: ['win-*'] });
  });

  it('resolves with/without names: FFmpeg option names only, never recipe folders', () => {
    const data = fixtureData();
    expect(resolveName(data, 'nvenc')).toBe('nvenc');
    expect(resolveName(data, 'whep')).toBe('whep');
    expect(resolveName(data, 'nv-codec')).toBeUndefined();
    expect(resolveName(data, 'whisper.cpp')).toBeUndefined();
    expect(resolveName(data, 'gmp')).toBeUndefined();
    expect(resolveName(data, 'frobnicate')).toBeUndefined();
  });

  it('finds the library a pin refers to: an option name, or a library name (deps can break too)', () => {
    const data = fixtureData();
    expect(recipeForPin(data, 'nvenc')).toEqual({ recipe: 'nv-codec' });
    expect(recipeForPin(data, 'gmp')).toEqual({ recipe: 'gmp' });
    expect(recipeForPin(data, 'schannel')).toEqual({ error: expect.stringContaining('part of FFmpeg itself') });
    expect(recipeForPin(data, 'frobnicate')).toEqual({ error: expect.stringContaining("doesn't know") });
  });

  it('orders libraries dependencies-first', () => {
    // roots sorted (gnutls, libva, srt); each recipe's needs visited in name order, dependencies first
    expect(buildOrder(fixtureData(), ['srt', 'libva', 'gnutls'])).toEqual(['gmp', 'libtasn1', 'nettle', 'gnutls', 'libdrm', 'libva', 'srt']);
  });

  it('reports every problem with the file it is in', () => {
    const errors = errorsOf({
      // a file that fails its schema is skipped as a whole, so the schema problem gets its own file
      'ffmpeg/8.yml': 'major: 8\nreleases: [8.0.0]\noptions:\n  b: { builtin: true, needs: x }\n',
      'ffmpeg/9.yml': 'major: 8\nreleases: [9.0.0]\noptions:\n  a: { needs: missing }\n  c: { builtin: true, platforms: [beos-x64] }\n',
      'ffmpeg/10.yml': 'major: 10\nreleases: [10.0.0, 9.1.0, 10.0.0]\noptions: {}\n',
      'recipes/x/recipe.yml': okRecipe('y'),
      'recipes/p/recipe.yml': okRecipe('p', 'provides: nothing\n'),
      'recipes/loop1/recipe.yml': okRecipe('loop1', 'needs: [loop2]\n'),
      'recipes/loop2/recipe.yml': okRecipe('loop2', 'needs: [loop1]\n'),
      'recipes/half-made/.keep': '',
    });
    expect(errors).toEqual(expect.arrayContaining([
      'ffmpeg/9.yml: major is 8 but the file is named 9.yml',
      'ffmpeg/9.yml: options.a: needs missing, but there is no recipes/missing',
      expect.stringMatching(/^ffmpeg\/8\.yml: options\.b: .*either `builtin: true` or `needs: <recipe>`/),
      'ffmpeg/9.yml: options.c: platform "beos-x64" matches no platform',
      'recipes/x/recipe.yml: name is y but the folder is x',
      'ffmpeg/10.yml: release 9.1.0 is not an FFmpeg 10 release',
      'ffmpeg/10.yml: release 10.0.0 is listed twice',
      'recipes/p/recipe.yml: provides nothing, but no FFmpeg option by that name needs p',
      'recipes: loop1 -> loop2 -> loop1 needs itself',
      'recipes/half-made/recipe.yml: missing',
    ]));
  });

  it('names a missing ffmpeg/ or recipes/ folder', () => {
    expect(errorsOf({})).toEqual(['ffmpeg/: no <major>.yml files (like 9.yml)']);
    expect(() => loadEngineData(fixtureProfilesDir)).toThrow(/no ffmpeg\/ folder/);
  });

  it('flags FFmpeg data files that are not named <major>.yml', () => {
    expect(errorsOf({ 'ffmpeg/9.yml': okFfmpeg, 'ffmpeg/10.yaml': okFfmpeg })).toEqual([
      'ffmpeg/10.yaml: FFmpeg data files are named <major>.yml, like 9.yml',
    ]);
  });

  it('requires a recipe to build only where everything it needs builds', () => {
    const errors = errorsOf({
      'ffmpeg/9.yml': okFfmpeg,
      'recipes/a/recipe.yml': okRecipe('a', 'needs: [b]\n').replace('platforms: all', 'platforms: [linux-*, android-*]'),
      'recipes/b/recipe.yml': okRecipe('b').replace('platforms: all', 'platforms: [linux-*]'),
    });
    expect(errors).toEqual(["recipes/a/recipe.yml: needs b, which doesn't build for android-*"]);
  });

  it('reports bad YAML with its line', () => {
    expect(errorsOf({ 'ffmpeg/9.yml': 'major: 9\nmajor: 9\n' })).toEqual([expect.stringMatching(/^ffmpeg\/9\.yml:2: /)]);
  });
});

describe('version sources', () => {
  it("reads FFmpeg's own source", () => {
    const data = fixtureData();
    expect(data.ffmpegSource.git).toBe('https://github.com/FFmpeg/FFmpeg');
    expect(ffmpegVersionSource(data)).toEqual({ kind: 'git-tags', repo: 'https://github.com/FFmpeg/FFmpeg', pattern: /^n(\d+\.\d+(?:\.\d+)?)$/ });
  });

  it('turns each recipe into the place its versions come from', () => {
    const data = fixtureData();
    expect(versionSource(data, 'nv-codec')).toEqual({ kind: 'git-tags', repo: 'https://github.com/FFmpeg/nv-codec-headers', pattern: /^n(\d+\.\d+\.\d+\.\d+)$/ });
    expect(versionSource(data, 'mbedtls')).toEqual({ kind: 'git-tags', repo: 'https://github.com/Mbed-TLS/mbedtls', pattern: /^v(3\.\d+\.\d+)$/ });
    expect(versionSource(data, 'gmp')).toEqual({ kind: 'listing', url: 'https://gmplib.org/download/gmp/', pattern: /gmp-(\d+\.\d+\.\d+)\.tar\.xz/ });
  });

  it("records FFmpeg's minimum version on the option", () => {
    expect(optionsOf(fixtureData(), '9').get('dav1d')!.min).toBe('1.0.0');
  });

  it('checks every version source when loading', () => {
    const recipe = (name: string, versions: string, source = `{ git: https://example.com/${name} }`) =>
      `name: ${name}\nlicense: MIT\nsource: ${source}\nversions: ${versions}\nplatforms: all\n`;
    const errors = errorsOf({
      'ffmpeg/9.yml': okFfmpeg,
      'recipes/a/recipe.yml': recipe('a', '{ git-tags: "^v.*$" }'),
      'recipes/b/recipe.yml': recipe('b', '{ git-tags: "^v(1" }'),
      'recipes/c/recipe.yml': recipe('c', '{ git-tags: "^v(.*)$" }', '{ url: https://example.com/c.tar.gz }'),
      'recipes/d/recipe.yml': recipe('d', '{ git-tags: "^v(.*)$", listing: https://example.com }'),
      'recipes/e/recipe.yml': recipe('e', '{ git-branch: stable }', '{ url: https://example.com/e.tar.gz }'),
    });
    expect(errors).toEqual([
      // shape problems are found while reading files, before the cross-checks
      'recipes/d/recipe.yml: versions: unknown key "listing"', // a git-tags entry with a stray key
      'recipes/a/recipe.yml: versions.git-tags needs a ( ) group around the version',
      expect.stringMatching(/^recipes\/b\/recipe\.yml: versions\.git-tags is not a valid regex: /),
      'recipes/c/recipe.yml: versions.git-tags needs source.git or versions.repo to read from',
      'recipes/e/recipe.yml: versions.git-branch needs source.git or versions.repo to read from',
    ]);
  });

  it('needs ffmpeg/source.yml, and does not mistake it for a <major>.yml file', () => {
    const root = writeEngine({ 'ffmpeg/9.yml': okFfmpeg });
    expect(() => loadEngineData(root)).not.toThrow();
    rmSync(join(root, 'ffmpeg', 'source.yml'));
    expect(() => loadEngineData(root)).toThrow(/ffmpeg\/source\.yml: missing/);
  });
});

describe('recipe notes', () => {
  it('needs each notes key to be a version or range', () => {
    const recipe = `name: a\nlicense: MIT\nsource: { git: https://example.com/a }\nversions: { git-tags: '^v(.*)$' }\nnotes:\n  "13.x": needs a new driver\nplatforms: all\n`;
    expect(errorsOf({ 'ffmpeg/9.yml': okFfmpeg, 'recipes/a/recipe.yml': recipe })).toEqual(['recipes/a/recipe.yml: notes key "13.x" is not a version or range']);
  });
});

describe('sources for building', () => {
  it('reads git and tarball sources, with ref defaulting to the version', () => {
    const data = fixtureData();
    expect(data.recipes.get('x265')!.source).toEqual({ git: 'https://github.com/Multicorewareinc/x265', ref: '{version}' });
    expect(data.recipes.get('gmp')!.source).toEqual({ url: 'https://gmplib.org/download/gmp/gmp-{version}.tar.xz' });
  });

  it("knows where FFmpeg's own source tarball is", () => {
    expect(fixtureData().ffmpegSource).toMatchObject({
      url: 'https://ffmpeg.org/releases/ffmpeg-{version}.tar.xz',
      mirrors: ['https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n{version}.tar.gz'],
    });
  });

  it('rejects a source that is neither git nor a tarball', () => {
    const recipe = "name: a\nlicense: MIT\nsource: { svn: https://example.com/a }\nversions: { git-tags: '^v(.*)$', repo: https://example.com/a }\nplatforms: all\n";
    expect(errorsOf({ 'ffmpeg/9.yml': okFfmpeg, 'recipes/a/recipe.yml': recipe })).toEqual([
      expect.stringMatching(/^recipes\/a\/recipe\.yml: source: /),
    ]);
  });
});

describe('runtime files', () => {
  it('must stay inside the deps folder', () => {
    const recipe = (runtime: string) => `name: a\nlicense: MIT\nsource: { git: https://example.com/a }\nversions: { git-tags: '^v(.*)$' }\nruntime: ['${runtime}']\nplatforms: all\n`;
    expect(errorsOf({ 'ffmpeg/9.yml': okFfmpeg, 'recipes/a/recipe.yml': recipe('../etc/*') })).toEqual([expect.stringMatching(/^recipes\/a\/recipe\.yml: runtime\[0\]: /)]);
    expect(errorsOf({ 'ffmpeg/9.yml': okFfmpeg, 'recipes/a/recipe.yml': recipe('/lib/x.so') })).toEqual([expect.stringMatching(/^recipes\/a\/recipe\.yml: runtime\[0\]: /)]);
  });
});

describe('licences in engine data', () => {
  it('rejects a recipe licence the table does not know', () => {
    const recipe = "name: a\nlicense: MIT OR Foo-1.0\nsource: { git: https://example.com/a }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n";
    expect(errorsOf({ 'ffmpeg/9.yml': okFfmpeg, 'recipes/a/recipe.yml': recipe })).toEqual([
      'recipes/a/recipe.yml: license: "Foo-1.0" is not in licenses.yml; add it there with the profile licenses it may be linked into',
    ]);
  });

  it('needs licenses.yml', () => {
    const root = writeEngine({ 'ffmpeg/9.yml': okFfmpeg });
    rmSync(join(root, 'licenses.yml'));
    expect(() => loadEngineData(root)).toThrow(/licenses\.yml/);
  });
});

describe('platforms.yml', () => {
  it('loads what each platform builds with', () => {
    expect(fixtureData().platforms.get('linux-x64')).toMatchObject({ image: 'linux-x64', setup: 'linux' });
  });

  it('rejects a platform ffmpeg-build does not know', () => {
    expect(errorsOf({ 'ffmpeg/9.yml': okFfmpeg, 'platforms.yml': 'platforms:\n  linux-x86: { image: linux-x64, setup: linux }\n' })).toEqual([
      'platforms.yml: linux-x86 is not a platform ffmpeg-build knows',
    ]);
  });

  it('needs platforms.yml', () => {
    const root = writeEngine({ 'ffmpeg/9.yml': okFfmpeg });
    rmSync(join(root, 'platforms.yml'));
    expect(() => loadEngineData(root)).toThrow(/platforms\.yml: missing/);
  });
});

describe('dependencies per platform', () => {
  const recipe = (name: string, extra = '', platforms = 'all') =>
    `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: ${platforms}\n${extra}`;

  it('checks a platform-limited dependency only on the platforms it applies to', () => {
    expect(() => loadEngineData(writeEngine({
      'ffmpeg/9.yml': okFfmpeg,
      'recipes/a/recipe.yml': recipe('a', 'needs: [{ c: { platforms: [linux-*] } }]\n'),
      'recipes/c/recipe.yml': recipe('c', '', '[linux-*]'),
    }))).not.toThrow();
  });

  it('names the platforms where a platform-limited dependency does not build', () => {
    expect(errorsOf({
      'ffmpeg/9.yml': okFfmpeg,
      'recipes/a/recipe.yml': recipe('a', 'needs: [{ c: { platforms: [linux-*] } }]\n'),
      'recipes/c/recipe.yml': recipe('c', '', '[linux-x64]'),
    })).toEqual(["recipes/a/recipe.yml: needs c, which doesn't build for linux-arm64, linux-armhf, linux-musl-*"]);
  });

  it('rejects a dependency condition that matches no platform', () => {
    expect(errorsOf({
      'ffmpeg/9.yml': okFfmpeg,
      'recipes/a/recipe.yml': recipe('a', 'needs: [{ c: { platforms: [beos-*] } }]\n'),
      'recipes/c/recipe.yml': recipe('c'),
    })).toEqual(['recipes/a/recipe.yml: needs c: platform "beos-*" matches no platform']);
  });
});

describe('dependencies per platform: more', () => {
  const recipe = (name: string, extra = '') =>
    `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n${extra}`;

  it('finds a cycle through a platform-limited dependency', () => {
    const errors = errorsOf({
      'ffmpeg/9.yml': okFfmpeg,
      'recipes/a/recipe.yml': recipe('a', 'needs: [{ b: { platforms: [win-*] } }]\n'),
      'recipes/b/recipe.yml': recipe('b', 'needs: [a]\n'),
    });
    expect(errors).toEqual(['recipes: a -> b -> a needs itself']);
  });

  it('rejects a uses condition that matches no platform', () => {
    expect(errorsOf({
      'ffmpeg/9.yml': okFfmpeg,
      'recipes/a/recipe.yml': recipe('a', 'uses: [{ c: { platforms: [beos-*] } }]\n'),
      'recipes/c/recipe.yml': recipe('c'),
    })).toEqual(['recipes/a/recipe.yml: uses c: platform "beos-*" matches no platform']);
  });

  it('leaves a uses piece for other platforms out of a build, without reporting it', () => {
    const d = loadEngineData(writeEngine({
      'ffmpeg/9.yml': okFfmpeg,
      'recipes/a/recipe.yml': recipe('a', 'uses: [{ c: { platforms: [win-*] } }]\n'),
      'recipes/c/recipe.yml': recipe('c'),
    }));
    const linux = cellBuildOrder(d, { series: '9', major: '9', version: '9.0.0', license: 'lgplv3', platform: 'linux-x64' }, ['a']);
    expect(linux).toEqual({ order: ['a'], leftOut: [] });
  });
});

describe('option libraries per platform', () => {
  it('needs each one to exist and to build where it applies', () => {
    const recipe = (name: string, platforms: string) =>
      `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: ${platforms}\n`;
    expect(errorsOf({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  v: { needs: [{ a: { platforms: [linux-*] } }, { b: { platforms: [win-*] } }] }\n',
      'recipes/a/recipe.yml': recipe('a', '[linux-x64]'),
    })).toEqual([
      "ffmpeg/9.yml: options.v: needs a, which doesn't build for linux-arm64, linux-armhf, linux-musl-*",
      'ffmpeg/9.yml: options.v: needs b, but there is no recipes/b',
    ]);
  });

  it('pins and prints the library by its own name', () => {
    const recipe = (name: string) => `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n`;
    const d = loadEngineData(writeEngine({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  v: { needs: [{ a: { platforms: [linux-*] } }, { b: { platforms: [win-*] } }] }\n',
      'recipes/a/recipe.yml': recipe('a'),
      'recipes/b/recipe.yml': recipe('b'),
    }));
    expect(recipeForPin(d, 'a')).toEqual({ recipe: 'a' });
    expect(recipeForPin(d, 'v')).toEqual({ error: 'v uses a different library per platform (a, b); pin the library by its name.' });
  });
});

describe('option libraries per platform: one per platform', () => {
  const recipe = (name: string) => `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n`;
  const errs = (needs: string) => errorsOf({
    'ffmpeg/9.yml': `major: 9\nreleases: [9.0.0]\noptions:\n  v: { needs: ${needs} }\n`,
    'recipes/a/recipe.yml': recipe('a'),
    'recipes/b/recipe.yml': recipe('b'),
  });

  it('rejects two libraries for the same platform', () => {
    expect(errs('[{ a: { platforms: [linux-*] } }, { b: { platforms: [linux-x64, win-*] } }]')).toEqual([
      'ffmpeg/9.yml: options.v: needs both a and b on linux-x64; each platform gets one library',
    ]);
  });

  it('allows a library without platforms only when it is the only one', () => {
    expect(errs('[a, { b: { platforms: [win-*] } }]')).toEqual([
      'ffmpeg/9.yml: options.v: needs a on every platform and b on some; give a its platforms too',
    ]);
  });
});

describe('what a platform ships besides its libraries', () => {
  it('needs a licence the table knows', () => {
    expect(errorsOf({
      'ffmpeg/9.yml': okFfmpeg,
      'platforms.yml': 'platforms:\n  linux-x64: { image: linux-x64, setup: linux, ships: { libfoo.so: { license: Foo-1.0, notice: /x/NOTICE } } }\n',
    })).toEqual(['platforms.yml: linux-x64 ships libfoo.so under "Foo-1.0", which is not in licenses.yml; add it there with the profile licenses it may be linked into']);
  });

  it('needs the notice file of each, as well as its licence', () => {
    expect(errorsOf({
      'ffmpeg/9.yml': okFfmpeg,
      'platforms.yml': 'platforms:\n  linux-x64: { image: linux-x64, setup: linux, ships: { libfoo.so: MIT } }\n',
    })).toEqual(['platforms.yml: platforms.linux-x64.ships.libfoo.so: expected { license: <SPDX>, notice: <path of its licence text> }']);
  });
});
