#!/usr/bin/env bash
# OpenSSL 3.x: TLS/https backend for FFmpeg (Apache-2.0), static. Ported from devenvy/ffmpeg scripts/deps/openssl.sh.
# Built only where the OS gives FFmpeg no usable TLS: Linux and Android (and Mac Catalyst, see below). Windows uses
# SChannel and Apple uses SecureTransport, both OS-native. Apache-2.0 is GPL/LGPL-compatible only under version 3, so
# FFmpeg's --enable-version3 is a license matter (the profile's license), never this recipe's.

# OpenSSL drives its own toolchain (Configure target + CROSS_COMPILE / NDK env), not autotools --host. Upstream ran
# this in a subshell so the env changes never leaked into the deps built after it; here every recipe already runs in
# its own shell.
# Static libs, PIC (they link into FFmpeg's shared objects), no apps/tests/docs.
OSSL_OPTS=(no-shared no-apps no-tests no-docs -fPIC
           --prefix="${DEPS_DIR}" --openssldir="${DEPS_DIR}/ssl" --libdir=lib)
case "${BUILD_RID}" in
  linux-x64|linux-musl-x64) OSSL_TARGET=linux-x86_64 ;;
  linux-arm64|linux-musl-arm64) OSSL_TARGET=linux-aarch64 ;;
  linux-armhf)              OSSL_TARGET=linux-armv4; export CROSS_COMPILE=arm-linux-gnueabihf- ;;
  android-arm64)
    OSSL_TARGET=android-arm64
    # Let OpenSSL's android target pick the NDK clang via PATH; our exported
    # CC/AR/etc. (the aarch64 wrappers) would confuse its own detection.
    unset CC CXX AR RANLIB NM STRIP
    export ANDROID_NDK_ROOT="${ANDROID_NDK_HOME}"
    export PATH="${TOOLCHAIN}/bin:${PATH}"
    OSSL_OPTS+=("-D__ANDROID_API__=${API}")
    ;;
  android-x64)
    OSSL_TARGET=android-x86_64
    # Let OpenSSL's android target pick the NDK clang via PATH; our exported
    # CC/AR/etc. wrappers would confuse its own detection.
    unset CC CXX AR RANLIB NM STRIP
    export ANDROID_NDK_ROOT="${ANDROID_NDK_HOME}"
    export PATH="${TOOLCHAIN}/bin:${PATH}"
    OSSL_OPTS+=("-D__ANDROID_API__=${API}")
    ;;
  maccatalyst-arm64|maccatalyst-x64)
    # Catalyst is the only Apple RID that builds OpenSSL: macOS and iOS use
    # SecureTransport, but the SDK marks that unavailable on macabi (see platform/apple.sh),
    # so Catalyst takes the Linux/Android TLS ladder instead.
    #
    # OpenSSL has no macabi target, and it does not need one: the darwin64 targets select the
    # arch and assembler, while the platform comes from the -target triple already exported in
    # CFLAGS/LDFLAGS. OSSL_OPTS carries it explicitly too, because Configure builds its own
    # compile lines rather than simply inheriting CFLAGS.
    case "${BUILD_RID}" in
      maccatalyst-arm64) OSSL_TARGET=darwin64-arm64-cc  ;;
      maccatalyst-x64)   OSSL_TARGET=darwin64-x86_64-cc ;;
    esac
    # The flags go in CC, NOT in Configure's argument list. Configure treats any argument that
    # does not start with "-" as a TARGET name, so the two-token forms "-target <triple>" and
    # "-isysroot <path>" had their second halves parsed as extra targets:
    #   target already defined - darwin64-arm64-cc (offending arg: arm64-apple-ios14.0-macabi)
    # Folding them into CC sidesteps the argument parser entirely and is what Configure uses
    # to build every compile line.
    export CC="${CC} -target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT}"
    ;;
  *) echo "OpenSSL: unexpected RID ${BUILD_RID}" >&2; exit 1 ;;
esac
./Configure "${OSSL_TARGET}" "${OSSL_OPTS[@]}"
make -j"${JOBS}"
make install_sw   # libs + headers + pkg-config, no man pages
