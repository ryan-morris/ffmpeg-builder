import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureFlags, verifyNames } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { checkProfile } from '../src/check.ts';
import { formatReport } from '../src/format.ts';
import { parseProfileText } from '../src/profile.ts';
import { parseFolderText, targetProfile } from '../src/targets.ts';
import { planProfile } from '../src/resolve.ts';
import { packageRoot } from '../src/paths.ts';
import { runCli } from './helpers.ts';

const data = loadEngineData(packageRoot);
const shippedPath = join(packageRoot, 'profiles', 'devenvy.yml');
const folder = (() => {
  const r = parseFolderText(readFileSync(shippedPath, 'utf8'), join(packageRoot, 'profiles'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.folder;
})();
// each target is one build: its own plan, at the versions devenvy 9.0.2.3 shipped
const cells = folder.targets.map((t) => {
  const plan = planProfile(targetProfile(folder, t), data, { '8': '8.1.3', '9': '9.0.2' });
  if (plan.errors.length) throw new Error(`${t.name}: ${plan.errors.join('\n')}`);
  return plan.cells[0]!;
});
const linux = (license: string, series = '9') => cells.find((c) => c.cell.platform === 'linux-x64' && c.cell.license === license && c.cell.series === series)!;

// `ffmpeg -buildconf` of the published ffmpeg-9.0.2-linux-x64-lgplv3.tar.gz (devenvy/ffmpeg release 9.0.2.3),
// minus the base and license flags: the option flags today's build passes.
const PUBLISHED_LGPLV3_LINUX_X64 = [
  'cuda', 'cuvid', 'nvenc', 'nvdec', 'ffnvcodec', 'vaapi', 'libdrm', 'libvpl', 'v4l2-m2m', 'libvpx', 'libopenh264',
  'libkvazaar', 'libdav1d', 'zlib', 'lcms2', 'libxml2', 'libfreetype', 'libfribidi', 'libharfbuzz', 'libfontconfig',
  'libass', 'libvorbis', 'libopus', 'libmp3lame', 'libspeex', 'libgsm', 'libopencore-amrnb', 'libopencore-amrwb',
  'libvo-amrwbenc', 'libsoxr', 'libaom', 'libsvtav1', 'libwebp', 'libopenjpeg', 'libzimg', 'libvmaf', 'openssl',
  'libsrt', 'librist', 'libjxl', 'chromaprint', 'vulkan', 'whisper', 'libplacebo',
].map((f) => f.replaceAll('-', '_').toUpperCase());

import { optionFacts } from '../src/commands/options.ts';
describe('profiles/devenvy.yml', () => {
  it('has a target for every build devenvy/ffmpeg publishes', () => {
    expect(cells.length).toBe(folder.targets.length);
    expect(folder.targets.map((t) => t.name)).toEqual(expect.arrayContaining(['linux-x64-lgplv3', 'win-arm64-gplv2', 'ios-sim-arm64-lgplv3-ffmpeg8']));
  });

  it('passes check from the command line, copied into a folder of its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-shipped-'));
    copyFileSync(shippedPath, join(dir, 'ffmpeg-build.yml'));
    const r = runCli(['check'], { cwd: dir });
    expect(r.stdout).not.toContain('✗');
    expect(r.exitCode).toBe(0);
  });

  it("passes today's linux-x64 lgplv3 configure flags (as a set)", () => {
    expect([...configureFlags(data, linux('lgplv3'))].sort()).toEqual(["--disable-autodetect","--disable-debug","--disable-doc","--disable-ffplay","--disable-gpl","--disable-nonfree","--disable-static","--enable-chromaprint","--enable-cuda","--enable-cuvid","--enable-ffmpeg","--enable-ffnvcodec","--enable-ffprobe","--enable-lcms2","--enable-libaom","--enable-libass","--enable-libdav1d","--enable-libdrm","--enable-libfontconfig","--enable-libfreetype","--enable-libfribidi","--enable-libgsm","--enable-libharfbuzz","--enable-libjxl","--enable-libkvazaar","--enable-libmp3lame","--enable-libopencore-amrnb","--enable-libopencore-amrwb","--enable-libopenh264","--enable-libopenjpeg","--enable-libopus","--enable-libplacebo","--enable-librist","--enable-libsoxr","--enable-libspeex","--enable-libsrt","--enable-libsvtav1","--enable-libvmaf","--enable-libvo-amrwbenc","--enable-libvorbis","--enable-libvpl","--enable-libvpx","--enable-libwebp","--enable-libxml2","--enable-libzimg","--enable-nvdec","--enable-nvenc","--enable-openssl","--enable-pic","--enable-pthreads","--enable-shared","--enable-v4l2-m2m","--enable-vaapi","--enable-version3","--enable-vulkan","--enable-whisper","--enable-zlib","--extra-cflags=-I/opt/ffmpeg-build/deps/include","--extra-ldflags=-L/opt/ffmpeg-build/deps/lib","--extra-libs=-lm","--extra-libs=-lpthread -ldl","--pkg-config-flags=--static"]);
  });

  it("builds exactly today's published linux-x64 lgplv3 options", () => {
    expect([...verifyNames(data, linux('lgplv3'))].sort()).toEqual([...PUBLISHED_LGPLV3_LINUX_X64].sort());
  });

  it('gives each linux-x64 license the libraries it allows', () => {
    const has = (license: string, lib: string, series = '9') => linux(license, series).recipes.includes(lib);
    // TLS: openssl for v3, gnutls for gplv2, none for lgplv2
    expect([linux('lgplv3').groups.tls, linux('gplv3').groups.tls, linux('gplv2').groups.tls, linux('lgplv2').groups.tls])
      .toEqual(['openssl', 'openssl', 'gnutls', undefined]);
    // Apache-2.0 only in v3: Vulkan, placebo (through shaderc), AMR
    for (const lib of ['vulkan-loader', 'libplacebo', 'shaderc', 'opencore-amr', 'vo-amrwbenc']) {
      expect([has('lgplv3', lib), has('gplv3', lib), has('gplv2', lib), has('lgplv2', lib)]).toEqual([true, true, false, false]);
    }
    // GPL encoders only in GPL builds, kvazaar only in LGPL ones
    for (const lib of ['x264', 'x265']) expect([has('gplv3', lib), has('gplv2', lib), has('lgplv3', lib), has('lgplv2', lib)]).toEqual([true, true, false, false]);
    expect([has('lgplv3', 'kvazaar'), has('lgplv2', 'kvazaar'), has('gplv3', 'kvazaar'), has('gplv2', 'kvazaar')]).toEqual([true, true, false, false]);
    // srt/rist encrypt through mbedTLS everywhere but lgplv2; whisper everywhere, on Vulkan only where it's allowed
    expect([has('lgplv3', 'mbedtls'), has('gplv3', 'mbedtls'), has('gplv2', 'mbedtls'), has('lgplv2', 'mbedtls')]).toEqual([true, true, true, false]);
    for (const license of ['lgplv3', 'gplv3', 'gplv2', 'lgplv2']) expect(linux(license).options).toContain('whisper');
    // shaderc is FFmpeg 8 only
    expect(linux('lgplv3', '8').options).toContain('shaderc');
    expect(linux('lgplv3').options).not.toContain('shaderc');
  });

  it('builds linux-musl-x64 as upstream does: libvpl, but no v4l2-m2m', () => {
    const musl = cells.find((c) => c.cell.platform === 'linux-musl-x64' && c.cell.license === 'lgplv3' && c.cell.series === '9')!;
    expect(musl.options).toContain('vpl');
    expect(musl.options).not.toContain('v4l2-m2m');
    expect(linux('lgplv3').options).toContain('v4l2-m2m');
  });

  it('builds on every platform platforms.yml lists, with a setup script and image for each', () => {
    for (const [platform, entry] of data.platforms) {
      expect(existsSync(join(packageRoot, 'platforms', 'setup', `${entry.setup}.sh`)), platform).toBe(true);
      if (entry.image !== 'macos') expect(existsSync(join(packageRoot, 'images', entry.image, 'Dockerfile')), platform).toBe(true);
    }
    expect([...data.platforms.keys()]).toContain('linux-musl-x64');
  });

  it('builds osx-arm64 with Apple\'s own media and TLS frameworks, and whisper on Metal', () => {
    const osx = cells.find((c) => c.cell.platform === 'osx-arm64' && c.cell.license === 'lgplv3' && c.cell.series === '9')!;
    for (const option of ['videotoolbox', 'audiotoolbox', 'securetransport', 'whisper']) expect(osx.options).toContain(option);
    // Vulkan on Apple (MoltenVK) follows the per-platform option libraries: until then not on osx
    for (const option of ['vulkan', 'placebo']) expect(osx.options).not.toContain(option);
    expect(osx.recipes).not.toContain('vulkan-loader');
    expect(data.platforms.get('osx-arm64')).toMatchObject({ image: 'macos', setup: 'apple-macos' });
    const linuxOnly = cells.find((c) => c.cell.platform === 'linux-x64' && c.cell.license === 'lgplv3' && c.cell.series === '9')!;
    expect(linuxOnly.options).not.toContain('videotoolbox');
  });

  // ffmpeg.exe's embedded configure line in the published 9.0.2.3 win-x64 lgplv3 artifact, minus --prefix and --extra-*
  it("passes today's published win-x64 lgplv3 configure flags (as a set)", () => {
    const win = cells.find((c) => c.cell.platform === 'win-x64' && c.cell.license === 'lgplv3' && c.cell.series === '9')!;
    const flags = configureFlags(data, win).filter((f) => !f.startsWith('--extra-') && !f.startsWith('--prefix'));
    expect([...flags].sort()).toEqual([
      '--arch=x86_64', '--cc=x86_64-w64-mingw32-gcc-win32', '--cross-prefix=x86_64-w64-mingw32-', '--cxx=x86_64-w64-mingw32-g++-win32',
      '--disable-autodetect', '--disable-debug', '--disable-doc', '--disable-ffplay', '--disable-gpl', '--disable-nonfree',
      '--disable-static', '--enable-amf', '--enable-chromaprint', '--enable-cross-compile', '--enable-cuda', '--enable-cuvid',
      '--enable-d3d11va', '--enable-dxva2', '--enable-ffmpeg', '--enable-ffnvcodec', '--enable-ffprobe', '--enable-lcms2',
      '--enable-libaom', '--enable-libass', '--enable-libdav1d', '--enable-libfreetype', '--enable-libfribidi', '--enable-libgsm',
      '--enable-libharfbuzz', '--enable-libjxl', '--enable-libkvazaar', '--enable-libmp3lame', '--enable-libopencore-amrnb',
      '--enable-libopencore-amrwb', '--enable-libopenh264', '--enable-libopenjpeg', '--enable-libopus', '--enable-libplacebo',
      '--enable-librist', '--enable-libsoxr', '--enable-libspeex', '--enable-libsrt', '--enable-libsvtav1', '--enable-libvmaf',
      '--enable-libvo-amrwbenc', '--enable-libvorbis', '--enable-libvpl', '--enable-libvpx', '--enable-libwebp', '--enable-libxml2',
      '--enable-libzimg', '--enable-mediafoundation', '--enable-nvdec', '--enable-nvenc', '--enable-schannel', '--enable-shared',
      '--enable-version3', '--enable-vulkan', '--enable-w32threads', '--enable-whisper', '--enable-zlib', '--pkg-config-flags=--static',
      '--pkg-config=pkg-config', '--target-os=mingw32',
    ]);
  });

  it('cross-compiles osx-x64 on Apple silicon, and gives maccatalyst-x64 its x86_64 target', () => {
    const cell = (platform: string) => cells.find((c) => c.cell.platform === platform && c.cell.license === 'lgplv3' && c.cell.series === '9')!;
    const osx = configureFlags(data, cell('osx-x64'));
    expect(osx).toEqual(expect.arrayContaining(['--arch=x86_64', '--enable-cross-compile']));
    expect(osx.filter((f) => f.startsWith('--extra-cflags=')).join(' ')).toContain('-arch x86_64');
    expect(configureFlags(data, cell('maccatalyst-x64'))).toEqual(expect.arrayContaining(['--arch=x86_64', '--enable-cross-compile', '--target-os=darwin']));
    expect(configureFlags(data, cell('ios-sim-arm64'))).toEqual(expect.arrayContaining(['--arch=aarch64', '--enable-cross-compile', '--target-os=darwin']));
  });

  it("builds SPIR-V headers for whisper only where its Vulkan backend builds", () => {
    const cell = (platform: string) => cells.find((c) => c.cell.platform === platform && c.cell.license === 'lgplv3' && c.cell.series === '9')!;
    for (const platform of ['ios-sim-arm64', 'ios-arm64', 'osx-arm64', 'maccatalyst-arm64']) {
      expect(cell(platform).recipes, platform).toContain('whisper.cpp');
      expect(cell(platform).recipes, platform).not.toContain('spirv-headers'); // Metal backend
    }
    expect(cell('linux-x64').recipes).toContain('spirv-headers');
  });

  it('keeps the iOS simulator slice lean', () => {
    const sim = cells.find((c) => c.cell.platform === 'ios-sim-arm64' && c.cell.license === 'lgplv3' && c.cell.series === '9')!;
    // turned down by the target (their libraries build for the simulator); the rest don't build there at all
    const target = folder.targets.find((t) => t.name === 'ios-sim-arm64-lgplv3')!;
    expect(target.without).toEqual(expect.arrayContaining(['vpx', 'kvazaar', 'opus', 'aom', 'freetype', 'fribidi', 'harfbuzz']));
    expect(sim.options).toContain('whisper'); // published 9.0.2.3: the simulator slice has whisper (Metal)
    for (const option of ['vpx', 'x264', 'x265', 'kvazaar', 'opus', 'aom', 'freetype', 'fribidi', 'harfbuzz', 'fontconfig', 'ass', 'vulkan', 'placebo']) {
      expect(sim.options).not.toContain(option);
    }
  });
});

