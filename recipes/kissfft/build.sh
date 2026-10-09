#!/usr/bin/env bash
# kissfft: small FFT library (BSD-3-Clause), source only. Ported from devenvy/ffmpeg scripts/deps/kissfft.sh.
# chromaprint's build compiles kissfft's kiss_fft.c + kiss_fftr.c DIRECTLY from source (its FindKissFFT.cmake wants
# KISSFFT_SOURCE_DIR with kiss_fftr.h/.c -- it does NOT link a prebuilt libkissfft), so there is nothing to build.
# Upstream only fetched the tree to ${WORK_DIR}/kissfft; here each library gets its own source folder and only
# DEPS_DIR carries over to the next recipe, so the source files chromaprint needs are copied to
# ${DEPS_DIR}/src/kissfft (outside include/ and lib/, so nothing of it is staged into FFmpeg's archives).
dest="${DEPS_DIR}/src/kissfft"
mkdir -p "${dest}"
cp -p ./*.c ./*.h "${dest}/"
cp -pR COPYING LICENSES "${dest}/"
