#!/usr/bin/env bash
# brotli: general-purpose compression (MIT), static. Ported from devenvy/ffmpeg scripts/deps/brotli.sh.
# Build dependency of libjxl; not consumed by FFmpeg directly. Installs libbrotli{common,enc,dec} + pkg-config into
# DEPS_DIR for libjxl's JPEGXL_FORCE_SYSTEM_BROTLI.

# BROTLI_BUILD_TOOLS=OFF: skip the `brotli` CLI executable -- we only need the libs, and its
# install(TARGETS brotli RUNTIME ...) fails on iOS (iOS executables need a BUNDLE destination).
cmake_build -DBROTLI_DISABLE_TESTS=ON -DBROTLI_BUNDLED_MODE=OFF -DBROTLI_BUILD_TOOLS=OFF
