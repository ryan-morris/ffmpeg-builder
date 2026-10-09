#!/usr/bin/env bash
# libexpat: XML parser for fontconfig (MIT), static. Ported from devenvy/ffmpeg scripts/deps/libexpat.sh.
# expat has a non-standard repo layout (CMakeLists.txt is in expat/ subdir)
CMAKE_SOURCE=expat cmake_build \
  -DEXPAT_BUILD_EXAMPLES=OFF -DEXPAT_BUILD_TESTS=OFF -DEXPAT_BUILD_TOOLS=OFF -DEXPAT_BUILD_DOCS=OFF
