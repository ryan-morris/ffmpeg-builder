// Shared pieces of version choice: the upstream lookups' shapes, the rows an update reports, and which pin decides a
// library in one build.
import { recipeForPin, type EngineData } from './engine-data.ts';
import type { LockedProfile } from './lockfile.ts';
import type { Profile } from './profile.ts';
import { conditionMatches, type Cell } from './resolve.ts';
import type { Condition } from './schema/profile.ts';
import type { Found } from './upstream.ts';

export type Mode = 'update' | 'keep';
export interface Upstreams { ffmpeg?: string[]; libraries: Map<string, Found> }
export interface Skipped { version: string; reason: string; note?: string }
export interface Row { what: string; from?: string; to: string; skipped?: Skipped; newMinor?: { from: string; to: string; adds: string[]; missing: string[] } }

const sameCond = (a?: Condition, b?: Condition) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which `pin` entry decides `recipe`'s version in this build: the first that names it and matches; -1 for none. */
export function pinWinner(profile: Profile, data: EngineData, cell: Cell, recipe: string): number {
  return profile.pin.findIndex((p) => {
    const target = recipeForPin(data, p.name);
    return 'recipe' in target && target.recipe === recipe && conditionMatches(p.cond, cell);
  });
}

/** The locked version of `recipe` in one build: its conditional pin's entry, or the shared one. */
export function versionInCell(profile: Profile, data: EngineData, locked: LockedProfile, cell: Cell, recipe: string): string | undefined {
  const index = pinWinner(profile, data, cell, recipe);
  const cond = index >= 0 ? profile.pin[index]!.cond : undefined;
  return cond ? locked.pinned.find((p) => p.name === recipe && sameCond(p.cond, cond))?.version : locked.libraries[recipe];
}