describe('Windows Vulkan', () => {
  it('brings the SPIR-V headers with vulkan, with or without whisper', () => {
    const r = parseProfileText('name: t\nffmpeg: 9\nplatforms: [win-x64]\nlicense: lgplv3\nwith: [vulkan]\n', 't.yml');
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const cell = planProfile(r.profile, data, { '9': '9.0.2' }).cells[0]!;
    expect(cell.recipes).toEqual(['spirv-headers', 'vulkan-headers']);
  });

  it('options --json names each platform library with its licence and platforms', () => {
    const vulkan = optionFacts(data, '9').find((o) => o.name === 'vulkan')!;
    expect(vulkan.libraries).toEqual([
      { name: 'vulkan-loader', spdx: 'Apache-2.0', platforms: expect.arrayContaining(['linux-x64', 'osx-arm64']) },
      { name: 'vulkan-headers', spdx: 'Apache-2.0 OR MIT', platforms: ['linux-armhf', 'win-x64', 'win-arm64', 'android-arm64', 'android-x64'] },
    ]);
  });
});

describe('Apple until Vulkan arrives there', () => {
  it.each(['ios-arm64', 'maccatalyst-arm64'])('%s builds no placebo, shaderc or Vulkan headers', (platform) => {
    for (const series of ['8', '9']) {
      const c = cells.find((x) => x.cell.platform === platform && x.cell.license === 'lgplv3' && x.cell.series === series)!;
      for (const option of ['vulkan', 'placebo', 'shaderc']) expect(c.options).not.toContain(option);
      for (const lib of ['libplacebo', 'shaderc', 'vulkan-headers']) expect(c.recipes).not.toContain(lib);
    }
  });
});

