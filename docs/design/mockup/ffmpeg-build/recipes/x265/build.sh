#!/usr/bin/env bash
# How to build x265 for $BUILD_RID into $DEPS_DIR - today's scripts/deps/libx265.sh, moved as-is.
# The CLI has already fetched the source at the locked version into $SRC_DIR.
set -euo pipefail
cmake -S "${SRC_DIR}/source" -B build -G Ninja \
  -DCMAKE_INSTALL_PREFIX="${DEPS_DIR}" -DENABLE_SHARED=OFF -DENABLE_CLI=OFF \
  "${CMAKE_CROSS_ARGS[@]}"
cmake --build build --target install
