#!/usr/bin/env bash
# soxr: high-quality audio resampling library (LGPL-2.1-or-later), static. Ported from devenvy/ffmpeg scripts/deps/soxr.sh.
cmake_build -DWITH_OPENMP=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DWITH_LSR_BINDINGS=OFF

# FFmpeg links libsoxr via a hardcoded -lsoxr (it does not use soxr's pkg-config), so soxr's libm
# dependency must be added to FFmpeg's own link explicitly: upstream's EXTRA_LIBS="... -lm" is
# `--extra-libs=-lm` in recipe.yml `configure:`.
