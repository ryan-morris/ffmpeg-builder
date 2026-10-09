# `build` on linux-x64: design (handoff step 3a)

Handoff step 3 is "build for one platform (linux-x64) using ported recipes inside a pinned toolchain image, with
the library cache, and reproduce today's linux-x64 LGPLv3 artifact". It is split in two:

- **3a (this spec):** the build machinery. That means the toolchain image, the recipe contract, source fetching,
  the library cache, FFmpeg configure flags, staging and the artifact names. It is proven end to end with a few real
  recipes.
- **3b (next):** port the remaining linux-x64 recipes from `D:\source-other\ffmpeg-devenvy\scripts\deps`, build
  the devenvy LGPLv3 cell, and compare it with the published `ffmpeg-9.0.2-linux-x64-lgplv3.tar.gz` (release
  `9.0.2.3`).

Reference implementation: `devenvy/ffmpeg` `scripts/build.sh`, `steps/02,05,06,07,08`, `platform/linux.sh`,
`deps/lib.sh`, `lib.sh`. Port its behaviour, not its structure.

## Command

```
ffmpeg-build build [profile] --platform linux-x64 [--ffmpeg <series>] [--license <license>] [--out <dir>]
```

- `profile` may be left out when the folder has exactly one profile.
- It builds every FFmpeg series × license of the profile on that platform, unless `--ffmpeg` / `--license` narrow
  it. Builds run one at a time.
- It needs `ffmpeg.lock` to match the profile (it runs `check` with the lock). Without a lock it says
  "run ffmpeg-build lock first".
- Output goes to `--out` (default `dist/`): `ffmpeg-{ffmpeg}-{platform}-{variant}.tar.gz`, its `-dev.tar.gz`, and
  a `.log` of the build.
- In this step only `linux-x64` builds. Other platforms say "building for <platform> isn't supported yet (linux-x64
  only)".
- Exit codes: 0 built; 1 profile/lock problem; 2 usage, Docker missing, or the build failed (the message names the
  library or step and points at the log).

## Variant name (asset names stay as today)

`variant` = the profile `name` when the folder has more than one profile, plus `-<license>` when the profile lists
more than one license. When that leaves nothing, it is the license.

