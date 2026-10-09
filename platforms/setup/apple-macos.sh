#!/usr/bin/env bash
# osx-arm64 / osx-x64 on a macOS host with Xcode's clang, as upstream platform/apple.sh (osx arm). osx-arm64 builds
# natively; osx-x64 is cross-compiled on Apple silicon (upstream built it on an Intel Mac): every build system is told
# the target, so nothing runs an x86_64 test program.
# Sourced by platforms/driver.sh and, after recipes/lib.sh, by every recipe build. The build tools come from
# Homebrew (platforms/setup/apple-brew.txt lists them); nothing else from Homebrew may end up in what ships.

BREW="${HOMEBREW_PREFIX:-/opt/homebrew}"
# GNU sed/find/tar/coreutils/grep first: the driver and the recipes use GNU options (sed -i, find -printf, nproc).
for _tool in gnu-sed findutils gnu-tar coreutils grep; do
  PATH="${BREW}/opt/${_tool}/libexec/gnubin:${PATH}"
done
PATH="${BREW}/bin:${PATH}"
export PATH
unset _tool
# shellcheck source=/dev/null
source "${ENGINE}/setup/apple-common.sh"
# Xcode's compilers by name: never a CC/CXX the user's shell might carry (native builds pass only an allowlisted
# environment, but the setup says what it builds with). Assign, then export, so an xcrun failure stops the build.
CC="$(xcrun --find clang)"
CXX="$(xcrun --find clang++)"
# Called by path, Xcode's clang doesn't know the SDK (the /usr/bin/clang wrapper would add it): name it. Its version
# is in toolchain_facts, so a new SDK rebuilds.
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export CC CXX SDKROOT

# 11.0 (Big Sur), as upstream: the first release with Apple silicon, so one floor for both osx platforms. Without it
# every library inherits the build machine's macOS as its minimum.
export MACOSX_DEPLOYMENT_TARGET=11.0
export CFLAGS="-mmacosx-version-min=11.0 ${APPLE_PREFIX_MAP}" CXXFLAGS="-mmacosx-version-min=11.0 ${APPLE_PREFIX_MAP}" LDFLAGS="-mmacosx-version-min=11.0"
case "${BUILD_RID}" in
  osx-x64) # an Intel build on an Apple silicon Mac: every compile targets x86_64
    CFLAGS="-arch x86_64 ${CFLAGS}" CXXFLAGS="-arch x86_64 ${CXXFLAGS}" LDFLAGS="-arch x86_64 ${LDFLAGS}" ;;
esac
# Xcode's archiver serves every architecture (there is no x86_64-apple-darwin-ar to find), and recipes with
# hand-written makefiles (libgsm) take the target flags as upstream's EXTRA_*FLAGS.
AR="$(xcrun --find ar)"
RANLIB="$(xcrun --find ranlib)"
export AR RANLIB EXTRA_CFLAGS="${CFLAGS}" EXTRA_CXXFLAGS="${CXXFLAGS}" EXTRA_LDFLAGS="${LDFLAGS}"
# Only this build's libraries, never Homebrew's: pkg-config searches DEPS_DIR alone, CMake skips the brew prefixes.
export PKG_CONFIG_LIBDIR="${DEPS_DIR}/lib/pkgconfig"
CMAKE_CROSS_ARGS=("-DCMAKE_IGNORE_PREFIX_PATH=${BREW};/usr/local;/opt/local" -DCMAKE_FIND_FRAMEWORK=LAST)
MESON_CROSS_ARGS=() # native
case "${BUILD_RID}" in
  osx-arm64) CMAKE_CROSS_ARGS+=(-DCMAKE_OSX_ARCHITECTURES=arm64) ;;
  osx-x64)
    # autotools: --host from CROSS_HOST (the recipes pass it); CMake: a toolchain file, so projects that pick code by
    # processor (aom, x265) see x86_64; meson: a cross file, so it doesn't run its sanity-check program
    export CROSS_HOST=x86_64-apple-darwin
    TOOLCHAIN_DIR="${DEPS_DIR}.toolchain" # beside DEPS_DIR, not in it: the driver records what each library adds there
    mkdir -p "${TOOLCHAIN_DIR}"
    write_if_changed "${TOOLCHAIN_DIR}/toolchain.cmake" "set(CMAKE_SYSTEM_NAME Darwin)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_OSX_SYSROOT ${SDKROOT})
