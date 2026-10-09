#!/usr/bin/env bash
# librist: Reliable Internet Stream Transport (BSD-2-Clause), static. Ported from devenvy/ffmpeg scripts/deps/librist.sh.
# Enables FFmpeg's rist:// protocol. librist CANNOT use OpenSSL -- only mbedTLS or GnuTLS/nettle -- which is the
# reason the v3 cells carry an external mbedTLS at all. Vendored lz4 + cJSON (builtin_*) keep it self-contained; the
# external mbedTLS we built is used (builtin_mbedtls=false). meson.

# Encryption backend. Upstream chose it per license cell (RIST_CRYPTO, set in 04_select_license): mbedtls on v3,
# none on the nocrypto cells. Here mbedTLS is optional (recipe.yml uses:): the engine puts it in DEPS_DIR wherever
# the build's license allows it (all but lgplv2), and the recipe encrypts when it is there.
#
# gnutls is deliberately NOT picked even when GnuTLS is in DEPS_DIR. Upstream's 04_select_license: librist's gnutls
# EAP/SRP path won't compile (its verifier types are mbedTLS-only), so the gpl-2 cells ship librist without crypto.
# The arm stays below for when that changes.
RIST_CRYPTO=none
[[ -f "${DEPS_DIR}/lib/libmbedcrypto.a" ]] && RIST_CRYPTO=mbedtls

# Vendored lz4 + cJSON (we don't ship those as system deps); external mbedTLS (builtin off).
RIST_ARGS=(-Dbuilt_tools=false -Dtest=false
           -Dbuiltin_cjson=true -Dbuiltin_lz4=true -Dbuiltin_mbedtls=false)
case "${RIST_CRYPTO}" in
  # cmake_prefix_path makes our pinned mbedTLS findable ON A NATIVE BUILD. It does nothing for a
  # cross build -- measured: meson's cmake dependency lookup cannot see our prefix cross via
  # -Dcmake_prefix_path, CMAKE_PREFIX_PATH, or [properties] cmake_prefix_path, though all three
  # work natively. Cross builds are covered instead by the -I/-L search paths upstream's 05_write_toolchain.sh
  # writes into every cross file, which let librist's cc.find_library fallback succeed. Both
  # halves are needed; the guard after the build proves whichever one applied. librist resolves it with
  #     dependency('MbedTLS', method: 'cmake', modules: ['MbedTLS::mbedcrypto'])
  # -- a CMake package lookup, NOT pkg-config (a comment in mbedtls.sh said pkg-config; that is
  # wrong for this consumer). Nothing else points meson's CMake search at DEPS_DIR: the cross
  # files set pkg_config_libdir only, and a native build has no reason to look there either. So
  # the lookup missed, the cc.find_library('mbedcrypto') fallback missed too (no -L for DEPS_DIR),
  # and librist quietly compiled its own vendored copy instead -- which the guard after the build
  # now catches. Measured on win-arm64 v3 before this was added.
  mbedtls) RIST_ARGS+=(-Duse_mbedtls=true  -Duse_gnutls=false "-Dcmake_prefix_path=${DEPS_DIR}") ;;
  gnutls)  RIST_ARGS+=(-Duse_mbedtls=false -Duse_gnutls=true)  ;;
  *)       RIST_ARGS+=(-Duse_mbedtls=false -Duse_gnutls=false) ;;
esac
# On Windows, librist's rist_time.c calls clock_gettime, which the mingw-w64 toolchain provides in
# winpthreads (not as the static-inline librist assumes) -- so link fails with undefined clock_gettime
# unless we opt into mingw pthreads. This makes librist link -lpthread (winpthreads); it lands in
# librist.pc, where upstream's 07_build_ffmpeg .pc patch wraps it -Bstatic (no libwinpthread-1.dll runtime dep).
[[ "${BUILD_RID}" == win-* ]] && RIST_ARGS+=(-Dhave_mingw_pthreads=true)

