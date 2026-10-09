// The nightly FFmpeg support check: node scripts/ffmpeg-support.ts [--write] [--report <file>]
// Reads FFmpeg's release tags and the configure script of each handled major's newest release (and the one before it),
// corrects ffmpeg/<major>.yml's releases with --write, and writes a report of what a person must decide.
// Exit 2 when upstream can't be read or the data can't be corrected.
import { writeFileSync } from 'node:fs';
import { ffmpegVersionSource, loadEngineData } from '../src/engine-data.ts';
import { parseConfigure, SupportError, supportCheck, type LicenseClass } from '../src/ffmpeg-support.ts';
import { packageRoot } from '../src/paths.ts';
import { findVersions, GitMissingError, UpstreamError } from '../src/upstream.ts';

const args = process.argv.slice(2);
const write = args.includes('--write');
const reportAt = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;

async function configureOf(version: string): Promise<Map<string, LicenseClass>> {
  const url = `https://raw.githubusercontent.com/FFmpeg/FFmpeg/n${version}/configure`;
  const res = await fetch(url);
  if (!res.ok) throw new SupportError(`FFmpeg ${version}'s configure: ${url} answered ${res.status}`);
  return parseConfigure(await res.text());
}

try {
  const data = loadEngineData(packageRoot);
  const found = await findVersions(ffmpegVersionSource(data), 'FFmpeg');
  const upstream = ('versions' in found ? found.versions : []).filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v));
  const text = await supportCheck({ data, dataRoot: packageRoot, upstream, configureOf, write });
  if (reportAt) writeFileSync(reportAt, text);
  process.stdout.write(text);
} catch (e) {
  if (!(e instanceof SupportError || e instanceof UpstreamError || e instanceof GitMissingError)) throw e;
  process.stderr.write(`ffmpeg-support: ${e.message}\n`);
  process.exit(2);
}
