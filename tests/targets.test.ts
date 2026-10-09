import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderJsonSchema } from '../src/schema/json-schema.ts';
import { artifactName, loadFolder, targetProfile, type Folder } from '../src/targets.ts';
import { declined } from '../src/profile.ts';

function folder(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-targets-'));
  writeFileSync(join(dir, 'ffmpeg-build.yml'), text);
  return loadFolder(dir);
}
function ok(text: string): Folder {
  const r = folder(text);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.folder;
}
function errors(text: string): string[] {
  const r = folder(text);
  if (r.ok) throw new Error('expected problems');
  return r.errors;
}

const layered = [
  'bases:',
  '  common: { with: [dav1d, opus, kvazaar] }',
  '  gpl:    { with: [x265], without: [kvazaar, opus] }',
  'pin:',
  '  dav1d: "~1.5"',
  'targets:',
  '  linux-x64-gplv3:',
  '    platform: linux-x64',
  '    license: gplv3',
  '    ffmpeg: 9',
  '    base: [common, gpl]',
  '    with: [opus]',
  '    pin: { x265: "4.1" }',
  '',
].join('\n');

describe('the folder file', () => {
  it('merges bases left to right, then the target: a later layer overrides an earlier one', () => {
    const t = ok(layered).targets[0]!;
    expect(t.with).toEqual(['dav1d', 'opus', 'x265']); // opus: removed by gpl, re-added by the target
    expect(t.without).toEqual(['kvazaar']); // declined in the end
    expect(t.origin.get('opus')).toBe('linux-x64-gplv3');
    expect(t.origin.get('x265')).toBe('gpl');
    expect(t.origin.get('kvazaar')).toBe('gpl');
    expect(t.origin.get('dav1d')).toBe('common');
  });

  it('turns a target into one build: one platform, one license, one series, no conditions, no pins', () => {
    const f = ok(layered);
    const p = targetProfile(f, f.targets[0]!);
    expect(p).toMatchObject({ name: 'linux-x64-gplv3', platforms: ['linux-x64'], license: ['gplv3'], ffmpeg: ['9'], pin: [] });
    expect(p.with).toEqual([{ name: 'dav1d' }, { name: 'opus' }, { name: 'x265' }]);
    expect(p.without).toEqual([{ name: 'kvazaar' }]);
    expect([...declined(p)]).toEqual(['kvazaar']);
    expect(p.dir).toBe(f.dir);
  });

  it('keeps folder and target pins as constraints, apart from the build', () => {
    const f = ok(layered);
    expect(f.pin).toEqual({ dav1d: '~1.5' });
    expect(f.targets[0]!.pin).toEqual({ x265: '4.1' });
  });

  it('says what is wrong, with the fix', () => {
    expect(errors('bases:\n  b: { with: [a], without: [a] }\ntargets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: 9, base: [b] }\n')).toEqual([
      'bases.b: a is under both with: and without:; keep one',
    ]);
    expect(errors('targets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: 9, base: [nope] }\n')).toEqual([
      'targets.t: base nope is not defined under bases:',
    ]);
    expect(errors('bases:\n  b: { platform: linux-x64, with: [a] }\ntargets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: 9 }\n')).toEqual([
      'bases.b: platform belongs on a target, not a base (a base only holds with, without and pin)',
    ]);
    expect(errors('targets:\n  t: { platform: linux-x86, license: gplv3, ffmpeg: 9 }\n')).toEqual([
      'targets.t: platform linux-x86 is not a platform ffmpeg-build knows',
    ]);
    expect(errors('targets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: nine }\n')).toEqual([
      'targets.t: ffmpeg: nine is not an FFmpeg series (write 9, 9.0 or latest)',
    ]);
    expect(errors('targets: {}\n')).toEqual(['targets: none defined; add one (a name with platform, license and ffmpeg)']);
    expect(errors('targets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [a], without: [a] }\n')).toEqual([
      'targets.t: a is under both with: and without:; keep one',
    ]);
  });

  it('says when there is no folder file', () => {
    const r = loadFolder(mkdtempSync(join(tmpdir(), 'ffmpeg-build-empty-')));
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.errors).toEqual(['no ffmpeg-build.yml here: start one with `ffmpeg-build init`']);
  });
});

describe('the editor schema for ffmpeg-build.yml', () => {
  it('is up to date (run `npm run schema` after changing the folder schema)', () => {
    expect(readFileSync(new URL('../schema/ffmpeg-build.schema.json', import.meta.url), 'utf8')).toBe(folderJsonSchema());
  });

  it('describes the top-level keys only, with no hosted $id', () => {
    const schema = JSON.parse(folderJsonSchema()) as { properties: Record<string, unknown>; additionalProperties: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(['allow-removal', 'bases', 'notify', 'pin', 'private-release', 'targets']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty('$id');
  });

  it('lets editors write notify: { new-ffmpeg: true } as a boolean', () => {
    const text = folderJsonSchema();
    expect(JSON.stringify(JSON.parse(text).properties.notify)).toContain('"type":["string","boolean"],"enum":["true","false",true,false]');
  });

  it('lets editors accept unquoted numbers like ffmpeg: 9 and pin versions like 13.0', () => {
    const text = folderJsonSchema();
    expect(JSON.stringify(JSON.parse(text).properties.pin)).toContain('"type":["string","number"]');
    expect(text).toContain('"type": [\n');
  });
});

describe('artifact names', () => {
  it("are the target's name, without a -ffmpeg<series> suffix the version already says", () => {
    const t = (name: string, ffmpeg: string) => ({ name, ffmpeg }) as Parameters<typeof artifactName>[0];
    expect(artifactName(t('linux-x64-lgplv3', '9'), '9.0.2')).toBe('ffmpeg-9.0.2-linux-x64-lgplv3');
    expect(artifactName(t('linux-x64-lgplv3-ffmpeg8', '8'), '8.1.3')).toBe('ffmpeg-8.1.3-linux-x64-lgplv3');
    expect(artifactName(t('dvr-ffmpeg8', '9'), '9.0.2')).toBe('ffmpeg-9.0.2-dvr-ffmpeg8'); // not its own series: kept
  });
});
