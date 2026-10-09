#!/usr/bin/env bash
# libopus, static. Ported from devenvy/ffmpeg scripts/deps/opus.sh.
EXTRA=()
# opus's CMake enables ARM runtime CPU detection on any Windows, but celt/arm/armcpu.c only implements it for
# MSVC; llvm-mingw then hits its own "no CPU detection method available" #error. Portable C on win-arm64.
[[ "${BUILD_RID}" == "win-arm64" ]] && EXTRA+=(-DOPUS_DISABLE_INTRINSICS=ON)
cmake_build -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF ${EXTRA[@]+"${EXTRA[@]}"}
