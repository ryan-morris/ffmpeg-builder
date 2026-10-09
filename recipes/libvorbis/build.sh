#!/usr/bin/env bash
# libvorbis: Vorbis audio encoder + decoder (BSD-3-Clause), static; requires libogg. Ported from devenvy/ffmpeg scripts/deps/libvorbis.sh.
./autogen.sh
VORBIS_ARGS=(--prefix="${DEPS_DIR}" --disable-shared --enable-static --with-ogg="${DEPS_DIR}" --with-pic)
[ -n "${CROSS_HOST:-}" ] && VORBIS_ARGS+=(--host="${CROSS_HOST}")   # cross triple resolved in 02_configure
./configure "${VORBIS_ARGS[@]}"
# Build and install the LIBRARIES ONLY (same idiom as kvazaar.sh). libvorbis's
# configure injects -force_cpusubtype_ALL into CFLAGS on Darwin — an obsolete flag
# that modern (Xcode 26+) ld rejects at LINK time — so building any of libvorbis's
# example/analysis executables breaks the macOS/iOS builds. The .a archives never
# invoke ld (they are ar'd), so we build just the three .la targets and install them
# + headers + pkg-config, skipping every executable. Also faster on all platforms.
# (A recursive `SUBDIRS=` override can't be used: make propagates it into the
# sub-makes, which then try to enter subdirs that don't exist there and fail.)
make -j"${JOBS}" -C lib libvorbis.la libvorbisenc.la libvorbisfile.la
make -C lib install-libLTLIBRARIES
make -C include install
make install-pkgconfigDATA
