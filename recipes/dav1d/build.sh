#!/usr/bin/env bash
# dav1d: fast AV1 decoder, static. Ported from devenvy/ffmpeg scripts/deps/dav1d.sh.
meson_build -Denable_tools=false -Denable_tests=false