meson setup _build \
  --prefix="${DEPS_DIR}" --libdir=lib --default-library=static --buildtype=release \
  ${MESON_CROSS_ARGS[@]+"${MESON_CROSS_ARGS[@]}"} \
  "${RIST_ARGS[@]}"
meson compile -C _build -j "${JOBS}"
# -Dbuiltin_mbedtls=false is a REQUEST, and librist does not fail when it cannot be honoured.
# contrib/mbedtls/meson.build resolves the external library as
#     dependency('MbedTLS', method: 'cmake', modules: ['MbedTLS::mbedcrypto'])
# falling back to cc.find_library('mbedcrypto'), and if BOTH miss it simply sets
# builtin_mbedtls = true and compiles its own vendored copy from contrib/mbedtls/library/*.c.
#
# So the failure mode is not "rist:// in the clear" -- encryption still works. It is that the
# artifact would carry an UNPINNED, unlocked mbedTLS vendored inside librist instead
# of the version the lock pins, silently diverging from the ledger that the whole dependency
# policy rests on.
#
# The vendored path is unambiguous in the build tree: it declares static_library('mbedcrypto'),
# so a libmbedcrypto.a under the build dir means the external one was not found. Checked after compile,
# because that is when the library would exist. (An earlier version of this check queried meson's
# intro-dependencies.json, which cannot see the cc.find_library fallback at all.)
if [[ "${RIST_CRYPTO}" == "mbedtls" ]]; then
  _rist_vendored="$(find _build -name 'libmbedcrypto.a' -print -quit 2>/dev/null || true)"
  if [[ -n "${_rist_vendored}" ]]; then
    echo "ERROR: librist fell back to its VENDORED mbedTLS (${_rist_vendored})." >&2
    echo "  -Dbuiltin_mbedtls=false was set, so our pinned mbedTLS should have been found." >&2
    echo "  The artifact would ship an unpinned crypto library that the lock does not track." >&2
    exit 1
  fi
  echo "librist: linked the external pinned mbedTLS (no vendored copy built)."
fi
meson install -C _build

# Upstream re-added "-lmbedtls -lmbedx509 -lmbedcrypto" at the END of FFmpeg's link (EXTRA_LIBS, from mbedtls.sh),
# because librist's mbedTLS symbols were left unresolved otherwise (its comment says librist.pc omits mbedTLS). A
# recipe can't touch FFmpeg's link line, so the same -l libs go into librist.pc after -lrist. librist 0.2.20's .pc
# does name mbedTLS, but as ABSOLUTE .a paths (libeverest.a libmbedcrypto.a libp256m.a, the CMake package's
# targets), which FFmpeg's configure classifies as input objects and places BEFORE -lrist -- the srt.pc problem.
# Those paths are replaced by the -l libs, ordered tls -> x509 -> crypto. On Windows, mbedcrypto's entropy_poll.c
# calls BCryptGenRandom (bcrypt.dll), so -lbcrypt must come AFTER -lmbedcrypto.
pc="${DEPS_DIR}/lib/pkgconfig/librist.pc"
if [[ "${RIST_CRYPTO}" == "mbedtls" ]]; then
  MBED_LIBS="-lmbedtls -lmbedx509 -lmbedcrypto"
  [[ "${BUILD_RID}" == win-* ]] && MBED_LIBS="${MBED_LIBS} -lbcrypt"
  sed -i -E 's#[^[:space:]]*/lib(mbedtls|mbedx509|mbedcrypto|everest|p256m)\.a##g' "${pc}"
  if grep -q '^Libs\.private:' "${pc}"; then
    sed -i "s#^Libs\.private:.*#& ${MBED_LIBS}#" "${pc}"
  else
    echo "Libs.private: ${MBED_LIBS}" >>"${pc}"
  fi
fi
echo "librist (RIST transport, crypto=${RIST_CRYPTO}); librist.pc:"
cat "${pc}"
