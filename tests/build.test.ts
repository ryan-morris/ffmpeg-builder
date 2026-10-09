import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerRunArgs, hostUserOf, imageTag, mountArgs, runStreaming } from '../src/build/docker.ts';
import { cacheKeys, configureFlags, expandTemplate, makeBuildPlan, sourceOf, toolchainIdentity, verifyNames } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import type { LockedProfile } from '../src/lockfile.ts';
import { loadProfile, parseProfileText, type Profile } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';
import { fixtureData, fixtureEngineRoot, fixtureProfilesDir, writeEngine } from './helpers.ts';

const data = fixtureData();
const dvr = (() => {
  const r = loadProfile(join(fixtureProfilesDir, 'dvr.yml'));
  if (!r.ok) throw new Error('dvr.yml');
  return r.profile;
})();
const dvrLock: LockedProfile = {
  ffmpeg: { '9': '9.1.0' },
  libraries: { dav1d: '1.5.4', libdrm: '2.4.134', libva: '2.24.1', mbedtls: '3.6.5', 'nv-codec': '13.0.19.1', opus: '1.6.1', srt: '1.5.8' },
  pinned: [],
};
const linuxCell = (profile: Profile, locked: LockedProfile) => planProfile(profile, data, locked.ffmpeg).cells.find((c) => c.cell.platform === 'linux-x64')!;
function profile(text: string): Profile {
  const r = parseProfileText(text, 't.yml');
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.profile;
}

describe('sources', () => {
  it('fills version templates', () => {
    expect(expandTemplate('https://x/gnutls/v{major}.{minor}/gnutls-{version}.tar.xz', '3.8.13')).toBe('https://x/gnutls/v3.8/gnutls-3.8.13.tar.xz');
    expect(expandTemplate('n{version}-{patch}', '9.0')).toBe('n9.0-');
  });

  it('gives a git ref, a commit, or tarball urls', () => {
    expect(sourceOf(data, 'nv-codec', '13.0.19.1')).toEqual({ git: 'https://github.com/FFmpeg/nv-codec-headers', ref: 'n13.0.19.1' });
    expect(sourceOf(data, 'gnutls', '3.8.13')).toEqual({ archives: ['https://www.gnupg.org/ftp/gcrypt/gnutls/v3.8/gnutls-3.8.13.tar.xz'] });
    const engine = loadEngineData(writeEngine({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  x264: { needs: x264 }\n',
      'recipes/x264/recipe.yml': 'name: x264\nlicense: GPL-2.0-or-later\nsource: { git: https://example.com/x264, mirror: https://example.org/x264 }\nversions: { git-branch: stable }\nplatforms: all\n',
    }));
    const commit = 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55';
    expect(sourceOf(engine, 'x264', commit)).toEqual({ git: 'https://example.com/x264', commit, mirror: 'https://example.org/x264' });
  });
});

describe('FFmpeg configure', () => {
  it('has the base flags, the license flags and each option recipe flags', () => {
    const flags = configureFlags(data, linuxCell(dvr, dvrLock));
    expect(flags.slice(0, 2)).toEqual(['--enable-shared', '--disable-static']);
    expect(flags).toContain('--enable-ffmpeg'); // from platforms.yml
    expect(flags).toContain('--enable-ffprobe');
    expect(flags).toContain('--disable-autodetect');
    expect(flags).toContain('--pkg-config-flags=--static');
    expect(flags).toContain('--extra-cflags=-I/opt/ffmpeg-build/deps/include');
    expect(flags).toContain('--extra-libs=-lpthread -ldl');
    for (const f of ['--enable-gpl', '--enable-version3', '--enable-nonfree', '--enable-libdav1d', '--enable-ffnvcodec', '--enable-libsrt', '--enable-libopus', '--enable-vaapi']) expect(flags).toContain(f);
    expect(flags.filter((f) => f === '--enable-gpl')).toHaveLength(1);
  });

  it('enables a built-in option by its name', () => {
    const p = profile('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [whep]\n');
    const cell = planProfile(p, data, { '9': '9.1.0' }).cells[0]!;
    expect(configureFlags(data, cell)).toContain('--enable-whep');
    expect(configureFlags(data, cell)).toContain('--enable-version3');
    expect(configureFlags(data, cell)).not.toContain('--enable-gpl');
    expect(configureFlags(data, cell)).toContain('--disable-gpl');
    expect(configureFlags(data, cell)).toContain('--disable-nonfree');
  });

  it("names what to verify in FFmpeg's config.mak", () => {
    expect(verifyNames(data, linuxCell(dvr, dvrLock))).toEqual(['LIBDAV1D', 'FFNVCODEC', 'NVENC', 'NVDEC', 'CUVID', 'LIBOPUS', 'LIBSRT', 'VAAPI']);
  });
});