| Folder | Profile | variant |
|---|---|---|
| devenvy-ffmpeg (one profile, 4 licenses) | devenvy | `lgplv3`, `gplv3`, ... (today's names) |
| company-ffmpeg (two profiles, one license each) | dvr | `dvr` |
| one profile with one license | x | `<license>` |

## Toolchain image

- `images/linux/Dockerfile` is `FROM quay.io/pypa/manylinux_2_28_x86_64:2026.09.30-1@sha256:c2261579b9c2e5d45aa93312f73e2a302182e3e977b558581a1838d6fed3d8e6`. That is upstream's pinned manylinux_2_28 (AlmaLinux 8, glibc 2.28), so artifacts keep today's glibc 2.28 floor. It is provisioned the way upstream's `03_install_packages.sh` does:
  - dnf packages
  - meson 1.12.1 and ninja 1.13.2 from its CPython 3.12
  - the static patchelf 0.19.2 (AlmaLinux's 0.17.2 corrupts gcc-toolset PIE executables)
- The driver enables gcc-toolset-14.
- The image is built locally on demand and tagged `ffmpeg-build-linux:<first 12 hex of sha256(Dockerfile)>`.
- Its **cache identity is the built image's Docker ID**: dnf packages aren't pinned, so a rebuilt image counts as a new toolchain.
- glslc (shaderc, for Vulkan) comes in 3b.
- Publishing images to a registry and recording digests in `ffmpeg.lock` (`images:`) come with the release workflows (handoff step 6).

## Recipe contract

`recipes/<name>/build.sh` is run by `bash` inside the container, in a fresh shell per library, with:

| Variable | Meaning |
|---|---|
| `SRC_DIR` | the library's source, already fetched at the locked version |
| `DEPS_DIR` | `/opt/ffmpeg-build/deps`: the shared install prefix; everything it `needs` is already there |
| `BUILD_RID` | the platform, e.g. `linux-x64` |
| `VERSION` | the locked version (a commit for branch libraries) |
| `JOBS` | parallel jobs (`nproc`) |
| `CMAKE_CROSS_ARGS`, `MESON_CROSS_ARGS` | bash arrays; empty for native linux-x64 |
| `PKG_CONFIG_PATH` | `$DEPS_DIR/lib/pkgconfig` |

- `recipes/lib.sh` is sourced first and provides:
  - `cmake`: upstream's wrapper adding `-DCMAKE_POLICY_VERSION_MINIMUM=3.5`
  - `cmake_build [args]`: configure/build/install a static library into `DEPS_DIR` (upstream's `build_cmake_dep`)
  - `meson_build [args]`: the same for meson
- Recipes are run from `SRC_DIR`.
- A recipe never touches FFmpeg's configure flags. Those come from `recipe.yml` `configure:`.
- Per-platform differences are `case "$BUILD_RID"` blocks inside `build.sh`, as upstream does.

## Sources

`recipe.yml` `source:` is one of:

- `git: <url>`, `ref: "<template>"`, optional `mirror: <url>`: a shallow clone of that tag or branch. A branch
  library (`versions: { git-branch: ... }`) is fetched at its locked commit (`git fetch --depth 1 origin <commit>`).
- `url: "<template>"`, optional `mirrors: [<template>, ...]`: a tarball (`.tar.gz`, `.tar.xz`, `.tar.bz2`) unpacked
  with its top folder stripped. Each URL is tried in order.

Templates use `{version}`, `{major}`, `{minor}`, `{patch}`. FFmpeg's own source is in `ffmpeg/source.yml` under
`url:` / `mirrors:` (`https://ffmpeg.org/releases/ffmpeg-{version}.tar.xz`, then GitHub's tag archive).

Every download is retried like upstream's `git`/`curl` wrappers. A mirror is tried after the origin has had a short
retry budget.

## Library cache

- Location: `FFMPEG_BUILD_CACHE`, else `~/.cache/ffmpeg-build`; libraries under `libs/<key>.tar.gz`.
- Key: sha256 of: recipe name, locked version, platform, image id, the hash of every file in `recipes/<name>/`
  and `recipes/lib.sh`, and the keys of the libraries it `needs` (so a changed dependency rebuilds its dependents).
- Content: the files the library's build added or changed under `DEPS_DIR`. These are found by comparing a listing
  (path, size, mtime) taken before and after. A cached library is unpacked into `DEPS_DIR` instead of being built.
- `DEPS_DIR` is the same fixed path in every container, so the absolute paths in `.pc` files stay valid.
- A failed build leaves no cache entry. Each entry is written to a temp name and renamed.

## FFmpeg configure

Computed by the CLI per build (cell):

- **Base, from upstream step 07:** `--enable-shared --disable-static --enable-ffmpeg --enable-ffprobe --disable-ffplay
  --disable-doc --disable-debug --enable-pthreads --disable-autodetect --pkg-config-flags=--static --enable-pic`,
  `--extra-cflags=-I$DEPS_DIR/include`, `--extra-ldflags=-L$DEPS_DIR/lib`, and linux-x64's
  `--extra-libs=-lpthread -ldl`.
- **License:**
  - `lgplv2`: `--disable-gpl --disable-nonfree`
  - `lgplv3`: `--disable-gpl --enable-version3 --disable-nonfree`
  - `gplv2`: `--enable-gpl --disable-nonfree`
  - `gplv3`: `--enable-gpl --enable-version3 --disable-nonfree`
  - `nonfree`: `--enable-gpl --enable-version3 --enable-nonfree`
  - The `--disable-*` flags are explicit, as upstream passes them.
- **Options:** for each option in the build, its recipe's `configure:` flags. A built-in option without a recipe adds
  `--enable-<name>`.

## Staging (linux, as upstream 08 + release.yml)

- **Runtime archive:** `lib*.so*` from the install prefix, plus `ffmpeg` and `ffprobe`. The rpath is set to `$ORIGIN`
  with `patchelf`, and the `.so` symlinks are kept.
- **Dev archive:** `include/` and `lib/pkgconfig/`, with `.pc` files rewritten to be relocatable
  (`prefix=${pcfiledir}/../..`).
- **Check after the build:** `ffmpeg -hide_banner -version` runs inside the container from the staged folder, and
  every option in the build must appear in `config_components.h` / `config.h` (`CONFIG_<NAME> 1`) or in
  `ffmpeg -buildconf`. A build that silently dropped an option fails.

## How it runs

The CLI writes a `plan.json` for each build. It holds:
- the libraries in build order, each with its source, version, cache key and whether it's cached
- FFmpeg's source and configure flags
- the archive names

It then runs one `docker run --rm` with these mounts:
- `recipes/` and the engine's `platforms/linux/` (read-only)
- the cache folder
- the output folder
- `plan.json`

`platforms/linux/driver.sh` (bash and jq) does the work inside the container's own filesystem: fetch, build or unpack
each library, build FFmpeg, stage, check, write the archives. Output streams to the terminal and to the `.log`.

## Testing

- **Unit (TypeScript, offline):** variant names, configure flags, cache keys (stability, and that a dependency change
  or a recipe file change alters them), source templates, plan content, command errors (no lock, wrong platform, no
  Docker).
- **Docker integration (slow, opt-in with `FFMPEG_BUILD_DOCKER_TESTS=1`):** a profile with `start: nothing`,
  `with: [dav1d, opus, x265]`, license `gplv3`, built twice. The first build compiles and produces both archives;
  `ffmpeg -version` runs; `libx265`, `libdav1d` and `libopus` are enabled. The second build takes every library from
  the cache.

## Recipes ported in 3a

`nv-codec` (headers, make), `zlib` (its own configure script), `dav1d` (meson), `opus` (cmake), `x265` (cmake, `source/`), each with a
`build.sh` ported from upstream and complete `source:` facts (mirrors included where upstream has them). Everything
else is 3b.

## Known gaps for 3b (parity with today's artifact)

- **`libdrm`, `libvpl`, `v4l2-m2m`:** upstream linux-x64 also passes `--enable-libdrm`, `--enable-libvpl` and `--enable-v4l2-m2m`. These need a `configure:` on the libdrm recipe, a libvpl recipe, and the v4l2-m2m built-in in `ffmpeg/<major>.yml`.
- **`libvulkan.so`:** upstream bundles it in the runtime archive. Staging must copy it once the Vulkan recipes arrive.
- **glslc:** the image needs the pinned shaderc build for Vulkan.

## Not in this step

Patches, profile `tests:`, `legal/` and the source bundle (handoff step 6), other platforms, published images,
`ffmpeg-build dev`.
