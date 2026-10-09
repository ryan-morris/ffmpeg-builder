#!/usr/bin/env bash
# libvpx: VP8 / VP9 video encoder + decoder (BSD-3-Clause), the WebM reference codec, static. Ported from devenvy/ffmpeg scripts/deps/libvpx.sh.
VPX_ARGS=(
  --prefix="${DEPS_DIR}"
  --disable-shared
  --enable-static
  --enable-vp8
  --enable-vp9
  --enable-vp9-highbitdepth
  --disable-examples
  --disable-tools
  --disable-docs
  --disable-unit-tests
  --enable-pic
)
VPX_CROSS=""

case "${BUILD_RID}" in
  linux-armhf)
    VPX_ARGS+=(--target=armv7-linux-gcc --extra-cflags="-mfpu=neon")
    VPX_CROSS="arm-linux-gnueabihf-"
    ;;
  win-x64)
    VPX_ARGS+=(--target=x86_64-win64-gcc --extra-cflags="-static-libgcc")
    VPX_CROSS="${CROSS_PREFIX}-"
    ;;
  win-arm64)
    # libvpx's arm64-win64-gcc target covers any GCC-style driver, llvm-mingw's clang
    # included. This builds a static .a, so the runtime-linkage flags that matter live on
    # FFmpeg's own link — see platform/windows.sh's EXTRA_LDFLAGS.
    VPX_ARGS+=(--target=arm64-win64-gcc)
    VPX_CROSS="${CROSS_PREFIX}-"
    ;;
  android-arm64)
    VPX_ARGS+=(--target=arm64-android-gcc --extra-cflags="-fPIC")
    ;;
  android-x64)
    VPX_ARGS+=(--target=x86_64-android-gcc --extra-cflags="-fPIC")
    ;;
  maccatalyst-arm64|maccatalyst-x64)
    # NOT arm64-darwin-gcc: libvpx treats arm*-darwin-* as iOS and injects
    #   -miphoneos-version-min + the iPhoneOS SDK
    # which clang rejects next to our macabi -target and macOS sysroot:
    #   Requested extra CFLAGS ... not supported by compiler
    # The darwin2x targets are the macOS flavour, and libvpx stops adding
    # -mmacosx-version-min at darwin19 -- so darwin20+ contributes the macOS SDK and NO
    # deployment-target flag to collide with the macabi triple. That keeps the asm enabled,
    # unlike generic-gnu which would silently cost VP8/VP9 SIMD.
    case "${BUILD_RID}" in
      maccatalyst-arm64) VPX_TARGET="arm64-darwin20-gcc"  ;;
      maccatalyst-x64)   VPX_TARGET="x86_64-darwin20-gcc" ;;
    esac
    VPX_ARGS+=(--target="${VPX_TARGET}"
               --extra-cflags="-target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT}")
    ;;
  osx-x64)
    # cross-compiled on Apple silicon: name the target, or libvpx detects the arm64 host
    VPX_ARGS+=(--target=x86_64-darwin20-gcc --extra-cflags="-arch x86_64")
    ;;
  ios-arm64)
    # Device only — libvpx's arm64-darwin-gcc target is iOS-device-specific.
    # The simulator slice is built lean (no libvpx) so it never reaches here.
    VPX_ARGS+=(--target=arm64-darwin-gcc
               --extra-cflags="-arch arm64 ${IOS_MINVER} -isysroot ${IOS_SYSROOT}")
    ;;
esac

if [[ -n "${VPX_CROSS}" ]]; then
  CROSS="${VPX_CROSS}" ./configure "${VPX_ARGS[@]}"
  CROSS="${VPX_CROSS}" make -j"${JOBS}"
  CROSS="${VPX_CROSS}" make install
else
  ./configure "${VPX_ARGS[@]}"
  make -j"${JOBS}"
  make install
fi
