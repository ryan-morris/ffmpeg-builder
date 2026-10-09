#!/usr/bin/env bash
# AMF headers (MIT), installed where FFmpeg's configure looks for <AMF/core/Factory.h>. Ported from devenvy/ffmpeg
# scripts/deps/amf.sh.
mkdir -p "${DEPS_DIR}/include/AMF"
cp -r amf/public/include/. "${DEPS_DIR}/include/AMF/"