// The published 9.0.2.3 lgplv3 artifacts' embedded configure lines (libavutil), minus --prefix, --extra-* and the
// toolchain paths (--cc, --sysroot, ...) that name the build machine.
describe("linux-armhf and Android plan the published builds' configure flags", () => {
  const flagsOf = (platform: string) => {
    const c = cells.find((x) => x.cell.platform === platform && x.cell.license === 'lgplv3' && x.cell.series === '9')!;
    return [...configureFlags(data, c).filter((f) => !f.startsWith('--extra-') && !f.startsWith('--prefix'))].sort();
  };

  it('linux-armhf plans the published flags', () => {
    expect(flagsOf('linux-armhf')).toEqual([
      '--arch=arm', '--cpu=armv7-a+vfpv3', '--cross-prefix=arm-linux-gnueabihf-', '--disable-autodetect', '--disable-debug', '--disable-doc', '--disable-ffplay', '--disable-gpl', '--disable-nonfree', '--disable-static', '--enable-chromaprint', '--enable-cross-compile', '--enable-ffmpeg', '--enable-ffprobe', '--enable-lcms2', '--enable-libaom', '--enable-libass', '--enable-libdav1d', '--enable-libfontconfig', '--enable-libfreetype', '--enable-libfribidi', '--enable-libgsm', '--enable-libharfbuzz', '--enable-libjxl', '--enable-libkvazaar', '--enable-libmp3lame', '--enable-libopencore-amrnb', '--enable-libopencore-amrwb', '--enable-libopenh264', '--enable-libopenjpeg', '--enable-libopus', '--enable-libplacebo', '--enable-librist', '--enable-libsoxr', '--enable-libspeex', '--enable-libsrt', '--enable-libvmaf', '--enable-libvo-amrwbenc', '--enable-libvorbis', '--enable-libvpx', '--enable-libwebp', '--enable-libxml2', '--enable-libzimg', '--enable-openssl', '--enable-pic', '--enable-pthreads', '--enable-shared', '--enable-v4l2-m2m', '--enable-version3', '--enable-vulkan', '--enable-whisper', '--enable-zlib', '--pkg-config-flags=--static', '--pkg-config=pkg-config', '--target-os=linux',
    ]);
  });

  // Android: the published flags less --enable-hwaccel=h264_mediacodec and hevc_mediacodec, which matched nothing
  it('android-arm64 plans the published flags', () => {
    expect(flagsOf('android-arm64')).toEqual([
      '--arch=aarch64', '--disable-autodetect', '--disable-debug', '--disable-doc', '--disable-gpl', '--disable-nonfree', '--disable-programs', '--disable-static', '--enable-chromaprint', '--enable-cross-compile', '--enable-decoder=h264_mediacodec', '--enable-decoder=hevc_mediacodec', '--enable-jni', '--enable-lcms2', '--enable-libaom', '--enable-libass', '--enable-libdav1d', '--enable-libfreetype', '--enable-libfribidi', '--enable-libgsm', '--enable-libharfbuzz', '--enable-libjxl', '--enable-libkvazaar', '--enable-libmp3lame', '--enable-libopencore-amrnb', '--enable-libopencore-amrwb', '--enable-libopenh264', '--enable-libopenjpeg', '--enable-libopus', '--enable-libplacebo', '--enable-librist', '--enable-libsoxr', '--enable-libspeex', '--enable-libsrt', '--enable-libvmaf', '--enable-libvo-amrwbenc', '--enable-libvorbis', '--enable-libvpx', '--enable-libxml2', '--enable-libzimg', '--enable-mediacodec', '--enable-openssl', '--enable-pic', '--enable-pthreads', '--enable-shared', '--enable-version3', '--enable-vulkan', '--enable-whisper', '--enable-zlib', '--pkg-config-flags=--static', '--target-os=android',
    ]);
  });

  it('android-x64 plans the published flags', () => {
    expect(flagsOf('android-x64')).toEqual([
      '--arch=x86_64', '--disable-autodetect', '--disable-debug', '--disable-doc', '--disable-gpl', '--disable-nonfree', '--disable-programs', '--disable-static', '--enable-chromaprint', '--enable-cross-compile', '--enable-decoder=h264_mediacodec', '--enable-decoder=hevc_mediacodec', '--enable-jni', '--enable-lcms2', '--enable-libaom', '--enable-libass', '--enable-libdav1d', '--enable-libfreetype', '--enable-libfribidi', '--enable-libgsm', '--enable-libharfbuzz', '--enable-libjxl', '--enable-libkvazaar', '--enable-libmp3lame', '--enable-libopencore-amrnb', '--enable-libopencore-amrwb', '--enable-libopenh264', '--enable-libopenjpeg', '--enable-libopus', '--enable-libplacebo', '--enable-librist', '--enable-libsoxr', '--enable-libspeex', '--enable-libsrt', '--enable-libvmaf', '--enable-libvo-amrwbenc', '--enable-libvorbis', '--enable-libvpx', '--enable-libxml2', '--enable-libzimg', '--enable-mediacodec', '--enable-openssl', '--enable-pic', '--enable-pthreads', '--enable-shared', '--enable-version3', '--enable-vulkan', '--enable-whisper', '--enable-zlib', '--pkg-config-flags=--static', '--target-os=android',
    ]);
  });

  it('builds Vulkan from the headers alone on linux-armhf and Android, without the loader', () => {
    for (const platform of ['linux-armhf', 'android-arm64', 'android-x64']) {
      const c = cells.find((x) => x.cell.platform === platform && x.cell.license === 'lgplv3' && x.cell.series === '9')!;
      expect(c.recipes).toContain('vulkan-headers');
      expect(c.recipes).not.toContain('vulkan-loader');
    }
  });
});

