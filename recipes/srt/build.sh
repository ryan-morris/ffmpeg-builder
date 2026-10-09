#!/usr/bin/env bash
# libsrt: Secure Reliable Transport (MPL-2.0), static. Ported from devenvy/ffmpeg scripts/deps/libsrt.sh.
# Built and linked STATICALLY (ENABLE_STATIC=ON, ENABLE_SHARED=OFF) like every other dependency here; MPL-2.0 is
# file-level copyleft, so static linking is fine on every cell provided the library's own sources stay available.
# Enables FFmpeg's srt:// protocol. C++. FFmpeg finds it via pkg-config `srt`.

# Encryption backend. Upstream chose it per license cell (SRT_ENCLIB, set in 04_select_license): mbedtls on v3,
# off on the nocrypto cells (lgpl-2 everywhere + gpl-2 Win/Apple). Here mbedTLS is optional (recipe.yml uses:):
# the engine puts it in DEPS_DIR wherever the build's license allows it (all but lgplv2), and the recipe encrypts
# when it is there.
#
# gnutls is deliberately NOT picked even when GnuTLS is in DEPS_DIR. Upstream's 04_select_license: SRT's gnutls
# enclib compiles against nettle's removed legacy AES API (struct aes_ctx / aes_encrypt, gone since nettle 3.4), so
# the gpl-2 cells ship SRT without crypto. The arm stays below for when that changes.
SRT_ENCLIB=off
[[ -f "${DEPS_DIR}/lib/libmbedcrypto.a" ]] && SRT_ENCLIB=mbedtls

# Static lib, no apps/tests. Encryption per the crypto map; nocrypto cells configure cleanly
# with ENABLE_ENCRYPTION=OFF (SRT still transports, just without AES).
SRT_ARGS=(-DENABLE_APPS=OFF -DENABLE_SHARED=OFF -DENABLE_STATIC=ON)
case "${SRT_ENCLIB}" in
  mbedtls|gnutls) SRT_ARGS+=(-DENABLE_ENCRYPTION=ON -DUSE_ENCLIB="${SRT_ENCLIB}") ;;
  *)              SRT_ARGS+=(-DENABLE_ENCRYPTION=OFF) ;;
esac
# On the Android NDK toolchain, find_library only searches CMAKE_FIND_ROOT_PATH (pointed at the
# NDK sysroot), so SRT's find_package(MbedTLS) can't see our mbedTLS in DEPS_DIR. Add DEPS_DIR to
# the root path -- the NDK toolchain appends its own sysroot, so both are searched. (Other RIDs set
# CMAKE_FIND_ROOT_PATH=DEPS_DIR in their toolchain file already; only the NDK's overrides it.)
[[ "${BUILD_RID}" == android-* && "${SRT_ENCLIB}" == "mbedtls" ]] && SRT_ARGS+=(-DCMAKE_FIND_ROOT_PATH="${DEPS_DIR}")
cmake_build "${SRT_ARGS[@]}"

# -DENABLE_ENCRYPTION=ON is a REQUEST. If find_package(MbedTLS)/GnuTLS resolves to nothing usable
# the crypto layer can end up out of the archive while the build still succeeds and the srt://
# protocol still works -- unencrypted. FFmpeg's -passphrase/-pbkeylen options are NO evidence
# either way: they live in FFmpeg's own libsrt wrapper and are present regardless. The honest
# marker is libsrt's HaiCrypt layer, which is compiled ONLY with ENABLE_ENCRYPTION=ON (verified
# present in the published linux-x64 artifact, which does have encryption).
if [[ "${SRT_ENCLIB}" != "off" ]]; then
  # Locate the archive rather than hardcoding one name: cmake_build installs into
  # ${DEPS_DIR}/lib, but the exact filename is SRT's to choose. A wrong guess here would fail a
  # perfectly good build, which is the failure mode this branch keeps having to correct.
  _srt_a="$(find "${DEPS_DIR}/lib" -maxdepth 1 -name 'libsrt*.a' -print -quit 2>/dev/null || true)"
  if [[ -z "${_srt_a}" ]]; then
    echo "ERROR: libsrt built but no libsrt*.a found under ${DEPS_DIR}/lib -" >&2
    echo "  cannot verify that encryption was compiled in." >&2
    ls -1 "${DEPS_DIR}/lib" 2>/dev/null | sed 's/^/    /' >&2
    exit 1
  fi
  # grep -a, not strings(1): this runs in the BUILD environment, where binutils is not something
  # the package lists guarantee, and grep is. -a treats the archive as text so the match works on
  # a binary; POSIX grep and BusyBox grep both support it.
  if ! grep -aqi haicrypt "${_srt_a}"; then
    echo "ERROR: libsrt was configured with ENABLE_ENCRYPTION=ON and USE_ENCLIB=${SRT_ENCLIB}," >&2
    echo "  but its HaiCrypt layer is not in the archive - srt:// would transport in the clear." >&2
    echo "  Most likely ${SRT_ENCLIB} was not found at configure time." >&2
    exit 1
  fi
  echo "libsrt: encryption verified present (HaiCrypt, enclib=${SRT_ENCLIB})."
