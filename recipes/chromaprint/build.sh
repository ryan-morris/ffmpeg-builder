#!/usr/bin/env bash
# chromaprint: audio fingerprinting library (LGPL-2.1-or-later), static. Ported from devenvy/ffmpeg scripts/deps/chromaprint.sh.
# Enables FFmpeg's chromaprint muxer. C++.

# FFT_LIB=kissfft: chromaprint compiles kissfft's kiss_fft.c + kiss_fftr.c from source. Point
# its FindKissFFT.cmake straight at the kissfft source (the kissfft recipe copies it to ${DEPS_DIR}/src/kissfft) via
# -DKISSFFT_SOURCE_DIR (pre-setting the cache var makes its find_path a no-op -- so it works
# identically on native and cross toolchains, avoiding find-root-path/install-layout issues).
# The avfft/avtx FFT backends would need FFmpeg's own libs (circular), so kissfft it is. TOOLS/TESTS off.
cmake_build \
  -DBUILD_TOOLS=OFF -DBUILD_TESTS=OFF \
  -DFFT_LIB=kissfft -DKISSFFT_SOURCE_DIR="${DEPS_DIR}/src/kissfft"

pc="${DEPS_DIR}/lib/pkgconfig/libchromaprint.pc"
# chromaprint is C++ and libchromaprint.pc declares no C++ runtime, so FFmpeg's static --enable-chromaprint link
# needs it added. Upstream appended it to FFmpeg's EXTRA_LIBS (libstdc++ on GNU/mingw, libc++ on Apple/NDK,
# -l:libstdc++.a on musl, -l:libc++.a on win-arm64); a recipe can't touch FFmpeg's link line, so it goes into the .pc,
# which FFmpeg's configure tries first (check_pkg_config libchromaprint, then a plain -lchromaprint).
# -lm as well (not upstream's): chromaprint's bundled FFmpeg resampler (resample2.c) calls sin() and the .pc declares
# nothing. FFmpeg's own link carries -lm anyway, but a plain `pkg-config --static` link fails without it.
case "${BUILD_RID}" in
  osx-*|ios-*|maccatalyst-*|android-*) CXX_RT="-lc++" ;;
  win-arm64)    CXX_RT="-l:libc++.a" ;;
  linux-musl-*) CXX_RT="-l:libstdc++.a" ;;
  *)            CXX_RT="-lstdc++" ;;
esac
if grep -q '^Libs\.private:' "${pc}"; then
  sed -i "s#^Libs\.private:.*#& ${CXX_RT} -lm#" "${pc}"
else
  echo "Libs.private: ${CXX_RT} -lm" >>"${pc}"
fi

# On Windows/mingw, chromaprint.h decorates its API with __declspec(dllimport) unless
# CHROMAPRINT_NODLL is defined -- but we build a STATIC libchromaprint.a, whose symbols are
# undecorated. Without this define, FFmpeg's configure probe (and the chromaprint-muxer
# compile) look for __imp_chromaprint_* and fail with "chromaprint not found". The macro is
# guarded by _WIN32/_WIN64 in the header, so this define is an inert no-op on other platforms.
# Upstream put it in FFmpeg's EXTRA_CFLAGS; here it goes into the .pc's Cflags, which FFmpeg adds for the probe and
# the muxer.
grep -q -- '-DCHROMAPRINT_NODLL' "${pc}" || sed -i 's#^Cflags:.*#& -DCHROMAPRINT_NODLL#' "${pc}"
cat "${pc}"
