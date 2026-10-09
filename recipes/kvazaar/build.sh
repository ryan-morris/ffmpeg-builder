#!/usr/bin/env bash
# kvazaar: H.265/HEVC software encoder (BSD-3-Clause), static. The permissive H.265 encoder for the LGPL builds
# (x265 is GPL) — the H.265 counterpart to OpenH264, and a software fallback where hardware HEVC encode is
# unavailable. Ported from devenvy/ffmpeg scripts/deps/kvazaar.sh.
./autogen.sh
KVZ_ARGS=(--prefix="${DEPS_DIR}" --libdir="${DEPS_DIR}/lib"
          --disable-shared --enable-static --with-pic)
[ -n "${CROSS_HOST:-}" ] && KVZ_ARGS+=(--host="${CROSS_HOST}")   # cross triple resolved in 02_configure
./configure "${KVZ_ARGS[@]}"
# Build and install the LIBRARY only — FFmpeg does not need the kvazaar CLI, and
# skipping it avoids the CLI's hardcoded -lrt (kvazaar adds it for any linux* host,
# which includes Android, where librt does not exist).
make -j"${JOBS}" -C src libkvazaar.la
make -C src install-libLTLIBRARIES install-includeHEADERS
# Install pkg-config, dropping -lrt from Libs.private: clock_gettime is in libc on
# every target we build (modern glibc/musl/bionic/darwin), and librt is absent on
# Android — so -lrt would break FFmpeg's static pkg-config link there.
mkdir -p "${DEPS_DIR}/lib/pkgconfig"
sed 's/-lrt//g' src/kvazaar.pc > "${DEPS_DIR}/lib/pkgconfig/kvazaar.pc"
# On Windows, kvazaar.h declares its API __declspec(dllimport) by default, so a
# consumer emits a reference to the DLL import stub (__imp_kvz_api_get) and fails
# to link the STATIC libkvazaar.a, which exports the plain symbol. FFmpeg surfaces
# this as "kvazaar >= 2.0.0 not found using pkg-config" (its configure link test
# fails, not the version check). Advertise KVZ_STATIC_LIB via the .pc Cflags so
# both that test and the FFmpeg compile (which uses pkg-config --cflags kvazaar)
# see the static declarations. Windows-only: the dllimport path is _WIN32-gated,
# which is why only the win-x64 build hit this.
if [[ "${BUILD_RID}" == win-* ]]; then
  sed -i 's|^Cflags:.*|& -DKVZ_STATIC_LIB|' "${DEPS_DIR}/lib/pkgconfig/kvazaar.pc"
fi
