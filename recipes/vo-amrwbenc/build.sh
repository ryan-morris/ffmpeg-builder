#!/usr/bin/env bash
# vo-amrwbenc: AMR-WB encoder (Apache-2.0 → version3-only), static. Ported from devenvy/ffmpeg scripts/deps/vo-amrwbenc.sh.
VOAMR_ARGS=(--prefix="${DEPS_DIR}" --disable-shared --enable-static --with-pic)
[ -n "${CROSS_HOST:-}" ] && VOAMR_ARGS+=(--host="${CROSS_HOST}")   # cross triple resolved in 02_configure
./configure "${VOAMR_ARGS[@]}"
make -j"${JOBS}"
make install