describe('Android ships the NDK libc++', () => {
  it('names libc++_shared.so and its licence, which every license allows', () => {
    for (const platform of ['android-arm64', 'android-x64']) {
      expect(data.platforms.get(platform)!.ships).toEqual({ 'libc++_shared.so': { license: 'Apache-2.0 WITH LLVM-exception', notice: '${TOOLCHAIN}/NOTICE' } });
    }
    const lgplv2 = parseProfileText('name: t\nffmpeg: 9\nplatforms: [android-arm64]\nlicense: lgplv2\nwith: [dav1d]\n', 't.yml');
    expect(formatReport(checkProfile(lgplv2, data))).not.toContain('✗');
  });

  it('puts the mediacodec decoders on the mediacodec option, not the platform', () => {
    const flags = data.platforms.get('android-arm64')!.configure;
    expect(flags.some((f) => f.includes('mediacodec'))).toBe(false);
    const c = cells.find((x) => x.cell.platform === 'android-arm64' && x.cell.license === 'lgplv3' && x.cell.series === '9')!;
    expect(configureFlags(data, c)).toEqual(expect.arrayContaining(['--enable-mediacodec', '--enable-decoder=h264_mediacodec', '--enable-decoder=hevc_mediacodec']));
  });
});

describe('verifying component flags', () => {
  it('checks --enable-<kind>=<name> as the CONFIG_<NAME>_<KIND> FFmpeg sets', () => {
    const c = cells.find((x) => x.cell.platform === 'android-arm64' && x.cell.license === 'lgplv3' && x.cell.series === '9')!;
    expect(verifyNames(data, c)).toEqual(expect.arrayContaining(['MEDIACODEC', 'JNI', 'H264_MEDIACODEC_DECODER', 'HEVC_MEDIACODEC_DECODER']));
    expect(verifyNames(data, c).some((n) => n.includes('='))).toBe(false);
  });
});

