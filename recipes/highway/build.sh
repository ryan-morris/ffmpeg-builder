#!/usr/bin/env bash
# highway: portable SIMD library (Apache-2.0 OR BSD-3-Clause), static. Ported from devenvy/ffmpeg scripts/deps/highway.sh.
# Upstream relies on the BSD-3-Clause option so nothing Apache-2.0 lands in the v2/LGPLv2.1 lane. Build dependency of
# libjxl; not consumed by FFmpeg directly. C++, but not FFmpeg-facing -- the C++ runtime for the libjxl->highway chain
# is added by libjxl's recipe.
cmake_build -DHWY_ENABLE_TESTS=OFF -DHWY_ENABLE_EXAMPLES=OFF -DHWY_ENABLE_CONTRIB=OFF
