# linux-x64 recipes and parity: design (handoff step 3b)

Follows `2026-10-08-build-linux-design.md` (3a), which defines the build machinery and the recipe contract. 3b
ports the remaining linux-x64 libraries and compares the result with the published
`ffmpeg-9.0.2-linux-x64-lgplv3.tar.gz` (devenvy/ffmpeg release `9.0.2.3`).

## Target

The published artifact's configure line (read with `ffmpeg -buildconf`) enables, besides the base and license
flags:

```
cuda cuvid nvenc nvdec ffnvcodec vaapi libdrm libvpl v4l2-m2m libvpx libopenh264 libkvazaar libdav1d zlib lcms2
libxml2 libfreetype libfribidi libharfbuzz libfontconfig libass libvorbis libopus libmp3lame libspeex libgsm
libopencore-amrnb libopencore-amrwb libvo-amrwbenc libsoxr libaom libsvtav1 libwebp libopenjpeg libzimg libvmaf
openssl libsrt librist libjxl chromaprint vulkan whisper libplacebo
```

Its runtime archive holds FFmpeg's seven shared libraries, `ffmpeg`, `ffprobe`, `libvulkan.so*`, and `legal/`.
`legal/` arrives with the source bundle (handoff step 6). The GPL cells add `libx264` and `libx265`.

## Recipes

Each upstream `scripts/deps/<x>.sh` that linux-x64 runs becomes `recipes/<name>/{recipe.yml,build.sh}`:

- **What to port:** the *behaviour* of the script. Every `case "$RID"` arm, every flag, and every hard-won comment
  are kept. Upstream's `BUILD_*` switches are dropped, because selection is the engine's job.
- **Sources:** `recipe.yml` `source:` and `versions:` come from upstream's `deps.json` entry (origin, mirror, tag
  shape). Tarball libraries (gmp, nettle, libtasn1, libgsm, lame, opencore-amr, vo-amrwbenc) use
  `url:` + `mirrors:` and a `listing:` version source.
- **Licenses:** `license:` holds the SPDX expression from the library's own licence files.
- **Dependencies:** `needs:` lists what the library builds against, from the order in `06_build_libraries.sh` and
  the script's own dependency probes.
- **FFmpeg flags:** `configure:` holds the FFmpeg flags the script appended to `CONFIGURE_FLAGS`.
- **Runtime files:** a new optional key, `runtime: [<glob under DEPS_DIR>, ...]`, names files that ship in the
  runtime archive next to FFmpeg's libraries. vulkan-loader sets it to `lib/libvulkan.so*`, replacing upstream's
  special case in step 08.

The recipe names follow upstream's `deps.json` keys where they exist (`libvpx`, `x264`, `srt`, ...).

## FFmpeg options (repo `ffmpeg/8.yml` and `ffmpeg/9.yml`)

These stay hand-written until the nightly generator exists.

- **Option name:** FFmpeg's configure name with a leading `lib` dropped (`libvpx` → `vpx`, `libplacebo` →
  `placebo`, `libdrm` → `drm`). The existing friendly groupings stay: `nvenc` (nv-codec: ffnvcodec, cuda, nvenc,
  nvdec, cuvid), `vaapi` (libva) and `whisper`.
- **Classes and minimums:** `ffmpeg-license` and `min:` come from FFmpeg 9.0.2's `configure`:
  - GPL: x264, x265.
  - version3: opencore-amrnb, opencore-amrwb, vo-amrwbenc (and mbedtls, gmp, which aren't options here).
  - The `require_pkg_config` minimums, e.g. dav1d ≥ 1.0.0, placebo ≥ 7.351.0, whisper ≥ 1.7.5.
- **Built-in:** `v4l2-m2m` (linux-*, android-*).
- **Shared recipe:** `opencore-amrnb` and `opencore-amrwb` share one recipe (`opencore-amr`). Each option enables only
  its own flag, so the recipe's `configure:` is split per option with a new optional option key,
  `configure: [...]`, which overrides the recipe's flags for that option.
- **Removed:** `fdk-aac` leaves the repo data. Upstream doesn't build it, and an unported recipe would only be a
  promise.

## Interim choices until step 4 (licenses and TLS)

- **SRT and RIST encryption:** srt and librist get `needs: [mbedtls]`. That is upstream's choice for v3 cells. The
  `needs-one-of` logic and the v2 rules (GnuTLS, no-TLS lgplv2) need your answers on the open TLS questions.
- **Library licenses:** the SPDX licence checks of library recipes stay off. Only FFmpeg's own GPL, version3 and
  nonfree classes apply, so a v2 build can still pick OpenSSL until step 4.

## Toolchain image

The image gains glslc, built from the pinned shaderc (`v2026.4`, upstream `deps.json`). FFmpeg 8.1+/9.x probe
`glslc --target-env=vulkan1.4`, and without a capable glslc every Vulkan filter is silently dropped. Upstream
builds it from source in `03_install_packages.sh` for exactly this reason. The image is still built locally, and
its Docker ID keys the cache.

## Parity check

`ffmpeg-build build` of a profile `ffmpeg: 9`, `platforms: [linux-x64]`, `license: lgplv3`, `start: everything`,
with a lock holding upstream's `deps.json` versions, must give:

- **Configure line:** the same set of `--enable-*` flags as the published `ffmpeg -buildconf`.
- **Runtime archive:** the same file names, minus `legal/`.
- **Runs:** `ffmpeg -version` in a clean manylinux_2_28 container.

A script, `scripts/compare-published.sh`, does the comparison against a downloaded release asset and prints any
difference. Running it is manual: the full build takes tens of minutes and is not part of `npx vitest run`.

## Result (2026-10-08)

The parity profile was locked to upstream `deps.json`'s 48 library versions and built with
`ffmpeg-build build --platform linux-x64` in one run. Compared with the published
`ffmpeg-9.0.2-linux-x64-lgplv3.tar.gz` (release `9.0.2.3`):

- **Runtime files:** the same.
- **Configure flags:** the same set of `--enable-*` flags.
- **Size:** 59.08 MB vs 59.19 MB. The published archive also has `legal/`.
- **What FFmpeg registers:** identical lists of encoders (229), decoders (551), filters (499, Vulkan ones included),
  formats (423), protocols (74), hwaccels (7) and bitstream filters (52), checked with `ffmpeg -<list>` in a clean
  manylinux_2_28 container.

## Known gaps for later platforms

- **Closed in step 5a:** `needs:` and `uses:` can be limited to platforms (`{ name: { platforms: [...] } }`), so
  recipes can widen to upstream's platforms as each one's setup arrives (whisper.cpp, fontconfig and libass are still
  linux and macOS only until then).
- **Variables the cross-compile `case` arms read** (`CROSS_HOST`, `CROSS_PREFIX`, `TOOLCHAIN`, `ANDROID_*`, `IOS_*`,
  `MCAT_*`) come from each platform's `platforms/setup/<name>.sh`, written with that platform's slice of step 5.
- **The mockup profile `company-ffmpeg/playback.yml`:** it needs whisper on every platform, so it passes `check` only
  once those platforms' recipes exist.

## Not in this step

Other platforms; the GPL/v2 cells' parity (same recipes, checked by step 4's license work); `legal/` and the source
bundle; published images.
