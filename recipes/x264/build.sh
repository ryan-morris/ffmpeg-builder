#!/usr/bin/env bash
# x264: H.264 / AVC software encoder (GPL-2.0-or-later), static; GPL builds only.
# Ported from devenvy/ffmpeg scripts/deps/libx264.sh.
X264_ARGS=(
  --prefix="${DEPS_DIR}"
  --enable-static
  --disable-shared
  --enable-pic
  --disable-cli
)

case "${BUILD_RID}" in
  linux-armhf)
    X264_ARGS+=(--cross-prefix=arm-linux-gnueabihf- --host=arm-linux-gnueabihf)
    ;;
  win-x64)
    X264_ARGS+=(--cross-prefix="${CROSS_PREFIX}-" --host=x86_64-w64-mingw32)
    ;;
  win-arm64)
    X264_ARGS+=(--cross-prefix="${CROSS_PREFIX}-" --host=aarch64-w64-mingw32)
    ;;
  android-arm64)
    X264_ARGS+=(--host=aarch64-linux-android --sysroot="${TOOLCHAIN}/sysroot")
    ;;
  android-x64)
    X264_ARGS+=(--host=x86_64-linux-android --sysroot="${TOOLCHAIN}/sysroot")
    ;;
  maccatalyst-arm64)
    # arm64 assembles x264's .S files with CLANG, so the platform must reach the assembler
    # or its objects are tagged macOS and the macabi link refuses to mix them:
    #   ld: building for macCatalyst, but linking in object file (libx264.a(bitstream-a-8.o))
    # Same cure as ios-arm64; macabi carries arch and deployment target in one -target.
    X264_ARGS+=(--host="${CROSS_HOST}"
                --extra-cflags="-target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT}"
                --extra-asflags="-target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT}"
                --extra-ldflags="-target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT}")
    ;;
  maccatalyst-x64)
    # x86_64 assembles with NASM, not clang, so clang flags must NOT go in --extra-asflags.
    # Passing them made x264's AVX-512 capability probe fail, which it reports as the
    # thoroughly misleading:
    #   Found NASM version 3.02 ... Minimum version is nasm-2.13
    # Nothing to do with the version -- nasm cannot parse -target/-isysroot. NASM emits no
    # platform load command for Mach-O, so its objects link into a macabi binary without the
    # tagging problem the arm64 .S files have.
    X264_ARGS+=(--host="${CROSS_HOST}"
                --extra-cflags="-target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT}"
                --extra-ldflags="-target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT}")
    ;;
  osx-x64)
    # cross-compiled on Apple silicon: x86_64 assembles with NASM (no clang flags in --extra-asflags, as Catalyst x64)
    X264_ARGS+=(--host="${CROSS_HOST}" --extra-cflags="-arch x86_64" --extra-ldflags="-arch x86_64")
    ;;
  ios-arm64)
    # Device only (sim slice is lean). The iOS arch/min-version/sysroot must
    # reach the ASM too (--extra-asflags) or x264's asm objects are tagged
    # 'macOS' and the iOS linker rejects the archive.
    X264_ARGS+=(--host=aarch64-apple-darwin
                --extra-cflags="-arch arm64 ${IOS_MINVER} -isysroot ${IOS_SYSROOT}"
                --extra-asflags="-arch arm64 ${IOS_MINVER} -isysroot ${IOS_SYSROOT}"
                --extra-ldflags="-arch arm64 ${IOS_MINVER} -isysroot ${IOS_SYSROOT}")
    ;;
esac

./configure "${X264_ARGS[@]}"
make -j"${JOBS}"
make install
