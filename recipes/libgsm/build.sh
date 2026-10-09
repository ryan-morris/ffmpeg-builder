#!/usr/bin/env bash
# libgsm: GSM 06.10 full-rate speech codec (TU-Berlin-2.0), static. Ported from devenvy/ffmpeg scripts/deps/libgsm.sh.
# FFmpeg finds it via `check_lib libgsm gsm.h gsm_create -lgsm` (no pkg-config).
#
# NON-STANDARD PACKAGING (the tricky one): libgsm ships a hand-written top-level
# Makefile with NO ./configure and NO `make install` target. Its Makefile hardcodes the
# host toolchain (CC = gcc, AR = ar, RANLIB = ranlib) and does not honour a --host cross
# triple, so we override those make variables on the command line to inject the cross
# toolchain + -fPIC, build ONLY the static lib target (lib/libgsm.a — skipping the toast
# CLI tools, which need extra headers), then MANUALLY copy the lib + header into DEPS_DIR.
#
# LIKELY TWEAK POINT: the make-variable names below (CC/AR/RANLIB and the lib/libgsm.a
# target) follow libgsm-1.0.22's Makefile. If a version bump renames them, this is the
# line to adjust. We deliberately do NOT pass GSM_INSTALL_ROOT to `make install` (the
# Makefile's install target is unreliable / assumes system paths) — we install by hand.
#
# The tarball's top dir is NOT gsm-${ver} — libgsm names it by version+patchlevel
# (gsm-1.0.22.tar.gz extracts to gsm-1.0-pl22/). The engine strips the top folder, so the
# source is already here.

# Build just the static archive. Override the hardcoded toolchain (the Makefile's own
# CC/AR/RANLIB assume a native gcc) with our cross toolchain + PIC/EXTRA_CFLAGS. libgsm's
# Makefile uses `AR ... $(ARFLAGS)` with ARFLAGS defaulting to `cr`, so we keep AR as the
# archiver alone and pass the flags via ARFLAGS to stay compatible.
#
# Toolchain resolution: prefer an exported CC/AR/RANLIB (win/apple/android set these), else fall
# back to the CROSS_HOST triple, else the plain native tool. This matters for linux-armhf — the
# ONE cross target that never exports CC (its autotools deps cross via --host instead): without
# the CROSS_HOST fallback, ${CC:-cc} would silently build a NATIVE x86-64 libgsm.a that FFmpeg's
# armhf link then rejects ("libgsm not found"). Native linux/musl leave CROSS_HOST empty → gcc.
gsm_cc="${CC:-${CROSS_HOST:+${CROSS_HOST}-}gcc}"
gsm_ar="${AR:-${CROSS_HOST:+${CROSS_HOST}-}ar}"
gsm_ranlib="${RANLIB:-${CROSS_HOST:+${CROSS_HOST}-}ranlib}"
make -j"${JOBS}" lib/libgsm.a \
  CC="${gsm_cc} -fPIC ${EXTRA_CFLAGS:-}" \
  AR="${gsm_ar}" ARFLAGS="cr" \
  RANLIB="${gsm_ranlib}"

# Manual install — the Makefile has no `install` target we can rely on.
mkdir -p "${DEPS_DIR}/lib" "${DEPS_DIR}/include"
cp -a lib/libgsm.a "${DEPS_DIR}/lib/"
cp -a inc/gsm.h "${DEPS_DIR}/include/"

# FFmpeg's `check_lib libgsm gsm.h gsm_create -lgsm` must find gsm.h in ${DEPS_DIR}/include. Upstream
# re-added -I${DEPS_DIR}/include to EXTRA_CFLAGS here; the engine's base configure already passes
# --extra-cflags=-I$DEPS_DIR/include, and a recipe never touches FFmpeg's flags.
