import { alwaysBuilt, knownMajors, optionRecipe, optionsOf, type EngineData } from '../engine-data.ts';
import { describePlatforms, expandPlatforms, platformMatches } from '../platforms.ts';
import { optionLicenses } from '../resolve.ts';
import { LICENSES, type License } from '../schema/profile.ts';

/** What a profile can list for one FFmpeg major: the facts `check` works from, without a profile. */
export interface OptionFacts {
  name: string;
  libraries?: { name: string; spdx: string; platforms: string[] }[]; // its library on each platform, when not part of FFmpeg itself
  licenses: License[]; // the profile licenses that allow it (FFmpeg's class, and the library with what it needs)
  platforms: string[]; // where FFmpeg and the library both build
  since?: string; // the FFmpeg release that added it
}

export function optionFacts(data: EngineData, major: string): OptionFacts[] {
  return [...optionsOf(data, major).values()]
    .filter((o) => !alwaysBuilt(o))
    .map((o): OptionFacts => {
      const names = [...new Set(o.libraries.map((d) => d.name))];
      // where FFmpeg offers it and, for a library-backed option, that platform's library builds
      const platforms = expandPlatforms(o.platforms ?? ['all']).filter((p) => {
        if (!o.libraries.length) return true;
        const lib = optionRecipe(o, p);
        return lib !== undefined && platformMatches(p, data.recipes.get(lib)!.platforms);
      });
      return {
        name: o.name,
        ...(names.length
          ? { libraries: names.map((n) => ({ name: n, spdx: data.recipes.get(n)!.license, platforms: platforms.filter((p) => optionRecipe(o, p) === n) })) }
          : {}),
        licenses: optionLicenses(data, major, o.name),
        platforms,
        ...(o.since ? { since: o.since } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function runOptions(ffmpeg: string | undefined, data: EngineData, json: boolean): { output: string; exitCode: number } {
  // a series as profiles write it: 9, 9.0 or latest
  const major = !ffmpeg || ffmpeg === 'latest' ? knownMajors(data).at(-1)! : ffmpeg.split('.')[0]!;
  if (!data.ffmpeg.has(major)) return { output: `ffmpeg-build has no data for FFmpeg ${major} (it knows ${knownMajors(data).join(', ')})`, exitCode: 2 };
  const facts = optionFacts(data, major);
  if (json) return { output: JSON.stringify(facts, null, 2), exitCode: 0 };
  const rows = facts.map((f) => [
    f.name,
    f.libraries?.map((l) => l.name).join(', ') ?? '(FFmpeg)',
    f.licenses.length === LICENSES.length ? 'every license' : f.licenses.join(', ') || 'none',
    `${f.platforms.length ? describePlatforms(f.platforms) : 'nowhere yet'}${f.since ? ` (since ${f.since})` : ''}`,
  ]);
  const head = ['name', 'library', 'licenses', 'platforms'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)) + 3);
  const line = (r: string[]) => `  ${r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i]!) : c)).join('')}`;
  return {
    output: [`FFmpeg ${major}: what a target can list (\`with:\`), by FFmpeg's own names`, line(head), ...rows.map(line)].join('\n'),
    exitCode: 0,
  };
}
