#!/usr/bin/env bash
# speex: Speex speech codec (BSD-3-Clause / Xiph), static; FFmpeg's libspeex de/encoder. Ported from devenvy/ffmpeg scripts/deps/speex.sh.
# The git tree ships no generated configure — regenerate it (autoconf/automake/libtool are in
# the build env). Xiph's autogen.sh runs autoreconf; run it non-interactively.
./autogen.sh >/dev/null 2>&1 || autoreconf -fi
SPX_ARGS=(--prefix="${DEPS_DIR}" --disable-shared --enable-static --with-pic
          --disable-binaries)   # libspeex only; skip speexenc/speexdec CLIs
[ -n "${CROSS_HOST:-}" ] && SPX_ARGS+=(--host="${CROSS_HOST}")
./configure "${SPX_ARGS[@]}"
make -j"${JOBS}"
make install
