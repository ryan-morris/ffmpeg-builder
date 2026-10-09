#!/usr/bin/env bash
# libtasn1: ASN.1 parsing (LGPL-2.1-or-later), static. Ported from devenvy/ffmpeg scripts/deps/libtasn1.sh.
# Dependency of GnuTLS; upstream builds it only for the v2 series.
#
# Like GnuTLS/nettle, libtasn1's git tag has no pre-generated ./configure (GNU release tarballs are bootstrapped
# before upload; a raw git checkout is not) -- so it stays a tarball fetch: kernel.org's GNU mirror first,
# ftp.gnu.org as fallback (see gmp's build.sh).
TASN1_ARGS=(--prefix="${DEPS_DIR}" --libdir="${DEPS_DIR}/lib"
            --disable-shared --enable-static --with-pic --disable-doc)
[ -n "${CROSS_HOST:-}" ] && TASN1_ARGS+=(--host="${CROSS_HOST}")   # cross triple (upstream resolves it in 02_configure)
./configure "${TASN1_ARGS[@]}"
make -j"${JOBS}"
make install
