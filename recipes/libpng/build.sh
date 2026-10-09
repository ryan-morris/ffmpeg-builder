#!/usr/bin/env bash
# libpng: PNG image support for FreeType (libpng-2.0), static. Ported from devenvy/ffmpeg scripts/deps/libpng.sh.
cmake_build -DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_TESTS=OFF -DPNG_TOOLS=OFF
