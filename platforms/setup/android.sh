#!/usr/bin/env bash
# android-arm64 / android-x64: cross-compiled with the Android NDK in images/cross-android, as upstream
# platform/android.sh, 05_write_toolchain.sh and 08_stage_artifacts.sh (android). API 28 (Android 9+): ggml-vulkan
# links Vulkan 1.1 symbols the API-28 libvulkan exports. Sourced by platforms/driver.sh and, after recipes/lib.sh, by
# every recipe build.

: "${ANDROID_NDK_HOME:?the Android NDK (ANDROID_NDK_HOME) is set by images/cross-android}"
export ANDROID_NDK_HOME
export API=28
TOOLCHAIN="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64"
export TOOLCHAIN
case "${BUILD_RID}" in
  android-arm64) ANDROID_TRIPLE=aarch64-linux-android; ANDROID_ABI=arm64-v8a; MESON_CPU=aarch64 ;;
  android-x64)   ANDROID_TRIPLE=x86_64-linux-android;  ANDROID_ABI=x86_64;    MESON_CPU=x86_64 ;;
  *) echo "ERROR: platforms/setup/android.sh doesn't build ${BUILD_RID}" >&2; exit 1 ;;
esac
export ANDROID_TRIPLE ANDROID_ABI
export CROSS_HOST="${ANDROID_TRIPLE}"
export CC="${TOOLCHAIN}/bin/${ANDROID_TRIPLE}${API}-clang"
export CXX="${CC}++"
export AR="${TOOLCHAIN}/bin/llvm-ar" RANLIB="${TOOLCHAIN}/bin/llvm-ranlib" STRIP="${TOOLCHAIN}/bin/llvm-strip" NM="${TOOLCHAIN}/bin/llvm-nm"
# Android 15+ may use 16 KB pages; a library aligned to 4 KB doesn't load there (Google Play requires 16 KB). Every
# shared object a dependency links gets it too.
export LDFLAGS="-Wl,-z,max-page-size=16384"

# CMake uses the NDK's own toolchain file; meson gets a cross file with DEPS_DIR on the search paths (meson's cmake
# lookups can't see the prefix on a cross build: librist would otherwise vendor its own mbedTLS). Upstream 05.
TOOLCHAIN_DIR="${DEPS_DIR%/*}/toolchain"
mkdir -p "${TOOLCHAIN_DIR}"
cat >"${TOOLCHAIN_DIR}/android-meson.ini" <<MESON
[binaries]
c = '${CC}'
cpp = '${CXX}'
ar = '${AR}'
strip = '${STRIP}'
pkg-config = 'pkg-config'
[host_machine]
system = 'android'
cpu_family = '${MESON_CPU}'
cpu = '${MESON_CPU}'
endian = 'little'
[properties]
pkg_config_libdir = '${DEPS_DIR}/lib/pkgconfig'
needs_exe_wrapper = true
[built-in options]
c_args = ['-I${DEPS_DIR}/include']
cpp_args = ['-I${DEPS_DIR}/include']
c_link_args = ['-L${DEPS_DIR}/lib']
cpp_link_args = ['-L${DEPS_DIR}/lib']
MESON
CMAKE_CROSS_ARGS=(-DCMAKE_TOOLCHAIN_FILE="${ANDROID_NDK_HOME}/build/cmake/android.toolchain.cmake"
                  -DANDROID_ABI="${ANDROID_ABI}" -DANDROID_PLATFORM="android-${API}")
MESON_CROSS_ARGS=(--cross-file "${TOOLCHAIN_DIR}/android-meson.ini")

# Before FFmpeg's configure: the NDK's own tools and sysroot, which platforms.yml can't name (upstream platform/android.sh).
before_ffmpeg() {
  flags+=(--cc="${CC}" --cxx="${CXX}" --ar="${AR}" --ranlib="${RANLIB}" --strip="${STRIP}" --nm="${NM}" --sysroot="${TOOLCHAIN}/sysroot")
}

