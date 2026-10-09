#!/usr/bin/env bash
# zlib, static. Ported from devenvy/ffmpeg scripts/deps/zlib.sh (its own configure script, not CMake). Cross builds
# name the target with CHOST, so zlib's configure takes the target's path (mingw on Windows) rather than the build
# host's; CC/AR/RANLIB come from the platform setup.
if [ -n "${CROSS_HOST:-}" ]; then
  CHOST="${CROSS_HOST}" ./configure --prefix="${DEPS_DIR}" --static
else
  ./configure --prefix="${DEPS_DIR}" --static
fi
make -j"${JOBS}"
make install
