#!/usr/bin/env bash
# libaom: AV1 reference encoder + decoder (BSD-2-Clause, plus the AOMedia patent license), from AOMedia, static.
# Ported from devenvy/ffmpeg scripts/deps/aom.sh.
AOM_EXTRA=()
[[ "${BUILD_RID}" == "linux-armhf" ]] && AOM_EXTRA+=(-DAOM_TARGET_CPU=arm)

# ENABLE_APPS gates aomenc/aomdec and is SEPARATE from ENABLE_EXAMPLES -- aom's
# CMakeLists builds apps/aomenc.c under its own if(ENABLE_APPS). We consume only
# libaom, never the CLI tools, and building them broke musl on v3.15.0:
#   aomenc.c:765: error: implicit declaration of function 'fseeko'
# musl does not declare fseeko/ftello without the large-file feature macros that
# glibc supplies more loosely. Turning the apps off fixes it at the root and skips
# work whose output we discard anyway.
cmake_build \
  -DENABLE_APPS=OFF -DENABLE_EXAMPLES=OFF -DENABLE_TOOLS=OFF -DENABLE_TESTS=OFF -DENABLE_DOCS=OFF \
  ${AOM_EXTRA[@]+"${AOM_EXTRA[@]}"}
