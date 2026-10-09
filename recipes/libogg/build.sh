#!/usr/bin/env bash
# libogg: Ogg bitstream container (BSD-3-Clause), static; a build dependency of libvorbis. Ported from devenvy/ffmpeg scripts/deps/libogg.sh.
./autogen.sh
OGG_ARGS=(--prefix="${DEPS_DIR}" --disable-shared --enable-static --with-pic)
[ -n "${CROSS_HOST:-}" ] && OGG_ARGS+=(--host="${CROSS_HOST}")   # cross triple resolved in 02_configure
./configure "${OGG_ARGS[@]}"
make -j"${JOBS}"
make install
