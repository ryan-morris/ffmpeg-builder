#!/usr/bin/env bash
# libdrm: Direct Rendering Manager userspace library (MIT), static. Ported from devenvy/ffmpeg scripts/deps/libdrm.sh.
# Built as a STATIC library on Linux and linked into FFmpeg (VAAPI needs it, and FFmpeg's --enable-libdrm), so the
# artifact carries no libdrm.so.2 runtime dependency -- it starts on any distro without an install. Builds only the
# core (GPU-vendor helper libs disabled -- the VA driver uses core DRM).
meson_build \
  -Dtests=false -Dman-pages=disabled -Dvalgrind=disabled -Dcairo-tests=disabled \
  -Dintel=disabled -Dradeon=disabled -Damdgpu=disabled -Dnouveau=disabled \
  -Dvmwgfx=disabled -Dvc4=disabled -Detnaviv=disabled -Dfreedreno=disabled \
  -Domap=disabled -Dexynos=disabled -Dtegra=disabled
