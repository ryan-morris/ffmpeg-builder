#!/usr/bin/env bash
# libxml2: XML parser for FFmpeg's DASH demuxer and IMF (MIT), static. Ported from devenvy/ffmpeg scripts/deps/libxml2.sh.
# Minimal static build: no python/icu/lzma/iconv; keep zlib (already built) for DASH.
# LIBXML2_WITH_ICONV defaults ON and needs an iconv cmake package that isn't present on
# the cross toolchains (mingw/NDK) — DASH/IMF parsing doesn't need charset conversion.
cmake_build \
  -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_ICU=OFF -DLIBXML2_WITH_LZMA=OFF \
  -DLIBXML2_WITH_ICONV=OFF \
  -DLIBXML2_WITH_ZLIB=ON -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_PROGRAMS=OFF \
  -DLIBXML2_WITH_HTTP=OFF -DLIBXML2_WITH_MODULES=OFF
