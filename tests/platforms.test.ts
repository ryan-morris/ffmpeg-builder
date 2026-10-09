import { describe, expect, it } from 'vitest';
import { describePlatforms, expandPlatformPattern, expandPlatforms, platformMatches, PLATFORMS } from '../src/platforms.ts';

describe('platforms', () => {
  it('knows the 15 platforms', () => {
    expect(PLATFORMS).toHaveLength(15);
    expect(PLATFORMS).toContain('linux-armhf');
    expect(expandPlatformPattern('all')).toEqual([...PLATFORMS]);
  });

  it('expands patterns in platform order', () => {
    expect(expandPlatformPattern('win-*')).toEqual(['win-x64', 'win-arm64']);
    expect(expandPlatformPattern('linux-*')).toEqual(['linux-x64', 'linux-arm64', 'linux-armhf', 'linux-musl-x64', 'linux-musl-arm64']);
    expect(expandPlatformPattern('ios-*')).toEqual(['ios-arm64', 'ios-sim-arm64']);
    expect(expandPlatformPattern('osx-arm64')).toEqual(['osx-arm64']);
    expect(expandPlatformPattern('freebsd-x64')).toEqual([]);
    expect(expandPlatformPattern('linux.x64')).toEqual([]);
  });

  it('expands and de-duplicates a list of patterns', () => {
    expect(expandPlatforms(['win-x64', 'win-*', 'linux-x64'])).toEqual(['linux-x64', 'win-x64', 'win-arm64']);
  });

  it('matches a platform against patterns', () => {
    expect(platformMatches('win-arm64', ['linux-*', 'win-*'])).toBe(true);
    expect(platformMatches('osx-x64', ['linux-*'])).toBe(false);
  });

  it('describes a set of platforms compactly', () => {
    expect(describePlatforms(PLATFORMS)).toBe('every platform');
    expect(describePlatforms(['linux-x64', 'linux-arm64'])).toBe('linux-x64, linux-arm64'); // not linux-*: that includes musl
    expect(describePlatforms(['win-x64', 'win-arm64'])).toBe('win-*');
    expect(
      describePlatforms(['osx-x64', 'osx-arm64', 'ios-arm64', 'ios-sim-arm64', 'android-arm64', 'android-x64', 'win-arm64']),
    ).toBe('win-arm64, osx-*, ios-*, android-*');
  });
});