describe('cache keys', () => {
  const versions: Record<string, string> = { libdrm: '2.4.134', libva: '2.24.1', dav1d: '1.5.4' };
  const keys = (d = data, v = versions) => cacheKeys(d, ['dav1d', 'libdrm', 'libva'], (r) => v[r]!, 'linux-x64', 'abc123');

  it('are stable', () => {
    expect(keys()).toEqual(keys());
    expect(keys().get('dav1d')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('change for a dependent when its dependency changes', () => {
    const changed = keys(data, { ...versions, libdrm: '2.4.135' });
    expect(changed.get('libdrm')).not.toBe(keys().get('libdrm'));
    expect(changed.get('libva')).not.toBe(keys().get('libva')); // libva needs libdrm
    expect(changed.get('dav1d')).toBe(keys().get('dav1d'));
  });

  it("change for a library's licence files, but not for what builds against it", () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-keys-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    const yml = join(root, 'recipes', 'libdrm', 'recipe.yml');
    writeFileSync(yml, readFileSync(yml, 'utf8').replace('license-files: [COPYING]', 'license-files: [COPYING, { recipe: NOTICE }]'));
    writeFileSync(join(root, 'recipes', 'libdrm', 'NOTICE'), 'kept beside the recipe\n');
    const edited = loadEngineData(root);
    expect(keys(edited).get('libdrm')).not.toBe(keys().get('libdrm'));
    expect(keys(edited).get('libva')).toBe(keys().get('libva')); // libva needs libdrm
    const before = keys(edited).get('libdrm'); // keys read the files when they're computed
    writeFileSync(join(root, 'recipes', 'libdrm', 'NOTICE'), 'changed\n');
    expect(keys(loadEngineData(root)).get('libdrm')).not.toBe(before);
    expect(keys(loadEngineData(root)).get('libva')).toBe(keys().get('libva'));
    writeFileSync(join(root, 'recipes', 'libdrm', 'build.sh'), 'echo changed\n');
    expect(keys(loadEngineData(root)).get('libva')).not.toBe(keys().get('libva')); // anything else still counts
  });

  it('change when a recipe file changes, or the platform or image does', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-keys-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    writeFileSync(join(root, 'recipes', 'dav1d', 'build.sh'), 'meson_build\n');
    const edited = loadEngineData(root);
    expect(keys(edited).get('dav1d')).not.toBe(keys().get('dav1d'));
    expect(keys(edited).get('libdrm')).toBe(keys().get('libdrm'));
    expect(cacheKeys(data, ['dav1d'], () => '1.5.4', 'linux-arm64', 'abc123').get('dav1d')).not.toBe(keys().get('dav1d'));
    expect(cacheKeys(data, ['dav1d'], () => '1.5.4', 'linux-x64', 'def456').get('dav1d')).not.toBe(keys().get('dav1d'));
  });
});

describe('the build plan', () => {
  it('lists libraries in build order with their exact versions, keys and sources', () => {
    const cache = mkdtempSync(join(tmpdir(), 'ffmpeg-build-cache-'));
    const plan = makeBuildPlan({ profile: dvr, data, locked: dvrLock, cell: linuxCell(dvr, dvrLock), variant: 'nonfree', imageId: 'abc123', cacheDir: cache });
    expect(plan.name).toBe('ffmpeg-9.1.0-linux-x64-nonfree');
    expect(plan.platform).toBe('linux-x64');
    expect(plan.libraries.map((l) => `${l.name} ${l.version}`)).toEqual(['dav1d 1.5.4', 'libdrm 2.4.134', 'libva 2.24.1', 'nv-codec 13.0.19.1', 'opus 1.6.1', 'mbedtls 3.6.5', 'srt 1.5.8']);
    expect(plan.libraries.every((l) => !l.cached && /^[0-9a-f]{64}$/.test(l.key))).toBe(true);
    expect(plan.ffmpeg).toMatchObject({
      version: '9.1.0',
      archives: ['https://ffmpeg.org/releases/ffmpeg-9.1.0.tar.xz', 'https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n9.1.0.tar.gz'],
    });
    writeFileSync(join(cache, `${plan.libraries[0]!.key}.tar.gz`), '');
    const again = makeBuildPlan({ profile: dvr, data, locked: dvrLock, cell: linuxCell(dvr, dvrLock), variant: 'nonfree', imageId: 'abc123', cacheDir: cache });
    expect(again.libraries[0]!.cached).toBe(true);
  });
});

describe('docker mounts', () => {
  it('uses --mount so Windows paths with spaces and drive letters work', () => {
    const args = mountArgs({ recipes: 'D:\\My Builds\\recipes', engine: 'D:\\e\\platforms', cache: 'C:\\c', out: 'D:\\out', plan: 'C:\\t\\plan.json' });
    expect(mountArgs({ recipes: 'D:\\a,b', engine: 'e', cache: 'c', out: 'o', plan: 'p' })[1]).toBe('type=bind,"source=D:\\a,b",target=/recipes,readonly');
    expect(args).toEqual([
      '--mount', 'type=bind,source=D:\\My Builds\\recipes,target=/recipes,readonly',
      '--mount', 'type=bind,source=D:\\e\\platforms,target=/engine,readonly',
      '--mount', 'type=bind,source=C:\\c,target=/cache',
      '--mount', 'type=bind,source=D:\\out,target=/out',
      '--mount', 'type=bind,source=C:\\t\\plan.json,target=/plan.json,readonly',
    ]);
  });
});

describe('review fixes', () => {
  it('chain the key of a uses member that is in the build', () => {
    const keysWith = (mbedtls: string, recipes: string[]) =>
      cacheKeys(data, recipes, (r) => ({ mbedtls, srt: '1.5.8' })[r]!, 'linux-x64', 'abc').get('srt');
    expect(keysWith('3.6.8', ['mbedtls', 'srt'])).not.toBe(keysWith('3.6.7', ['mbedtls', 'srt']));
    expect(keysWith('3.6.8', ['srt'])).toBe(keysWith('3.6.7', ['srt'])); // mbedtls not in this build
  });

  it('count the image, the driver and the platform setup (with what it sources) as the toolchain', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-driver-'));
    mkdirSync(join(root, 'platforms', 'setup'), { recursive: true });
    const write = (path: string, text: string) => writeFileSync(join(root, 'platforms', path), text);
    write('driver.sh', 'echo build\n');
    write('setup/linux.sh', 'source "${ENGINE}/setup/linux-stage.sh"\nexport CFLAGS=-fPIC\n');
    write('setup/linux-stage.sh', 'stage() { :; }\n');
    write('setup/windows.sh', 'export CC=x\n');
    const id = () => toolchainIdentity(root, 'sha256:aaa', 'linux');
    const before = id();
    expect(toolchainIdentity(root, 'sha256:bbb', 'linux')).not.toBe(before);
    write('setup/windows.sh', 'export CC=y\n');
    expect(id()).toBe(before); // another platform's setup
    write('setup/linux-stage.sh', 'stage() { echo; }\n');
    const afterHelper = id();
    expect(afterHelper).not.toBe(before); // a helper it sources
    write('driver.sh', 'echo build2\n');
    expect(id()).not.toBe(afterHelper);
  });

  it("follows a helper sourced with '.', and refuses a setup that isn't there", () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-driver-'));
    mkdirSync(join(root, 'platforms', 'setup'), { recursive: true });
    writeFileSync(join(root, 'platforms', 'driver.sh'), 'echo build\n');
    writeFileSync(join(root, 'platforms', 'setup', 'a.sh'), '. "${ENGINE}/setup/b.sh"\n');
    writeFileSync(join(root, 'platforms', 'setup', 'b.sh'), 'x=1\n');
    const before = toolchainIdentity(root, 'id', 'a');
    writeFileSync(join(root, 'platforms', 'setup', 'b.sh'), 'x=2\n');
    expect(toolchainIdentity(root, 'id', 'a')).not.toBe(before);
    expect(() => toolchainIdentity(root, 'id', 'missing')).toThrow(/platforms\/setup\/missing\.sh/);
  });

  it('tags each toolchain image by its name and Dockerfile', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-images-'));
    mkdirSync(join(root, 'images', 'linux-musl-x64'), { recursive: true });
    writeFileSync(join(root, 'images', 'linux-musl-x64', 'Dockerfile'), 'FROM alpine\n');
    expect(imageTag(root, 'linux-musl-x64')).toMatch(/^ffmpeg-build-linux-musl-x64:[0-9a-f]{12}$/);
  });

  it("puts the platform's setup in the plan", () => {
    expect(makeBuildPlan({ profile: dvr, data, locked: dvrLock, cell: linuxCell(dvr, dvrLock), variant: 'nonfree', imageId: 'x', cacheDir: tmpdir() }).setup).toBe('linux');
  });

  it("hands the build's files back to the host user on Linux, and nowhere else", () => {
    const linux = dockerRunArgs({ tag: 'img:1', recipes: 'r', engine: 'e', cache: 'c', out: 'o', plan: 'p', hostUser: { uid: 1001, gid: 118 } });
    expect(linux.join(' ')).toContain('-e FFB_HOST_UID=1001 -e FFB_HOST_GID=118');
    expect(hostUserOf('win32')).toBeUndefined();
    expect(hostUserOf('darwin')).toBeUndefined();
  });

  it('runs the driver with --init, so Ctrl-C stops the container', () => {
    const args = dockerRunArgs({ tag: 'img:1', recipes: 'r', engine: 'e', cache: 'c', out: 'o', plan: 'p' });
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init']);
    expect(args.slice(-3)).toEqual(['img:1', 'bash', '/engine/driver.sh']);
  });

  it('remembers the last ERROR line, to name what failed', async () => {
    const script = "console.log('compiling'); console.error('ERROR: building x265 4.3 failed (see above)'); process.exit(3)";
    expect(await runStreaming(process.execPath, ['-e', script])).toEqual({ code: 3, lastError: 'building x265 4.3 failed (see above)' });
  });
});

