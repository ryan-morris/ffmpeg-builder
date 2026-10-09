import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireBuildLock, hostEnv, hostToolchainIdentity, nativeEnv, nativePaths, nativeWorkRoot, setupFacts } from '../src/build/native.ts';

const hasBash = (() => {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function engine(facts: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-native-'));
  mkdirSync(join(root, 'platforms', 'setup'), { recursive: true });
  writeFileSync(join(root, 'platforms', 'driver.sh'), 'echo build\n');
  writeFileSync(join(root, 'platforms', 'setup', 'apple.sh'), `toolchain_facts() { echo "${facts}"; }\n`);
  return root;
}

describe('native builds', () => {
  it('keep each platform in its own folders under the work root', () => {
    const p = nativePaths('/Users/me/ffmpeg-build-work', 'osx-arm64');
    expect(p).toEqual({ depsDir: '/Users/me/ffmpeg-build-work/deps/osx-arm64', work: '/Users/me/ffmpeg-build-work/work/osx-arm64' });
  });

  it('give the driver every path through the environment', () => {
    const env = nativeEnv({ plan: '/t/plan.json', recipes: '/e/recipes', engine: '/e/platforms', cache: '/c', out: '/o', depsDir: '/w/deps/osx-arm64', work: '/w/work/osx-arm64' });
    expect(env).toMatchObject({
      FFB_PLAN: '/t/plan.json', FFB_RECIPES: '/e/recipes', ENGINE: '/e/platforms', FFB_CACHE: '/c', FFB_OUT: '/o',
      DEPS_DIR: '/w/deps/osx-arm64', FFB_WORK: '/w/work/osx-arm64',
    });
  });

  it.skipIf(!hasBash)('read the host toolchain from the setup script', () => {
    expect(setupFacts(engine('Xcode 26.3 / macosx 26.2'), 'apple', 'osx-arm64', '/w/deps').trim()).toBe('Xcode 26.3 / macosx 26.2');
  });

  it.skipIf(!hasBash)('key the library cache on the host toolchain and the deps folder', () => {
    // the setup file stays the same; only what it reports about the host changes
    const a = engine('x');
    const facts = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-facts-')), 'facts');
    writeFileSync(join(a, 'platforms', 'setup', 'apple.sh'), `toolchain_facts() { cat "${facts.replaceAll('\\', '/')}"; }\n`);
    writeFileSync(facts, 'Xcode 26.3\n');
    const id = hostToolchainIdentity(a, 'apple', 'osx-arm64', '/w/deps/osx-arm64');
    expect(hostToolchainIdentity(a, 'apple', 'osx-arm64', '/w/deps/osx-arm64')).toBe(id);
    expect(hostToolchainIdentity(a, 'apple', 'osx-arm64', '/w2/deps/osx-arm64')).not.toBe(id);
    writeFileSync(facts, 'Xcode 26.4\n');
    expect(hostToolchainIdentity(a, 'apple', 'osx-arm64', '/w/deps/osx-arm64')).not.toBe(id);
  });

  it.skipIf(!hasBash)('say when a setup cannot describe its toolchain', () => {
    const root = engine('x');
    writeFileSync(join(root, 'platforms', 'setup', 'apple.sh'), 'true\n');
    expect(() => setupFacts(root, 'apple', 'osx-arm64', '/w/deps')).toThrow(/toolchain_facts/);
  });

  it.skipIf(!hasBash)('source the setup as a build does: with the platform and deps folder set, under set -u', () => {
    const root = engine('x');
    writeFileSync(join(root, 'platforms', 'setup', 'apple.sh'), 'case "${BUILD_RID}" in osx-*) X=1 ;; esac\ntoolchain_facts() { echo "${BUILD_RID} ${DEPS_DIR}"; }\n');
    expect(setupFacts(root, 'apple', 'osx-arm64', '/w/deps/osx-arm64').trim()).toBe('osx-arm64 /w/deps/osx-arm64');
  });
});

describe('native builds on a user machine', () => {
  it('pass the build only the host environment it needs, never compiler or search-path variables', () => {
    const env = hostEnv({
      HOME: '/Users/me', PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp/x', HOMEBREW_PREFIX: '/opt/homebrew',
      CC: 'gcc-14', CXX: 'g++-14', CPATH: '/opt/homebrew/include', LIBRARY_PATH: '/opt/homebrew/lib', CMAKE_PREFIX_PATH: '/opt/homebrew',
      MAKEFLAGS: '-j1', SDKROOT: '/x', CFLAGS: '-O0',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'HOMEBREW_PREFIX', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
  });

  it('put Homebrew first on the PATH, so the driver finds jq and bash 4+ before the setup runs', () => {
    expect(hostEnv({ PATH: '/usr/bin:/bin', HOMEBREW_PREFIX: '/opt/homebrew' }).PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(hostEnv({ PATH: '/usr/bin' }).PATH).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('use an absolute work folder without spaces', () => {
    const before = process.env.FFMPEG_BUILD_WORK;
    try {
      process.env.FFMPEG_BUILD_WORK = '';
      expect(nativeWorkRoot()).toMatch(/ffmpeg-build-work$/);
      process.env.FFMPEG_BUILD_WORK = 'relative/work';
      expect(nativeWorkRoot()).toBe(join(process.cwd(), 'relative', 'work'));
      process.env.FFMPEG_BUILD_WORK = '/Users/me/My Builds';
      expect(() => nativeWorkRoot()).toThrow(/space/);
    } finally {
      if (before === undefined) delete process.env.FFMPEG_BUILD_WORK;
      else process.env.FFMPEG_BUILD_WORK = before;
    }
  });

  it('build one platform at a time on a machine, and take over a lock whose build is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-lock-'));
    const release = acquireBuildLock(root, 'osx-arm64');
    expect(() => acquireBuildLock(root, 'osx-arm64')).toThrow(/already building osx-arm64/);
    const other = acquireBuildLock(root, 'ios-arm64'); // another platform is fine
    other();
    release();
    acquireBuildLock(root, 'osx-arm64')(); // free again
    writeFileSync(join(root, 'osx-arm64.lock'), '999999999\n'); // a build that died without releasing
    acquireBuildLock(root, 'osx-arm64')();
  });
});
