#!/usr/bin/env bash
# opencore-amr: AMR-NB en/decode + AMR-WB decode (Apache-2.0 → version3-only), static. Ported from devenvy/ffmpeg scripts/deps/opencore-amr.sh.
AMR_ARGS=(--prefix="${DEPS_DIR}" --disable-shared --enable-static --with-pic)
[ -n "${CROSS_HOST:-}" ] && AMR_ARGS+=(--host="${CROSS_HOST}")   # cross triple resolved in 02_configure
./configure "${AMR_ARGS[@]}"
make -j"${JOBS}"
make install
