// Builds only the given libraries (and what they need) in the linux toolchain image: for porting and fixing
// recipes without a profile, a lock or an FFmpeg build. Not part of the published CLI.
//
//   node scripts/try-recipes.ts [--platform linux-musl-x64] dav1d@1.5.4 libva@2.24.1 libdrm@2.4.134
//
// Every library in the build order needs a version. The cache is FFMPEG_BUILD_CACHE (default: a temp folder per
// run, so nothing is reused unless you point it somewhere), and the log is printed as it builds.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dockerCommand, dockerRunArgs, ensureImage, runStreaming } from '../src/build/docker.ts';
import { cacheKeys, sourceOf, toolchainIdentity } from '../src/build/plan.ts';
import { buildOrder, loadEngineData } from '../src/engine-data.ts';
import { dataRoot, packageRoot } from '../src/paths.ts';

const data = loadEngineData(dataRoot());
const args = process.argv.slice(2);
const at = args.indexOf('--platform');
const platform = at >= 0 ? args.splice(at, 2)[1]! : 'linux-x64';
const target = data.platforms.get(platform);
if (!target) {
  console.log(`no such platform in platforms.yml: ${platform}`);
  process.exit(2);
}
const versions = new Map(args.map((arg) => arg.split('@') as [string, string]));
if (!versions.size) {
  console.log('usage: node scripts/try-recipes.ts <recipe>@<version> [<recipe>@<version> ...]');
  process.exit(2);
}
const unknown = [...versions.keys()].filter((r) => !data.recipes.has(r));
if (unknown.length) {
  console.log(`no such recipe: ${unknown.join(', ')}`);
  process.exit(2);
}
const order = buildOrder(data, [...versions.keys()], platform);
const missing = order.filter((r) => !versions.has(r));
if (missing.length) {
  console.log(`also give a version for what these need: ${missing.join(', ')}`);
  process.exit(2);
}

const image = await ensureImage(packageRoot, target.image);
const keys = cacheKeys(data, order, (r) => versions.get(r)!, platform, toolchainIdentity(packageRoot, image.id, target.setup));
const cache = resolve(process.env.FFMPEG_BUILD_CACHE ?? mkdtempSync(join(tmpdir(), 'ffmpeg-build-try-cache-')));
mkdirSync(join(cache, 'libs'), { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'ffmpeg-build-try-'));
const plan = {
  platform,
  setup: target.setup,
  name: 'try-recipes',
  libraries: order.map((name) => ({ name, version: versions.get(name)!, key: keys.get(name)!, cached: false, source: sourceOf(data, name, versions.get(name)!), licenseFiles: data.recipes.get(name)!['license-files'] })),
  runtime: [],
};
writeFileSync(join(work, 'plan.json'), JSON.stringify(plan, null, 2));
const { code, lastError } = await runStreaming(
  dockerCommand(),
  dockerRunArgs({ tag: image.tag, recipes: join(data.root, 'recipes'), engine: join(packageRoot, 'platforms'), cache, out: work, plan: join(work, 'plan.json') }),
  join(work, 'try.log'),
);
console.log(code === 0 ? `\nbuilt: ${order.join(', ')}` : `\nFAILED: ${lastError ?? `exit ${code}`} (log: ${join(work, 'try.log')})`);
process.exit(code === 0 ? 0 : 1);
