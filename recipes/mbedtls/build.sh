#!/usr/bin/env bash
# mbedtls: compact TLS/crypto library (Apache-2.0 OR GPL-2.0-or-later), static. Ported from devenvy/ffmpeg scripts/deps/mbedtls.sh.
# This is NOT FFmpeg's own TLS backend: OpenSSL (v3) / GnuTLS (gpl-2) keep that, because they auto-load the system
# CA store and tls_mbedtls.c does not. mbedTLS here is the shared *transport* crypto that both SRT (USE_ENCLIB=mbedtls)
# and librist (use_mbedtls) consume on the v3 cells -- librist can't use OpenSSL at all, so the transports need their
# own crypto lib regardless of FFmpeg's TLS.
#
# The source is the release tarball (mbedtls-<ver>.tar.bz2), not the git tag: the git tag carries a 'framework'
# submodule (a bare pointer -- needs a submodule init), whereas the release tarball bundles the framework in-tree.
# Both ship the auto-generated PSA-crypto files pre-generated, so either way there's no Python (jinja2/jsonschema)
# needed -- the tarball just avoids the submodule dance.

# Static libs only; no tests/programs/fuzzers. Installs libmbed{tls,x509,crypto}.a + headers + pkg-config (.pc) +
# cmake package config into DEPS_DIR. BOTH consumers use the CMake package, not pkg-config: SRT via
# find_package(MbedTLS), and librist via
#   dependency('MbedTLS', method: 'cmake', modules: ['MbedTLS::mbedcrypto'])
# (upstream's comment once said librist used pkg-config, which is why nothing noticed that librist was not finding
# this build at all -- see the cmake_prefix_path note in librist's build.sh).
cmake_build \
  -DUSE_SHARED_MBEDTLS_LIBRARY=OFF \
  -DUSE_STATIC_MBEDTLS_LIBRARY=ON \
  -DENABLE_TESTING=OFF \
  -DENABLE_PROGRAMS=OFF

# Upstream also re-adds mbedTLS as -l libs at the END of FFmpeg's link (EXTRA_LIBS="-lmbedtls -lmbedx509
# -lmbedcrypto", plus -lbcrypt on Windows). Both transports leave their mbedTLS symbols unresolved otherwise: srt.pc
# lists mbedTLS as ABSOLUTE .a paths, which FFmpeg classifies as input objects and places BEFORE -lsrt (so libsrt's
# cryspr-mbedtls.o refs are already discarded -> undefined), and librist.pc omits mbedTLS entirely. A recipe can't
# touch FFmpeg's link line, so the srt and librist recipes put those -l libs into their own .pc files instead
# (after -lsrt / -lrist, in tls -> x509 -> crypto order). See recipes/srt/build.sh and recipes/librist/build.sh.
