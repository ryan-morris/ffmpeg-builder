#!/usr/bin/env bash
# NVIDIA codec headers (NVENC/NVDEC/CUVID): headers only, installed where FFmpeg's configure finds them.
# Ported from devenvy/ffmpeg scripts/deps/nv-codec.sh.
make install PREFIX="${DEPS_DIR}"