# Upstream 08_stage_artifacts.sh (android): headers and lib/<abi>/*.so under their unversioned names (Android loads
# libraries by file name), with the sonames and the libraries' references to each other rewritten to match, plus the
# NDK's libc++_shared.so (the C++ codec libraries need it at run time; Android doesn't provide it). Its licence text
# is the notice platforms.yml's ships: names, which the driver puts in THIRD-PARTY-NOTICES.txt. The -dev archive holds the headers
# and relocatable .pc files.
stage() {
  local install="$1" run="$2" dev="$3" so real base dep n pc glob files
  local libdir="${run}/lib/${ANDROID_ABI}"
  mkdir -p "${run}/include" "${libdir}" "${dev}/include" "${dev}/lib/pkgconfig"
  cp -a "${install}/include/." "${run}/include/"
  cp -a "${install}/include/." "${dev}/include/"
  for so in "${install}/lib/"*.so; do
    real="$(readlink -f "${so}")"
    cp "${real}" "${libdir}/$(basename "${so}")"
  done
  # files recipes ship next to FFmpeg's libraries (recipe.yml runtime:), as platforms/setup/linux-stage.sh; globs, so unquoted
  while read -r glob; do
    shopt -s nullglob
    # shellcheck disable=SC2206 # the runtime glob is meant to expand
    files=("${DEPS_DIR}"/${glob})
    shopt -u nullglob
    [ "${#files[@]}" -gt 0 ] || { echo "ERROR: nothing in ${DEPS_DIR} matches ${glob} (a recipe's runtime:)" >&2; exit 1; }
    cp -a "${files[@]}" "${libdir}/"
  done < <(jq -r '.runtime[]' "${PLAN}")
  for so in "${libdir}"/*.so; do patchelf --set-soname "$(basename "${so}")" "${so}"; done
  for so in "${libdir}"/*.so; do
    for dep in "${libdir}"/*.so; do
      base="$(basename "${dep}")"
      for n in $(patchelf --print-needed "${so}" | grep -E "^${base//./\\.}\.[0-9]+" || true); do
        patchelf --replace-needed "${n}" "${base}" "${so}"
      done
    done
  done
  cp "${TOOLCHAIN}/sysroot/usr/lib/${ANDROID_TRIPLE}/libc++_shared.so" "${libdir}/"
  for pc in "${install}/lib/pkgconfig/"*.pc; do
    sed -e 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
        -e 's|^exec_prefix=.*|exec_prefix=${prefix}|' \
        -e "s|^libdir=.*|libdir=\${prefix}/lib/${ANDROID_ABI}|" \
        -e 's|^includedir=.*|includedir=${prefix}/include|' \
        "${pc}" >"${dev}/lib/pkgconfig/$(basename "${pc}")"
  done
}

# check_page_align <library...>: every LOAD segment is aligned to 16 KB or more, so the library loads on 16 KB-page
# devices (upstream test/android.sh check_elf_page_align).
check_page_align() {
  local so align n bad=""
  for so in "$@"; do
    n=0
    while read -r align; do
      n=$((n + 1))
      (( align >= 0x4000 )) || bad="${bad}
  $(basename "${so}") has a LOAD segment aligned to ${align}"
    done < <("${TOOLCHAIN}/bin/llvm-readelf" -lW "${so}" | awk '$1 == "LOAD" { print $NF }')
    [ "${n}" -gt 0 ] || bad="${bad}
  $(basename "${so}") has no LOAD segments llvm-readelf can read"
  done
  [ -z "${bad}" ] || { echo "ERROR: the Android libraries wouldn't load on 16 KB pages:${bad}" >&2; exit 1; }
}

# Nothing here runs Android binaries, so check what an app would load (upstream 09_verify_build.sh and test/android.sh):
# every library is aligned to 16 KB pages, its soname is its unversioned file name, and it needs only Android system
# libraries, its siblings and libc++_shared.so; with mediacodec, libavcodec needs libmediandk.so.
check_stage() {
  local so soname dep bad=""
  local libdir="$1/lib/${ANDROID_ABI}"
  [ -f "${libdir}/libavcodec.so" ] && [ -f "${libdir}/libc++_shared.so" ] || { echo "ERROR: lib/${ANDROID_ABI} lacks libavcodec.so or libc++_shared.so" >&2; exit 1; }
  grep -qxF '== libc++_shared.so ==' "$1/THIRD-PARTY-NOTICES.txt" || { echo "ERROR: THIRD-PARTY-NOTICES.txt lacks libc++_shared.so's licence text" >&2; exit 1; }
  check_page_align "${libdir}"/*.so
  if jq -e '.ffmpeg.configure | index("--enable-mediacodec")' "${PLAN}" >/dev/null; then
    patchelf --print-needed "${libdir}/libavcodec.so" | grep -qx libmediandk.so \
      || { echo "ERROR: libavcodec.so doesn't need libmediandk.so, though mediacodec is enabled" >&2; exit 1; }
  fi
  for so in "${libdir}"/*.so; do
    soname="$(patchelf --print-soname "${so}")"
    [ "${soname}" = "$(basename "${so}")" ] || bad="${bad}
  $(basename "${so}") has soname ${soname}"
    while read -r dep; do
      [ -n "${dep}" ] || continue
      case "${dep}" in
        libc.so|libm.so|libdl.so|liblog.so|libandroid.so|libmediandk.so|libcamera2ndk.so|libvulkan.so|libz.so|libc++_shared.so) ;;
        *) [ -f "${libdir}/${dep}" ] || bad="${bad}
  $(basename "${so}") needs ${dep}, which neither Android nor the archive provides" ;;
      esac
    done < <(patchelf --print-needed "${so}")
  done
  [ -z "${bad}" ] || { echo "ERROR: the Android libraries wouldn't load:${bad}" >&2; exit 1; }
  echo "lib/${ANDROID_ABI}: $(cd "${libdir}" && ls | tr '\n' ' ')"
  strings -a "${libdir}/libavutil.so" | grep -E -- '--prefix=' | awk '{ if (length($0) > length(b)) b = $0 } END { print b }'
}