// The published 9.0.2.3 lgplv3 artifacts' configure lines (libavutil) minus --prefix and the --extra-* build paths:
// upstream builds both natively on arm64, so they carry no cross flags.
describe("linux-arm64 and linux-musl-arm64 plan the published builds' configure flags", () => {
  const of = (platform: string) => cells.find((x) => x.cell.platform === platform && x.cell.license === 'lgplv3' && x.cell.series === '9')!;
  const flagsOf = (platform: string) => [...configureFlags(data, of(platform)).filter((f) => !f.startsWith('--extra-') && !f.startsWith('--prefix'))].sort();

  it('linux-arm64 plans the published flags', () => {
    expect(flagsOf('linux-arm64')).toEqual([
      '--disable-autodetect', '--disable-debug', '--disable-doc', '--disable-ffplay', '--disable-gpl', '--disable-nonfree', '--disable-static', '--enable-chromaprint', '--enable-cuda', '--enable-cuvid', '--enable-ffmpeg', '--enable-ffnvcodec', '--enable-ffprobe', '--enable-lcms2', '--enable-libaom', '--enable-libass', '--enable-libdav1d', '--enable-libdrm', '--enable-libfontconfig', '--enable-libfreetype', '--enable-libfribidi', '--enable-libgsm', '--enable-libharfbuzz', '--enable-libjxl', '--enable-libkvazaar', '--enable-libmp3lame', '--enable-libopencore-amrnb', '--enable-libopencore-amrwb', '--enable-libopenh264', '--enable-libopenjpeg', '--enable-libopus', '--enable-libplacebo', '--enable-librist', '--enable-libsoxr', '--enable-libspeex', '--enable-libsrt', '--enable-libsvtav1', '--enable-libvmaf', '--enable-libvo-amrwbenc', '--enable-libvorbis', '--enable-libvpx', '--enable-libwebp', '--enable-libxml2', '--enable-libzimg', '--enable-nvdec', '--enable-nvenc', '--enable-openssl', '--enable-pic', '--enable-pthreads', '--enable-shared', '--enable-v4l2-m2m', '--enable-vaapi', '--enable-version3', '--enable-vulkan', '--enable-whisper', '--enable-zlib', '--pkg-config-flags=--static',
    ]);
  });

  it('linux-musl-arm64 plans the published flags', () => {
    expect(flagsOf('linux-musl-arm64')).toEqual([
      '--disable-autodetect', '--disable-debug', '--disable-doc', '--disable-ffplay', '--disable-gpl', '--disable-nonfree', '--disable-static', '--enable-chromaprint', '--enable-cuda', '--enable-cuvid', '--enable-ffmpeg', '--enable-ffnvcodec', '--enable-ffprobe', '--enable-lcms2', '--enable-libaom', '--enable-libass', '--enable-libdav1d', '--enable-libdrm', '--enable-libfontconfig', '--enable-libfreetype', '--enable-libfribidi', '--enable-libgsm', '--enable-libharfbuzz', '--enable-libjxl', '--enable-libkvazaar', '--enable-libmp3lame', '--enable-libopencore-amrnb', '--enable-libopencore-amrwb', '--enable-libopenh264', '--enable-libopenjpeg', '--enable-libopus', '--enable-libplacebo', '--enable-librist', '--enable-libsoxr', '--enable-libspeex', '--enable-libsrt', '--enable-libsvtav1', '--enable-libvmaf', '--enable-libvo-amrwbenc', '--enable-libvorbis', '--enable-libvpx', '--enable-libwebp', '--enable-libxml2', '--enable-libzimg', '--enable-nvdec', '--enable-nvenc', '--enable-openssl', '--enable-pic', '--enable-pthreads', '--enable-shared', '--enable-v4l2-m2m', '--enable-vaapi', '--enable-version3', '--enable-vulkan', '--enable-whisper', '--enable-zlib', '--pkg-config-flags=--static',
    ]);
  });

  it('defines both in platforms.yml and builds them with the Vulkan loader, which they ship, and without libvpl (x86 only)', () => {
    for (const platform of ['linux-arm64', 'linux-musl-arm64']) {
      expect(of(platform).recipes).toContain('vulkan-loader');
      expect(of(platform).options).not.toContain('vpl');
      expect(data.platforms.get(platform)).toBeDefined();
    }
  });
});
