// The nightly FFmpeg support check: node scripts/ffmpeg-support.ts [--write] [--report <file>]
// Reads FFmpeg's release tags and the configure script of each handled major's newest release (and the one before it),
// corrects ffmpeg/<major>.yml's releases with --write, and writes a report of what a person must decide.
import { writeFileSync } from 'node:fs';
import { ffmpegVersionSource, loadEngineData } from '../src/engine-data.ts';
import { formatSupport, newMajors, parseConfigure, supportReport, writeReleases, type LicenseClass } from '../src/ffmpeg-support.ts';
import { packageRoot } from '../src/paths.ts';
import { findVersions } from '../src/upstream.ts';
import { compareVersions } from '../src/versions.ts';

const args = process.argv.slice(2);
const write = args.includes('--write');
const reportAt = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;

const data = loadEngineData(packageRoot);
const found = await findVersions(ffmpegVersionSource(data), 'FFmpeg');
const upstream = ('versions' in found ? found.versions : []).filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v));

async function configureOf(version: string): Promise<Map<string, LicenseClass>> {
  const url = `https://raw.githubusercontent.com/FFmpeg/FFmpeg/n${version}/configure`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FFmpeg ${version}'s configure: ${url} answered ${res.status}`);
  return parseConfigure(await res.text());
}

const reports = [];
for (const major of [...data.ffmpeg.keys()].sort((a, b) => Number(a) - Number(b))) {
  const releases = upstream.filter((v) => v.split('.')[0] === major).sort(compareVersions);
  if (!releases.length) continue;
  const newest = releases.at(-1)!;
  const previous = releases.at(-2);
  const report = supportReport(data, major, upstream, await configureOf(newest), previous ? await configureOf(previous) : undefined);
  reports.push(report);
  if (write && report.releases.now.join() !== report.releases.was.join()) writeReleases(packageRoot, major, report.releases.now);
}
const text = formatSupport(reports, newMajors(data, upstream));
if (reportAt) writeFileSync(reportAt, text);
process.stdout.write(text);