describe('recipe extras for 3b', () => {
  const engine = () =>
    loadEngineData(writeEngine({
      'ffmpeg/9.yml': [
        'major: 9', 'releases: [9.0.0]', 'options:',
        '  opencore-amrnb: { needs: opencore-amr, configure: [--enable-libopencore-amrnb] }',
        '  opencore-amrwb: { needs: opencore-amr, configure: [--enable-libopencore-amrwb] }',
        '  vulkan: { needs: vulkan-loader }', '',
      ].join('\n'),
      'recipes/opencore-amr/recipe.yml': 'name: opencore-amr\nlicense: Apache-2.0\nconfigure: [--enable-libopencore-amrnb, --enable-libopencore-amrwb]\nsource: { url: "https://example.com/opencore-amr-{version}.tar.gz" }\nversions: { listing: "https://example.com/", files: \'^opencore-amr-(\\d+\\.\\d+\\.\\d+)\\.tar\\.gz$\' }\nplatforms: all\n',
      'recipes/vulkan-loader/recipe.yml': "name: vulkan-loader\nlicense: Apache-2.0\nconfigure: [--enable-vulkan]\nsource: { git: https://example.com/loader, ref: 'vulkan-sdk-{version}' }\nversions: { git-tags: '^vulkan-sdk-(\\d+\\.\\d+\\.\\d+\\.\\d+)$' }\nruntime: ['lib/libvulkan.so*']\nplatforms: [linux-*]\n",
    }));

  it('lets an option give its own configure flags instead of its recipe', () => {
    const data2 = engine();
    const p = profile('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [opencore-amrnb]\n');
    const cell = planProfile(p, data2, { '9': '9.0.0' }).cells[0]!;
    expect(configureFlags(data2, cell)).toContain('--enable-libopencore-amrnb');
    expect(configureFlags(data2, cell)).not.toContain('--enable-libopencore-amrwb');
  });

  it("collects the files recipes ship next to FFmpeg's libraries", () => {
    const data2 = engine();
    const p = profile('name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [vulkan]\n');
    const cell = planProfile(p, data2, { '9': '9.0.0' }).cells[0]!;
    const locked = { ffmpeg: { '9': '9.0.0' }, libraries: { 'vulkan-loader': '1.4.363.0' }, pinned: [] };
    const plan = makeBuildPlan({ profile: p, data: data2, locked, cell, variant: 'lgplv3', imageId: 'x', cacheDir: mkdtempSync(join(tmpdir(), 'c-')) });
    expect(plan.runtime).toEqual(['lib/libvulkan.so*']);
    expect(plan.libraries[0]!.source).toEqual({ git: 'https://example.com/loader', ref: 'vulkan-sdk-1.4.363.0' });
  });

  it('fills dash and underscore version templates', () => {
    expect(expandTemplate('R_{version_}', '2.8.3')).toBe('R_2_8_3');
    expect(expandTemplate('VER-{version-}', '2.14.3')).toBe('VER-2-14-3');
  });
});

