#!/usr/bin/env bash
# SVT-AV1: fast, production-grade AV1 encoder (BSD-3-Clause-Clear), from AOMedia, static.
# Ported from devenvy/ffmpeg scripts/deps/svtav1.sh.
SVT_EXTRA=()
[[ "${BUILD_RID}" == "win-x64" ]] && SVT_EXTRA+=(
  -DCMAKE_C_FLAGS="-static-libgcc -O2"
  -DCMAKE_CXX_FLAGS="-static-libgcc -static-libstdc++ -O2"
)

cmake_build \
  -DBUILD_APPS=OFF -DBUILD_DEC=OFF -DBUILD_TESTING=OFF \
  ${SVT_EXTRA[@]+"${SVT_EXTRA[@]}"}