fi

pc="${DEPS_DIR}/lib/pkgconfig/srt.pc"
# srt.pc lists mbedTLS as ABSOLUTE .a paths in Libs.private, which FFmpeg's configure classifies as input objects and
# places BEFORE -lsrt, so libsrt's cryspr-mbedtls.o refs are already discarded -> undefined. Upstream re-added
# "-lmbedtls -lmbedx509 -lmbedcrypto" at the END of FFmpeg's link (EXTRA_LIBS, from mbedtls.sh); a recipe can't touch
# FFmpeg's link line, so the same -l libs replace the .a paths here, after -lsrt. Order high-level -> low so the
# inter-mbedTLS deps resolve left-to-right (tls -> x509 -> crypto). On Windows, mbedcrypto's entropy_poll.c calls
# BCryptGenRandom (bcrypt.dll), so -lbcrypt must come AFTER -lmbedcrypto to resolve.
if [[ "${SRT_ENCLIB}" == "mbedtls" ]]; then
  MBED_LIBS="-lmbedtls -lmbedx509 -lmbedcrypto"
  [[ "${BUILD_RID}" == win-* ]] && MBED_LIBS="${MBED_LIBS} -lbcrypt"
  sed -i -E -e 's#[^[:space:]]*/libmbed(tls|x509|crypto)\.a##g' -e "s#^Libs\.private:#Libs.private: ${MBED_LIBS}#" "${pc}"
fi
# srt.pc over-captures the compiler's implicit link line into Libs.private (-lgcc_s -lgcc -lc ...). Upstream's
# 07_build_ffmpeg strips -lgcc_s from every .pc on win-* and linux-musl-*: on mingw it pulls the SHARED unwinder
# (libgcc_s_seh-1.dll) and collides with -static-libgcc's libgcc_eh ("multiple definition of _Unwind_Resume"); on musl
# it defeats -static-libgcc (versioned _Unwind_* references that no archive can satisfy). srt.pc is the offender, so
# it is stripped here.
case "${BUILD_RID}" in
  win-*|linux-musl-*) sed -i -e 's/ -lgcc_s / /g' -e 's/ -lgcc_s$//' "${pc}" ;;
esac
# libsrt is C++. srt.pc's Libs.private already lists the C++ runtime on GNU toolchains; upstream also appended it to
# FFmpeg's EXTRA_LIBS (libstdc++ on GNU/mingw, libc++ on Apple/NDK, -l:libstdc++.a on musl, -l:libc++.a on
# win-arm64) to keep the ordering right for FFmpeg's configure link tests. Here it goes at the end of Libs.private.
case "${BUILD_RID}" in
  osx-*|ios-*|maccatalyst-*|android-*) CXX_RT="-lc++" ;;
  win-arm64)    CXX_RT="-l:libc++.a" ;;
  linux-musl-*) CXX_RT="-l:libstdc++.a" ;;
  *)            CXX_RT="-lstdc++" ;;
esac
grep -qE "^Libs\.private:.*[[:space:]]${CXX_RT//+/\\+}([[:space:]]|$)" "${pc}" || sed -i "s#^Libs\.private:.*#& ${CXX_RT}#" "${pc}"
echo "libsrt (SRT transport, enclib=${SRT_ENCLIB}); srt.pc:"
cat "${pc}"
