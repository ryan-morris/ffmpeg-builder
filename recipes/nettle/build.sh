#!/usr/bin/env bash
# nettle: low-level crypto library (LGPL-3.0-or-later OR GPL-2.0-or-later), static. Ported from devenvy/ffmpeg scripts/deps/nettle.sh.
# Provides libnettle + libhogweed (public-key, needs GMP). Dependency of GnuTLS; upstream builds it only for the v2
# series and takes the GPLv2+ option to keep it v2-compatible.
#
# Like GnuTLS, nettle's git tag has no pre-generated ./configure (GNU release tarballs are bootstrapped before
# upload; a raw git checkout is not) -- so it stays a tarball fetch: kernel.org's GNU mirror first, ftp.gnu.org as
# fallback (see gmp's build.sh).

# Finds GMP (built just before) via CPPFLAGS/LDFLAGS. nettle 4.0 dropped the older
# --with-include-path/--with-lib-path options (silently ignored -> GMP not found -> no
# libhogweed -> GnuTLS configure fails); the standard autoconf vars work on both 3.x and
# 4.x. PIC comes from the exported CFLAGS (-fPIC on the manylinux builds; default elsewhere).
NETTLE_ARGS=(--prefix="${DEPS_DIR}" --libdir="${DEPS_DIR}/lib"
             --disable-shared --enable-static --disable-documentation)
[ -n "${CROSS_HOST:-}" ] && NETTLE_ARGS+=(--host="${CROSS_HOST}")   # cross triple (upstream resolves it in 02_configure)
# nettle's bundled getopt.c/getopt.h use K&R empty-paren prototypes (getopt()/getenv()).
# GCC 15 defaults to C23 where `()` == `(void)`, turning the real calls into hard errors
# ("too many arguments to function 'getenv'"). Pin the C standard to gnu17. Same GCC-15/C23
# issue as GMP; surfaced on Alpine (rolling GCC). Harmless on the older glibc/manylinux GCC.
CFLAGS="${CFLAGS:-} -std=gnu17" \
  CPPFLAGS="-I${DEPS_DIR}/include ${CPPFLAGS:-}" \
  LDFLAGS="-L${DEPS_DIR}/lib ${LDFLAGS:-}" \
  ./configure "${NETTLE_ARGS[@]}"
make -j"${JOBS}"
make install
