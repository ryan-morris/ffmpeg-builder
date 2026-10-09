# Remaining platforms: design (handoff step 5)

Upstream (devenvy/ffmpeg) builds 15 platforms. The engine builds linux-x64. This step brings the rest in, in slices
that each merge on their own:

| Slice | Platforms | Where it builds | Verified here |
|---|---|---|---|
| 5a | engine generalisation + linux-musl-x64 | Docker (Alpine) | yes |
| 5b | win-x64, win-arm64 | Docker (mingw-w64 / llvm-mingw cross) | yes |
| 5c | linux-armhf, android-arm64, android-x64 | Docker (cross gcc / pinned NDK) | yes |
| 5d | linux-arm64, linux-musl-arm64 | Docker on an arm64 host (emulated on x64) | libraries only, emulated |
| 5e | osx-*, ios-*, maccatalyst-* | natively on macOS (Xcode) | no: needs a macOS host |

`linux-armhf` joins the platform list in 5c (upstream builds it; the engine's list lacks it today).

## The rule, carried over from step 4

Per-platform facts are data, not code. Today `src/build/plan.ts` has a `PLATFORM_FLAGS` table and
`src/commands/build.ts` a `SUPPORTED` list; both move into engine data.

## `platforms.yml` (engine data)

One entry per platform:

```yaml
platforms:
  linux-x64:
    image: linux-x64          # images/<name>/Dockerfile; or `macos`: built natively on a macOS host
    setup: linux              # platforms/setup/<name>.sh: compilers, cross files, packaging
    configure: ["--extra-libs=-lpthread -ldl"]   # FFmpeg configure flags this platform always needs
  linux-musl-x64:
    image: linux-musl-x64
    setup: linux-musl
    configure: ["--extra-libs=-lpthread -ldl"]
  win-x64:
    image: cross-windows
    setup: windows
    configure: [--target-os=mingw32, --arch=x86_64, --enable-cross-compile, --cross-prefix=x86_64-w64-mingw32-, ...]
```

- `check` and `plan` don't change: whether a platform can be built is a build-time question.
- `build --platform P` refuses a platform without an entry ("building for P isn't supported yet"), and a `macos`
  platform on a non-macOS host ("build P on macOS").
- An FFmpeg feature a platform offers (d3d11va, videotoolbox, mediacodec) is an FFmpeg option in `ffmpeg/<major>.yml`,
  limited to its platforms, and so a profile entry like any other (all.yml lists them). `configure:` here is only
  what every build for the platform needs (target, arch, cross prefix, link fixes).

## Recipes: dependencies per platform

`needs:` and `uses:` items take the profile's own condition shape, limited to `platforms:`:

```yaml
needs: [spirv-headers, { vulkan-shim: { platforms: [win-*] } }]
uses: [{ vulkan-loader: { platforms: [linux-*] } }]
```

Build order, cache keys, license closure (`licenseBlocker` gains the platform), the cycle check and the
"needs X which doesn't build for P" check all read a dependency only on the platforms it applies to. This closes the
known gaps (whisper, libass, fontconfig limited to linux/osx; whisper building the Vulkan loader on osx).

## One driver, per-platform setup

- `platforms/driver.sh` (moved from `platforms/linux/driver.sh`) stays the one build script: libraries from the
  plan, FFmpeg's configure and verify, staging, archives.
- `platforms/setup/<name>.sh` is sourced by the driver and by each recipe's build (after `recipes/lib.sh`). It
  provides what the recipes already read, as upstream's `platform/*.sh` + `05_write_toolchain.sh` did: `CROSS_HOST`,
  `CROSS_PREFIX`, `CC`/`CXX`/`AR`/`RANLIB`, `CMAKE_CROSS_ARGS` (a CMake toolchain file), `MESON_CROSS_ARGS` (a meson
  cross file), `EXTRA_CFLAGS`/`EXTRA_LDFLAGS`, `CXX_RT_LIB`, `TOOLCHAIN`/`API`/`ANDROID_TRIPLE` for the NDK, and a
  `stage` function for the platform's packaging (Linux .so + rpath; Windows DLLs + import .libs; Android unversioned
  .so + libc++_shared; Apple dylibs/frameworks).
- The setup script owns `CMAKE_CROSS_ARGS` / `MESON_CROSS_ARGS`: it is sourced after `recipes/lib.sh` (which resets them,
  so a recipe run without a setup still gets empty arrays).
- The cache key's toolchain identity covers the image, `driver.sh` and the platform's setup script.

## Images

`images/<name>/Dockerfile`, each pinned by digest as `images/linux-x64` is today. Toolchains upstream left unpinned
(Ubuntu's mingw-w64, the runner's NDK, Debian's cross gcc) are pinned here: by image digest, or by version plus
SHA-256 for downloads (llvm-mingw, the NDK).

## Not in this step

`bundle` and workflows (step 6), Apple packaging into xcframeworks (with 5e, release side in step 6), qemu-based
testing of foreign-architecture artifacts.

No win-x86: devenvy/ffmpeg has never published one (no asset in any release, and upstream's scripts build only
win-x64 and win-arm64), so there is nothing to match. Adding it later means a new platform without a reference,
and deciding which GPU and vendor libraries (CUDA/NVENC, AMF, oneVPL, Vulkan) a 32-bit build keeps.

## Follow-up (owner, 2026-10-08): building without Docker

Not everyone has (or wants) Docker. Planned as a slice after 5b/5e merge:

- `build --in here|docker`: `here` runs platforms/driver.sh directly on the current machine (the native path the
  macOS lane adds), after checking the setup's required tools and naming what's missing; `docker` is today's pinned
  image. Default: `here` when the host can build the platform natively, else Docker; impossible combinations (Apple
  on Windows) are a clear error.
- Running the tool inside any container (manylinux, a CI image) is just `--in here` there.
- Native cache keys use a fingerprint of the host toolchain instead of the image ID, so native and Docker libraries
  never mix.
- Windows hosts: native means MSYS2 (MinGW gcc, bash, make) with its own setup script; not byte-identical to the Docker
  cross builds. MSVC-native builds are out of scope (the recipes are autotools/cmake/meson shell).
- Docker stays the recommended way for release builds (reproducible); published workflows keep using it.

## Open question (owner, 2026-10-08): profile shape

Reading what one build gets from a matrix profile with per-entry conditions is hard (all.yml has about 15
conditional entries). Options under discussion, undecided:

1. Keep the format; add a resolved view (`ffmpeg-build show --platform P --license L`: the flat list for one build).
2. Group by build in one file: `with:` for every build plus `builds: [{ for: {platforms/license}, with, without }]`.
3. One target per profile (one platform, one license) with a shared base file; `without:` in the child is the
   explicit "off". Reverses the earlier no-inheritance decision; many files for broad distributions.

`without:` with a condition is today's "turn off what a broader entry turned on", within one file.
