// `ffmpeg-build migrate`: the folder's old matrix profiles and their v1 lock become ffmpeg-build.yml and one v2 lock.
// Nothing is written unless all of it can be; the old files stay beside the new ones as *.old.
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { checkProfile } from '../check.ts';
import type { EngineData } from '../engine-data.ts';
import { formatReport } from '../format.ts';
import { formatFolderLock, LOCK_FILE, readLock } from '../lockfile.ts';
import { migrate } from '../migrate.ts';
import { packageVersion } from '../paths.ts';
import { loadProfile, type Profile } from '../profile.ts';
import { FOLDER_FILE } from '../targets.ts';
import { FolderError, hasFolder, oldFormatFolderFile, oldProfiles, openFolder, runFolderCheck } from './folder.ts';
import { WriteError } from './versions.ts';

export function runMigrate(data: EngineData): { output: string; exitCode: number } {
  if (hasFolder() && !oldFormatFolderFile()) throw new FolderError(`${FOLDER_FILE} is already here: this folder uses targets, there is nothing to migrate`);
  const files = oldProfiles();
  if (!files.length) throw new FolderError('no old profiles here to migrate (an old profile is a *.yml with name, ffmpeg, platforms or license)');
  const profiles: Profile[] = [];
  const problems: string[] = [];
  // a target lists what its build gets, so whatever an old profile lists but can't build must be settled first
  for (const f of files) {
    const r = loadProfile(f);
    const report = checkProfile(r, data);
    if (report.problems) problems.push(formatReport(report));
    else if (r.ok) profiles.push(r.profile);
  }
  if (problems.length) throw new FolderError(["can't migrate until check passes on the old profiles; fix these first:", '', ...problems].join('\n'));
  const hasLock = existsSync(LOCK_FILE);
  const kept = [...files, ...(hasLock ? [LOCK_FILE] : [])].map((f) => `${f}.old`);
  const clash = [...kept, `${FOLDER_FILE}.migrating`, `${LOCK_FILE}.migrating`].filter((f) => existsSync(f));
  if (clash.length) throw new FolderError(`can't migrate: ${clash.join(', ')} already exist; move them away, then migrate again`);

  const result = migrate({ profiles, data, files, ...(hasLock ? { lock: readLock(LOCK_FILE)! } : {}) });
  if (result.errors.length) throw new FolderError(result.errors.join('\n'));

  const writes = [{ path: FOLDER_FILE, text: result.text }, ...(hasLock ? [{ path: LOCK_FILE, text: formatFolderLock({ engine: packageVersion(), ...result.lock! }) }] : [])];
  swapIn(writes, [...files, ...(hasLock ? [LOCK_FILE] : [])]);
  const folder = openFolder();
  const report = runFolderCheck(folder, data);
  const out = [
    `wrote ${FOLDER_FILE}: ${folder.targets.map((t) => t.name).join(', ')}`,
    ...(hasLock ? [`wrote ${LOCK_FILE} (one version per library, as the old lock had them)`] : []),
    `kept the old files as ${kept.join(', ')}`,
    '',
    report.output,
  ];
  return { output: out.join('\n'), exitCode: report.exitCode };
}

/**
 * Writes the new files beside the old ones first, then moves each old file to `<name>.old` and each new one into
 * place. If any step fails, everything is put back as it was: no half-migrated folder.
 */
export function swapIn(writes: { path: string; text: string }[], old: string[]): void {
  const tmp = (path: string) => `${path}.migrating`;
  const moved: string[] = [];
  const placed: string[] = [];
  try {
    for (const w of writes) writeFileSync(tmp(w.path), w.text);
    for (const f of old) {
      renameSync(f, `${f}.old`);
      moved.push(f);
    }
    for (const w of writes) {
      renameSync(tmp(w.path), w.path);
      placed.push(w.path);
    }
  } catch (e) {
    for (const p of placed) rmSync(p, { force: true });
    for (const f of moved.reverse()) renameSync(`${f}.old`, f);
    for (const w of writes) rmSync(tmp(w.path), { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' ? 'a file is in use or read-only' : (e as Error).message;
    throw new WriteError(`Couldn't migrate: ${why}. Nothing was changed.`);
  }
}
