#!/usr/bin/env bash
# harfbuzz: text shaping engine, a libass dependency, uses freetype (MIT-Modern-Variant), static. Ported from devenvy/ffmpeg scripts/deps/harfbuzz.sh.
meson_build \
  -Dtests=disabled -Ddocs=disabled -Dutilities=disabled \
  -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled \
  -Dcairo=disabled -Dicu=disabled -Dchafa=disabled
