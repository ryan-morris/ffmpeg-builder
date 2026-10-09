// A fake GitHub REST API (releases and their assets) for repo o/r, and a tar writer, for the fetch and release tests.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { formatManifest, type Manifest, type ManifestTarget } from '../src/manifest.ts';

/** A minimal ustar writer, so tests can make the archives they need (including hostile ones). */
export function tarGz(input: { name: string; data?: string; type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'longname' | 'pax'; link?: string; mode?: number }[]): Buffer {
  const blocks: Buffer[] = [];
  // a name over 100 bytes goes first as a GNU long-name record, as GNU tar writes it
  const entries = input.flatMap((e) => (e.name.length > 100 ? [{ name: '././@LongLink', data: `${e.name}\0`, type: 'longname' as const }, { ...e, name: e.name.slice(0, 100) }] : [e]));
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    const sized = !e.type || e.type === 'file' || e.type === 'longname' || e.type === 'pax';
    h.write(`${(sized ? data.length : 0).toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write({ dir: '5', symlink: '2', hardlink: '1', longname: 'L', pax: 'x', file: '0' }[e.type ?? 'file'], 156);
    if (e.link) h.write(e.link, 157, 100);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h);
    if (sized) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface FakeRelease { tag: string; draft?: boolean; prerelease?: boolean; files: Record<string, Buffer> }
export interface FakeTarget extends Partial<Omit<ManifestTarget, 'assets'>> { name: string; platform: string; runtime?: Buffer; dev?: Buffer }

export interface FakeGitHub {
  releases: FakeRelease[];
  seenAuth: (string | undefined)[];
  /** Each request's path and whether it carried a token. */
  requests: { path: string; auth: boolean }[];
  base: string;
  env: Record<string, string>;
  /** Publishes a release whose manifest lists the targets (their archives are made up unless given). */
  publish(tag: string, targets: FakeTarget[], extra?: Partial<FakeRelease> & { engine?: string }): Manifest;
  close(): Promise<void>;
}

const defaultRuntime = () => tarGz([{ name: 'bin/ffmpeg', data: 'ffmpeg', mode: 0o755 }]);

/** Starts the fake and points FFMPEG_BUILD_GITHUB_API at it (close() undoes that). */
export async function fakeGitHub(): Promise<FakeGitHub> {
  const releases: FakeRelease[] = [];
  const seenAuth: (string | undefined)[] = [];
  const requests: { path: string; auth: boolean }[] = [];
  let base = '';
  const server: Server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    const url = new URL(req.url!, 'http://x');
    requests.push({ path: url.pathname, auth: req.headers.authorization !== undefined });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const asJson = (r: FakeRelease) => ({
      tag_name: r.tag, draft: r.draft ?? false, prerelease: r.prerelease ?? false,
      assets: Object.keys(r.files).map((name) => ({ name, url: `${base}/assets/${encodeURIComponent(r.tag)}/${encodeURIComponent(name)}` })),
    });
    let m = /^\/repos\/o\/r\/releases\/tags\/(.+)$/.exec(url.pathname);
    if (m) {
      const r = fake.releases.find((x) => x.tag === decodeURIComponent(m![1]!));
      return r ? send(200, asJson(r)) : send(404, { message: 'Not Found' });
    }
    if (url.pathname === '/repos/o/r/releases') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Number(url.searchParams.get('per_page') ?? 30);
      return send(200, fake.releases.slice((page - 1) * per, page * per).map(asJson));
    }
    m = /^\/assets\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m) {
      const file = fake.releases.find((x) => x.tag === decodeURIComponent(m![1]!))?.files[decodeURIComponent(m[2]!)];
      if (!file) return send(404, {});
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(file);
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.FFMPEG_BUILD_GITHUB_API = base;
  const fake: FakeGitHub = {
    releases,
    seenAuth,
    requests,
    base,
    env: { FFMPEG_BUILD_GITHUB_API: base },
    publish(tag, targets, extra = {}) {
      const t = /^(?:(.+)-)?(\d+\.\d+(?:\.\d+)?)\.(\d+)$/.exec(tag)!;
      const files: Record<string, Buffer> = {};
      const { engine, ...rest } = extra;
      const manifest: Manifest = {
        release: tag, ffmpeg: t[2]!, build: t[3]!, engine: engine ?? '0.2.0', ...(t[1] ? { group: t[1] } : {}),
        targets: targets.map(({ runtime, dev, ...x }) => {
          const runtimeData = runtime ?? defaultRuntime();
          const devData = dev ?? tarGz([{ name: 'include/libavutil/avutil.h', data: 'h' }]);
          const names = { runtime: `ffmpeg-${t[2]}-${x.name}.tar.gz`, dev: `ffmpeg-${t[2]}-${x.name}-dev.tar.gz` };
          files[names.runtime] = runtimeData;
          files[names.dev] = devData;
          return {
            license: 'lgplv3', redistributable: 'true', toolchain: 'abc', components: { dav1d: '1.5.4' }, patches: [], 'not-included': [], definition: 'def',
            ...x,
            assets: { runtime: { name: names.runtime, sha256: sha(runtimeData) }, dev: { name: names.dev, sha256: sha(devData) } },
          };
        }),
        sources: { name: `ffmpeg-${t[2]}-sources.tar.gz`, sha256: '0'.repeat(64) },
      };
      files['manifest.yml'] = Buffer.from(formatManifest(manifest));
      fake.releases.push({ tag, files, ...rest });
      return manifest;
    },
    async close() {
      delete process.env.FFMPEG_BUILD_GITHUB_API;
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return fake;
}
