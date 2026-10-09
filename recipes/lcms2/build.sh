#!/usr/bin/env bash
# lcms2 (Little CMS 2): ICC color-management engine (MIT core), static. Ported from devenvy/ffmpeg scripts/deps/lcms2.sh.
# Enables FFmpeg's ICC profile support (iccdetect/iccgen filters) and is a build dependency of
# libjxl and libplacebo.
#
# The fastfloat + threaded meson plugins are GPL-3.0 (upstream: "use only if GPL
# 3.0 is acceptable"); left at their default (off) so only the MIT core ships,
# keeping every cell — including the v2/LGPL lane — license-clean.
meson_build \
  -Djpeg=disabled -Dtiff=disabled -Dtests=disabled \
  -Dutils=false -Dversionedlibs=false
