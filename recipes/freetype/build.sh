#!/usr/bin/env bash
# FreeType: font rasterization for the drawtext filter (FTL OR GPL-2.0-or-later), static. Ported from devenvy/ffmpeg scripts/deps/freetype.sh.
cmake_build -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BZIP2=ON -DFT_DISABLE_BROTLI=ON
