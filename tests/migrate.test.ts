import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { migrate } from '../src/migrate.ts';
import { packageRoot } from '../src/paths.ts';
import { declined, loadProfile, parseProfileText, type Profile } from '../src/profile.ts';
import { planProfile, type CellPlan } from '../src/resolve.ts';
import { artifactName, parseFolderText, targetProfile } from '../src/targets.ts';
import { fixtureData } from './helpers.ts';

const data = loadEngineData(packageRoot);
const all = (() => {
  const r = loadProfile(join(packageRoot, 'tests', 'fixtures', 'all-v1.yml'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.profile;
})();
const profile = (text: string): Profile => {
  const r = parseProfileText(text, 'p.yml');
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.profile;
};

const summary = (c: CellPlan, d = data) => ({
  options: [...c.options].sort(),
  recipes: [...c.recipes].sort(),
  leftOut: c.leftOut,
  flags: [...configureFlags(d, c)].sort(),
});

describe('migrating the shipped profile', () => {
  const result = migrate({ profiles: [all], data, files: ['all.yml'] });
  const parsed = parseFolderText(result.text, packageRoot);

  it('gives a valid folder file', () => {
    expect(result.errors).toEqual([]);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  });

  it('gives every old build as a target that builds exactly the same', () => {
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const folder = parsed.folder;
    const old = planProfile(all, data).cells;
    const newest = [...all.ffmpeg].sort().at(-1);
    expect(folder.targets).toHaveLength(old.length);
    for (const c of old) {
      const name = `${c.cell.platform}-${c.cell.license}${c.cell.series === newest ? '' : `-ffmpeg${c.cell.series}`}`;
      const t = folder.targets.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      // the artifact keeps today's name: ffmpeg-<version>-<platform>-<license>
      expect(artifactName(t!, c.cell.version), name).toBe(`ffmpeg-${c.cell.version}-${c.cell.platform}-${c.cell.license}`);
      expect([t!.patches, t!.tests], name).toEqual([all.patches, all.tests]);
      const [cell] = planProfile(targetProfile(folder, t!), data, { [c.cell.series]: c.cell.version }).cells;
      expect(summary(cell!), name).toEqual(summary(c));
      // what the old build turned down (outright, or by a matching without:) the target turns down
      expect([...t!.without].sort(), name).toEqual([...new Set([...declined(all), ...c.removed])].sort());
    }
  });

  it('factors what every build shares into common, and keeps the rest per family and license', () => {
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    expect(parsed.folder.bases.common!.with).toContain('dav1d');
    const linux = parsed.folder.targets.find((t) => t.name === 'linux-x64-lgplv3')!;
    expect(linux.base[0]).toBe('common');
  });

  it('is deterministic', () => {
    expect(migrate({ profiles: [all], data, files: ['all.yml'] }).text).toBe(result.text);
  });
});

describe('migrating folders with locks and pins', () => {
  const fixture = fixtureData();

  it('turns pins into folder pins and target pins', () => {
    const p = profile('name: p\nffmpeg: 9\nplatforms: [linux-x64, win-x64]\nlicense: gplv3\nwith: [dav1d, opus]\npin:\n  - opus: "1.5"\n  - dav1d: { version: "1.4", platforms: [win-x64] }\n');
    const r = migrate({ profiles: [p], data: fixture, files: ['p.yml'] });
    const parsed = parseFolderText(r.text, '.');
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    expect(parsed.folder.pin).toEqual({ opus: '1.5' });
    expect(parsed.folder.targets.find((t) => t.name === 'win-x64-gplv3')!.pin).toEqual({ dav1d: '1.4' });
    expect(parsed.folder.targets.find((t) => t.name === 'linux-x64-gplv3')!.pin).toEqual({});
  });

  it('refuses pins one lock could not meet: a library pinned differently in different builds', () => {
    const p = profile('name: p\nffmpeg: 9\nplatforms: [linux-x64, linux-arm64]\nlicense: gplv3\nwith: [dav1d]\npin:\n  - dav1d: { version: "1.4.3", platforms: [linux-arm64] }\n  - dav1d: "~1.5.4"\n');
    expect(migrate({ profiles: [p], data: fixture, files: ['p.yml'] }).errors).toEqual([
      'can\'t migrate: dav1d is pinned to "~1.5.4" for every other build and "1.4.3" for linux-arm64-gplv3; one lock holds one version per library, so give them one pin, then migrate again',
    ]);
    // the same pin everywhere is one pin
    const same = profile('name: p\nffmpeg: 9\nplatforms: [linux-x64, linux-arm64]\nlicense: gplv3\nwith: [dav1d]\npin:\n  - dav1d: { version: "~1.5.4", platforms: [linux-arm64] }\n  - dav1d: "~1.5.4"\n');
    expect(migrate({ profiles: [same], data: fixture, files: ['p.yml'] }).errors).toEqual([]);
  });

  it('names targets as today\'s assets: the profile when a folder has several, the license when a profile has several', () => {
    const a = profile('name: dvr\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: nonfree\nwith: [dav1d]\n');
    const b = profile('name: oss\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: gplv3\nwith: [opus]\n');
    const parsed = parseFolderText(migrate({ profiles: [a, b], data: fixture, files: ['dvr.yml', 'oss.yml'] }).text, '.');
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    expect(parsed.folder.targets.map((t) => t.name).sort()).toEqual(['linux-x64-dvr', 'linux-x64-oss']);
    // and each profile stays its own release, tagged dvr-<ffmpeg>.<build> as before
    expect(parsed.folder.targets.map((t) => t.releaseGroup).sort()).toEqual(['dvr', 'oss']);
  });

  it("consolidates the locks, and refuses when the profiles' versions disagree", () => {
    const a = profile('name: a\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: gplv3\nwith: [dav1d]\n');
    const b = profile('name: b\nffmpeg: 9\nplatforms: [win-x64]\nlicense: gplv3\nwith: [dav1d, opus]\n');
    const agree = { engine: '0.2.0', profiles: {
      a: { ffmpeg: { '9': '9.0.2' }, libraries: { dav1d: '1.5.4' }, pinned: [] },
      b: { ffmpeg: { '9': '9.0.2' }, libraries: { dav1d: '1.5.4', opus: '1.6.1' }, pinned: [] },
    } };
    expect(migrate({ profiles: [a, b], data: fixture, files: [], lock: agree }).lock).toEqual({ ffmpeg: { '9': '9.0.2' }, libraries: { dav1d: '1.5.4', opus: '1.6.1' } });
    const disagree = { ...agree, profiles: { ...agree.profiles, b: { ...agree.profiles.b, libraries: { dav1d: '1.4.1', opus: '1.6.1' } } } };
    expect(migrate({ profiles: [a, b], data: fixture, files: [], lock: disagree }).errors).toEqual([
      "can't migrate: dav1d is locked at 1.5.4 for a and 1.4.1 for b; make them agree (pin or update), then migrate again",
    ]);
  });
});
