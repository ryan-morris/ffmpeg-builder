# Building

`ffmpeg-build build --target <name>` builds one target in its platform's pinned toolchain and writes
`ffmpeg-<version>-<target>.tar.gz` (the runtime: programs and shared libraries) and `-dev.tar.gz` (headers,
import libraries, pkg-config files) to `--out` (default `dist`). It needs `ffmpeg.lock` (`ffmpeg-build lock`).

## Toolchains

| Platforms | Where it builds | Notes |
|---|---|---|
| linux-x64, linux-arm64 | manylinux_2_28 image | runs on glibc 2.28+ |
| linux-musl-x64, linux-musl-arm64 | Alpine image | libstdc++ and libgcc linked statically: runs on any musl system |
| linux-armhf | Debian bookworm cross image | |
| win-x64, win-arm64 | Ubuntu with mingw-w64 / llvm-mingw | cross-compiled; C and C++ runtimes static; an MSVC import `.lib` per DLL |
| android-arm64, android-x64 | Ubuntu with the Android NDK | 16 KB page alignment checked; ships the NDK's `libc++_shared.so` |
| osx-arm64, osx-x64 | natively on a Mac (Xcode) | flat, relocatable dylibs (macOS 11.0+); osx-x64 cross-compiles on Apple silicon |
| ios-arm64, ios-sim-arm64, maccatalyst-arm64, maccatalyst-x64 | natively on a Mac (Xcode) | one `.framework` per FFmpeg library |

[`platforms.yml`](../platforms.yml) says which platforms build, in which image, and on which CI runner; what differs
per platform is in `platforms/setup/<name>.sh`, used by the one build driver (`platforms/driver.sh`). Images are
built locally the first time, from `images/<name>/Dockerfile` (base images pinned by digest, downloads by sha256).

Each library is cached under `~/.cache/ffmpeg-build` (`FFMPEG_BUILD_CACHE`), keyed by its recipe, version, platform,
toolchain and the libraries it builds against, so a rebuild only compiles what changed. On Linux hosts the build hands the archives
and cache files back to your user when it ends (the container runs as root).

### arm64 Linux on an x64 host

linux-arm64 and linux-musl-arm64 build in arm64 images. On an x64 host Docker runs them under qemu (slowly; CI uses
arm64 runners instead), with qemu 8.1.5: under qemu 9.2 the manylinux image's tar can't create nested folders.
Register it (again after every Docker restart, which forgets it), replacing any arm64 emulator already there
(`--install` fails with "file exists" when qemu-user-static or Docker Desktop registered one, and the old one stays):

    BINFMT=tonistiigi/binfmt:qemu-v8.1.5@sha256:2d2918e86e5327d0661f7083d67a95280b0f7be8f77ed79a8418f81d7d90ce6f
    docker run --privileged --rm $BINFMT --uninstall qemu-aarch64
    docker run --privileged --rm $BINFMT --install arm64
    # Registered? ("enabled" and its interpreter; the qemu version isn't shown)
    docker run --privileged --rm alpine sh -c \
      'mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc; cat /proc/sys/fs/binfmt_misc/qemu-aarch64'
    # A qemu that works: prints ok (qemu 9.2 prints "Cannot mkdir: Invalid argument")
    docker run --rm --platform linux/arm64 quay.io/pypa/manylinux_2_28_aarch64:2026.09.30-1 \
      sh -c 'mkdir -p /a/b/c && tar -cf /t.tar /a && mkdir /x && tar -xf /t.tar -C /x && echo ok'

### Apple

Apple platforms build natively on a Mac with Xcode, not in a container. Install Xcode (and select it with
`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`) and the Homebrew build tools in
[`platforms/setup/apple-brew.txt`](../platforms/setup/apple-brew.txt). Libraries are built into `~/ffmpeg-build-work`
(`FFMPEG_BUILD_WORK`), one build per platform at a time. Checking an osx-x64 build on Apple silicon runs it under
Rosetta (`softwareupdate --install-rosetta --agree-to-license`); without it, the check says so and skips running.

## What's in an archive: `legal/`

Both archives carry `legal/`:

- FFmpeg's `LICENSE.md` and `CREDITS`, and the COPYING texts that govern the build's license;
- `licenses/<library>/` with the files each recipe declares in `license-files:` (a build fails when one is missing),
  plus the patch sets' and shipped platform files' licence texts;
- `LICENSE-NOTICE.txt`: the effective license, and why (what needs version 3, or which TLS library a v2 build uses);
- `SOURCE_OFFER.txt`: where the complete corresponding source is. It names the repository and commit the build came
  from: `FFMPEG_BUILD_SOURCE_REPO` and `FFMPEG_BUILD_SOURCE_REF` when set (CI sets them), else the folder's git remote
  and HEAD.

## What a build was made from

Every source a build fetches is kept in the cache under `sources/` (a tarball as downloaded, a git checkout as
`git archive` of its exact commit with its submodules), and `<name>.sources.json` beside the archives lists FFmpeg,
every library and the patch sets, each with its origin, sha256 and commit. A cached library whose kept source is gone
is built again, so a build can always say exactly what it was made from. A release bundles these into its sources
archive ([releases](releases.md)).

## Comparing with published builds

`scripts/compare-published*.sh` compare a build with a published devenvy/ffmpeg archive: files, configure flags,
registered components, sonames and dependencies (or DLL imports, or Mach-O facts), symlinks and `legal/` names.
Differences that are understood are listed, each with its reason, in `scripts/compare-published.expected` and
`scripts/compare-published-apple.expected`; anything else fails.
