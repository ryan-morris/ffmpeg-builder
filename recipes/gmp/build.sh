#!/usr/bin/env bash
# GMP: GNU Multiple Precision arithmetic (LGPL-3.0-or-later OR GPL-2.0-or-later), static. Ported from devenvy/ffmpeg scripts/deps/gmp.sh.
# Dependency of nettle/GnuTLS. Upstream builds it only for the v2 series, where OpenSSL (Apache-2.0) can't be used,
# and takes the GPLv2+ option so it is compatible with that series.
#
# Source: kernel.org's official GNU mirror first (same signed release files), ftp.gnu.org as fallback for a release
# the mirror has not synced yet (recipe.yml). ftp.gnu.org was unreachable for many hours on 2026-10-06, failing every
# gplv2 cell (the only cells that build GnuTLS's gmp/nettle/libtasn1).
GMP_ARGS=(--prefix="${DEPS_DIR}" --libdir="${DEPS_DIR}/lib"
          --disable-shared --enable-static --with-pic --enable-cxx=no)
[ -n "${CROSS_HOST:-}" ] && GMP_ARGS+=(--host="${CROSS_HOST}")   # cross triple (upstream resolves it in 02_configure)
# GMP 6.3.0's configure "long long reliability test" uses a K&R empty-paren prototype
# `g()` and calls it with args. GCC 15 defaults to C23, where `()` means `(void)`, so that
# call is a hard error and configure aborts with "could not find a working compiler". Pin the
# C standard to gnu17 (K&R semantics) for GMP's configure. Surfaced on Alpine (rolling GCC 15);
# the glibc/manylinux images ship older GCC and are unaffected, but the flag is harmless there.
CFLAGS="${CFLAGS:-} -std=gnu17" ./configure "${GMP_ARGS[@]}"
make -j"${JOBS}"
make install