describe('cache keys per platform', () => {
const platformEngine = (cPlatforms = 'all', cLicense = 'MIT') => {
  const recipe = (name: string, extra = '') =>
    `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n${extra}`;
  return loadEngineData(writeEngine({
    'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a }\n',
    'recipes/a/recipe.yml': recipe('a', 'needs: [b, { c: { platforms: [win-*] } }]\n'),
    'recipes/b/recipe.yml': recipe('b'),
    'recipes/c/recipe.yml': recipe('c').replace('license: MIT', `license: ${cLicense}`).replace('platforms: all', `platforms: ${cPlatforms}`),
  }));
};

  it('chain a platform-limited dependency only where it applies', () => {
    const d = platformEngine();
    const keyOfA = (c: string, platform: string) => cacheKeys(d, ['b', 'c', 'a'], (r) => ({ a: '1', b: '1', c })[r]!, platform, 'tc').get('a');
    expect(keyOfA('1', 'win-x64')).not.toBe(keyOfA('2', 'win-x64'));
    expect(keyOfA('1', 'linux-x64')).toBe(keyOfA('2', 'linux-x64'));
  });
});

describe('native builds', () => {
  it('point FFmpeg at the build\'s own deps folder', () => {
    const flags = configureFlags(data, linuxCell(dvr, dvrLock), '/Users/me/ffmpeg-build-work/deps/osx-arm64');
    expect(flags).toContain('--extra-cflags=-I/Users/me/ffmpeg-build-work/deps/osx-arm64/include');
    expect(flags).toContain('--extra-ldflags=-L/Users/me/ffmpeg-build-work/deps/osx-arm64/lib');
    expect(configureFlags(data, linuxCell(dvr, dvrLock))).toContain('--extra-cflags=-I/opt/ffmpeg-build/deps/include');
  });

  it('carry the deps folder in the plan', () => {
    const plan = makeBuildPlan({ profile: dvr, data, locked: dvrLock, cell: linuxCell(dvr, dvrLock), variant: 'nonfree', imageId: 'x', cacheDir: tmpdir(), depsDir: '/Users/me/d' });
    expect(plan.ffmpeg.configure).toContain('--extra-cflags=-I/Users/me/d/include');
  });
});