set(CMAKE_OSX_ARCHITECTURES x86_64)
set(CMAKE_OSX_DEPLOYMENT_TARGET 11.0)
# the architecture on every compiler CMake drives: ggml's Metal backend embeds its shader library through generated
# assembly, which CMAKE_OSX_ARCHITECTURES alone left arm64 (ranlib: cputype does not match previous archive members)
set(CMAKE_C_FLAGS_INIT \"-arch x86_64\")
set(CMAKE_CXX_FLAGS_INIT \"-arch x86_64\")
set(CMAKE_OBJC_FLAGS_INIT \"-arch x86_64\")
set(CMAKE_OBJCXX_FLAGS_INIT \"-arch x86_64\")
set(CMAKE_ASM_FLAGS_INIT \"-arch x86_64\")
set(CMAKE_C_COMPILER ${CC})
set(CMAKE_CXX_COMPILER ${CXX})
set(CMAKE_FIND_ROOT_PATH ${DEPS_DIR} ${SDKROOT})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_FRAMEWORK LAST)"
    write_if_changed "${TOOLCHAIN_DIR}/meson-cross.ini" "[binaries]
c = '${CC}'
cpp = '${CXX}'
ar = '${AR}'
strip = 'strip'
pkg-config = 'pkg-config'
[built-in options]
c_args = ['-arch', 'x86_64', '-isysroot', '${SDKROOT}', '-mmacosx-version-min=11.0', '-I${DEPS_DIR}/include']
cpp_args = ['-arch', 'x86_64', '-isysroot', '${SDKROOT}', '-mmacosx-version-min=11.0', '-I${DEPS_DIR}/include']
c_link_args = ['-arch', 'x86_64', '-isysroot', '${SDKROOT}', '-mmacosx-version-min=11.0', '-L${DEPS_DIR}/lib']
cpp_link_args = ['-arch', 'x86_64', '-isysroot', '${SDKROOT}', '-mmacosx-version-min=11.0', '-L${DEPS_DIR}/lib']
[host_machine]
system = 'darwin'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
[properties]
pkg_config_libdir = '${DEPS_DIR}/lib/pkgconfig'
needs_exe_wrapper = true"
    CMAKE_CROSS_ARGS=("-DCMAKE_TOOLCHAIN_FILE=${TOOLCHAIN_DIR}/toolchain.cmake" "-DCMAKE_IGNORE_PREFIX_PATH=${BREW};/usr/local;/opt/local")
    MESON_CROSS_ARGS=(--cross-file "${TOOLCHAIN_DIR}/meson-cross.ini")
    ;;
esac

before_ffmpeg() { :; }

# What the library cache keys on besides the driver and this file: Xcode, the SDK, and the build tools' versions.
toolchain_facts() {
  xcodebuild -version | tr '\n' ' '
  echo "macosx $(xcrun --sdk macosx --show-sdk-version)"
  # shellcheck disable=SC2046 # the list is one word per line
  brew list --versions $(grep -v '^#' "${ENGINE}/setup/apple-brew.txt")
}

# stage <install prefix> <runtime folder> <dev folder>: flat dylibs plus ffmpeg/ffprobe, relocatable (upstream steps/08
# osx): each library's id is @rpath/<name>.<major>.dylib, what pointed into the build tree points at @rpath, binaries
# look next to themselves (@loader_path), and every edited Mach-O is signed again (arm64 refuses broken signatures).
stage() {
  local install="$1" run="$2" dev="$3" glob lib name major target dep pc
  local -a files
  mkdir -p "${dev}/include" "${dev}/lib/pkgconfig"
  cp -a "${install}/lib/"*.dylib "${run}/"
  cp -a "${install}/bin/ffmpeg" "${install}/bin/ffprobe" "${run}/"
  while read -r glob; do # recipe.yml runtime: files that ship next to FFmpeg's libraries; globs, so unquoted
    shopt -s nullglob
    files=("${DEPS_DIR}"/${glob})
    shopt -u nullglob
    [ "${#files[@]}" -gt 0 ] || { echo "ERROR: nothing in ${DEPS_DIR} matches ${glob} (a recipe's runtime:)" >&2; exit 1; }
    cp -a "${files[@]}" "${run}/"
  done < <(jq -r '.runtime[]' "${PLAN}")
  for lib in "${run}"/*.dylib; do
    [ -L "${lib}" ] && continue
    name="$(basename "${lib}")"
    major="$(sed -E 's/^(lib[a-zA-Z0-9_-]+)\.([0-9]+)(\..*)?\.dylib$/\1.\2.dylib/' <<<"${name}")"
    install_name_tool -id "@rpath/${major}" "${lib}"
  done
  for target in "${run}/ffmpeg" "${run}/ffprobe" "${run}"/*.dylib; do
    [ -L "${target}" ] && continue
    while read -r dep; do
      case "${dep}" in
        "${install}"/*|"${DEPS_DIR}"/*|"${WORK}"/*) install_name_tool -change "${dep}" "@rpath/$(basename "${dep}")" "${target}" ;;
      esac
    done < <(otool -L "${target}" | awk 'NR>1 {print $1}')
    otool -l "${target}" | grep -q 'path @loader_path ' || install_name_tool -add_rpath @loader_path "${target}"
    codesign --force --sign - "${target}"
  done
  cp -a "${install}/include/." "${dev}/include/"
  apple_stage_pc "${install}" "${dev}"
}

# check_stage <runtime folder>: nothing shipped may load from, search in, or refer to this machine's folders
# (apple-common.sh), and the staged ffmpeg runs from where it is.
check_stage() {
  apple_check_paths "$1/ffmpeg" "$1/ffprobe" "$1"/*.dylib
  # an x86_64 ffmpeg runs on Apple silicon only through Rosetta
  if [ "${BUILD_RID}" = osx-x64 ] && [ "$(uname -m)" = arm64 ] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then
    echo "not running the staged ffmpeg: this Mac can't run x86_64 programs (install Rosetta to)"
    lipo -archs "$1/ffmpeg"
    return 0
  fi
  "$1/ffmpeg" -hide_banner -version | sed -n 1p
  "$1/ffmpeg" -hide_banner -buildconf
}
