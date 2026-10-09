export const PLATFORMS: readonly string[] = [
  'linux-x64', 'linux-arm64', 'linux-armhf', 'linux-musl-x64', 'linux-musl-arm64',
  'win-x64', 'win-arm64',
  'osx-x64', 'osx-arm64',
  'ios-arm64', 'ios-sim-arm64',
  'maccatalyst-x64', 'maccatalyst-arm64',
  'android-arm64', 'android-x64',
];

function globToRegExp(pattern: string): RegExp {
  const body = pattern.split('*').map((part) => part.replace(/[\\^$.+?()[\]{}|]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

/** The platforms a pattern names (`all`, `win-*`, `linux-x64`), in PLATFORMS order; empty when none. */
export function expandPlatformPattern(pattern: string): string[] {
  if (pattern === 'all') return [...PLATFORMS];
  const re = globToRegExp(pattern);
  return PLATFORMS.filter((p) => re.test(p));
}

export function expandPlatforms(patterns: readonly string[]): string[] {
  const wanted = new Set(patterns.flatMap(expandPlatformPattern));
  return PLATFORMS.filter((p) => wanted.has(p));
}

export function platformMatches(platform: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => expandPlatformPattern(p).includes(platform));
}

const family = (platform: string) => platform.replace(/-[^-]+$/, '');

/**
 * The shortest readable form of a set of platforms: "every platform" (all 15), `win-*` where the
 * subset holds every platform that pattern means, else the platform names. A pattern is only used
 * when it means exactly what is listed, so a profile with linux-x64 and linux-arm64 never reads as
 * `linux-*` (which includes musl).
 */
export function describePlatforms(subset: readonly string[]): string {
  if (PLATFORMS.every((p) => subset.includes(p))) return 'every platform';
  const parts: string[] = [];
  const covered = new Set<string>();
  for (const platform of PLATFORMS) {
    if (!subset.includes(platform) || covered.has(platform)) continue;
    const members = expandPlatformPattern(`${family(platform)}-*`);
    if (members.length > 1 && members.every((p) => subset.includes(p) && !covered.has(p))) {
      parts.push(`${family(platform)}-*`);
      members.forEach((p) => covered.add(p));
    } else {
      parts.push(platform);
      covered.add(platform);
    }
  }
  return parts.join(', ');
}
