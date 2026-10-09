#!/usr/bin/env bash
# fribidi: Unicode bidirectional text algorithm, a libass dependency (LGPL-2.1-or-later), static. Ported from devenvy/ffmpeg scripts/deps/fribidi.sh.
meson_build -Dtests=false -Ddocs=false -Dbin=false
