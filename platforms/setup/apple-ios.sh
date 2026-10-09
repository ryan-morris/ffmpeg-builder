#!/usr/bin/env bash
# ios-arm64 / ios-sim-arm64 / maccatalyst-arm64 / maccatalyst-x64: cross builds on a macOS host with Xcode's SDKs, as
# upstream platform/apple.sh + steps/05 (toolchain files) + steps/08 (frameworks). Sourced by platforms/driver.sh
# and, after recipes/lib.sh, by every recipe build. FFmpeg ships as one dynamic .framework per libav* library.

BREW="${HOMEBREW_PREFIX:-/opt/homebrew}"
for _tool in gnu-sed findutils gnu-tar coreutils grep; do
  PATH="${BREW}/opt/${_tool}/libexec/gnubin:${PATH}"
done
PATH="${BREW}/bin:${PATH}"
export PATH
unset _tool
# shellcheck source=/dev/null
source "${ENGINE}/setup/apple-common.sh"

case "${BUILD_RID}" in
  ios-arm64)         APPLE_SDK=iphoneos;        IOS_MINVER="-miphoneos-version-min=13.0";       FW_PLATFORM=iPhoneOS;        FW_MIN_OS=13.0 ;;
  ios-sim-arm64)     APPLE_SDK=iphonesimulator; IOS_MINVER="-mios-simulator-version-min=13.0"; FW_PLATFORM=iPhoneSimulator; FW_MIN_OS=13.0 ;;
  maccatalyst-arm64) APPLE_SDK=macosx; MCAT_ARCH=arm64;  MCAT_FFARCH=aarch64; FW_PLATFORM=MacOSX; FW_MIN_OS=14.0 ;;
  maccatalyst-x64)   APPLE_SDK=macosx; MCAT_ARCH=x86_64; MCAT_FFARCH=x86_64;  FW_PLATFORM=MacOSX; FW_MIN_OS=14.0 ;;
  *) echo "ERROR: platforms/setup/apple-ios.sh doesn't build ${BUILD_RID}" >&2; exit 1 ;;
esac
# assign, then export: `export X=$(cmd)` would hide an xcrun failure from set -e
CC="$(xcrun --sdk "${APPLE_SDK}" --find clang)"
CXX="$(xcrun --sdk "${APPLE_SDK}" --find clang++)"
AR="$(xcrun --sdk "${APPLE_SDK}" --find ar)"
RANLIB="$(xcrun --sdk "${APPLE_SDK}" --find ranlib)"
SDK_PATH="$(xcrun --sdk "${APPLE_SDK}" --show-sdk-path)"
export CC CXX AR RANLIB

TOOLCHAIN_DIR="${DEPS_DIR}.toolchain" # beside DEPS_DIR, not in it: the driver records what each library adds there
mkdir -p "${TOOLCHAIN_DIR}"

case "${BUILD_RID}" in
  ios-*)
    IOS_SYSROOT="${SDK_PATH}"
    CROSS_HOST=aarch64-apple-darwin
    FLAGS="-arch arm64 ${IOS_MINVER} -isysroot ${IOS_SYSROOT} ${APPLE_PREFIX_MAP}"
    export IOS_SYSROOT IOS_MINVER CROSS_HOST
    export CFLAGS="${FLAGS}" CXXFLAGS="${FLAGS}" LDFLAGS="${FLAGS}"
    write_if_changed "${TOOLCHAIN_DIR}/toolchain.cmake" "set(CMAKE_SYSTEM_NAME iOS)
set(CMAKE_SYSTEM_PROCESSOR arm64)
set(CMAKE_OSX_SYSROOT ${IOS_SYSROOT})
set(CMAKE_OSX_ARCHITECTURES arm64)
set(CMAKE_OSX_DEPLOYMENT_TARGET 13.0)
set(CMAKE_FIND_ROOT_PATH ${DEPS_DIR})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)"
    write_if_changed "${TOOLCHAIN_DIR}/meson-cross.ini" "[binaries]
c = '${CC}'
cpp = '${CXX}'
ar = '${AR}'
strip = 'strip'
pkg-config = 'pkg-config'
[built-in options]
c_args = ['-arch', 'arm64', '-isysroot', '${IOS_SYSROOT}', '${IOS_MINVER}', '-I${DEPS_DIR}/include']
cpp_args = ['-arch', 'arm64', '-isysroot', '${IOS_SYSROOT}', '${IOS_MINVER}', '-I${DEPS_DIR}/include']
c_link_args = ['-arch', 'arm64', '-isysroot', '${IOS_SYSROOT}', '${IOS_MINVER}', '-L${DEPS_DIR}/lib']
cpp_link_args = ['-arch', 'arm64', '-isysroot', '${IOS_SYSROOT}', '${IOS_MINVER}', '-L${DEPS_DIR}/lib']
[host_machine]
system = 'darwin'
cpu_family = 'aarch64'
cpu = 'aarch64'
endian = 'little'
[properties]
pkg_config_libdir = '${DEPS_DIR}/lib/pkgconfig'
needs_exe_wrapper = true"
    ;;
  maccatalyst-*)
    # Catalyst: iOS APIs on macOS, the macOS SDK with an ios*-macabi target. Its iOS-only frameworks (UIKit) live
    # in the SDK's System/iOSSupport tree, which clang only searches when told.
    MCAT_TARGET="${MCAT_ARCH}-apple-ios14.0-macabi"
    MCAT_SYSROOT="${SDK_PATH}"
    MCAT_IOSSUPPORT="${MCAT_SYSROOT}/System/iOSSupport"
    [ -d "${MCAT_IOSSUPPORT}/System/Library/Frameworks" ] || { echo "ERROR: ${MCAT_SYSROOT} has no Catalyst (iOSSupport) tree" >&2; exit 1; }
    CROSS_HOST="$([ "${MCAT_ARCH}" = arm64 ] && echo aarch64 || echo x86_64)-apple-darwin"
    CC_FOR_BUILD="$(xcrun --sdk macosx --find clang) -isysroot ${MCAT_SYSROOT}" # host tools nettle/gnutls build and run
    export MCAT_TARGET MCAT_SYSROOT CROSS_HOST CC_FOR_BUILD
    export CFLAGS="-target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT} -iframework ${MCAT_IOSSUPPORT}/System/Library/Frameworks -isystem ${MCAT_IOSSUPPORT}/usr/include ${APPLE_PREFIX_MAP}"
    export CXXFLAGS="${CFLAGS}"
    export LDFLAGS="-target ${MCAT_TARGET} -isysroot ${MCAT_SYSROOT} -F${MCAT_IOSSUPPORT}/System/Library/Frameworks -L${MCAT_IOSSUPPORT}/usr/lib"
    write_if_changed "${TOOLCHAIN_DIR}/toolchain.cmake" "set(CMAKE_SYSTEM_NAME Darwin)
set(CMAKE_SYSTEM_PROCESSOR ${MCAT_ARCH})
set(CMAKE_OSX_SYSROOT ${MCAT_SYSROOT})
set(CMAKE_OSX_ARCHITECTURES ${MCAT_ARCH})
set(CMAKE_C_FLAGS_INIT \"-target ${MCAT_TARGET}\")
set(CMAKE_CXX_FLAGS_INIT \"-target ${MCAT_TARGET}\")
set(CMAKE_OBJC_FLAGS_INIT \"-target ${MCAT_TARGET}\")
set(CMAKE_OBJCXX_FLAGS_INIT \"-target ${MCAT_TARGET}\")
set(CMAKE_ASM_FLAGS_INIT \"-target ${MCAT_TARGET}\")
set(CMAKE_EXE_LINKER_FLAGS_INIT \"-target ${MCAT_TARGET}\")
set(CMAKE_SHARED_LINKER_FLAGS_INIT \"-target ${MCAT_TARGET}\")
set(CMAKE_FIND_ROOT_PATH ${DEPS_DIR} ${MCAT_SYSROOT})
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
c_args = ['-target', '${MCAT_TARGET}', '-isysroot', '${MCAT_SYSROOT}', '-I${DEPS_DIR}/include']
cpp_args = ['-target', '${MCAT_TARGET}', '-isysroot', '${MCAT_SYSROOT}', '-I${DEPS_DIR}/include']
c_link_args = ['-target', '${MCAT_TARGET}', '-isysroot', '${MCAT_SYSROOT}', '-L${DEPS_DIR}/lib']
cpp_link_args = ['-target', '${MCAT_TARGET}', '-isysroot', '${MCAT_SYSROOT}', '-L${DEPS_DIR}/lib']
[host_machine]
system = 'darwin'
cpu_family = '${MCAT_FFARCH}'
cpu = '${MCAT_FFARCH}'
endian = 'little'
[properties]
pkg_config_libdir = '${DEPS_DIR}/lib/pkgconfig'
needs_exe_wrapper = false"
    ;;
esac
# Recipes with hand-written makefiles (libgsm) take the target flags as upstream's EXTRA_*FLAGS
export EXTRA_CFLAGS="${CFLAGS}" EXTRA_CXXFLAGS="${CXXFLAGS}" EXTRA_LDFLAGS="${LDFLAGS}"
export PKG_CONFIG_LIBDIR="${DEPS_DIR}/lib/pkgconfig"
CMAKE_CROSS_ARGS=("-DCMAKE_TOOLCHAIN_FILE=${TOOLCHAIN_DIR}/toolchain.cmake")
MESON_CROSS_ARGS=(--cross-file "${TOOLCHAIN_DIR}/meson-cross.ini")

# Before FFmpeg's configure: the host-specific flags platforms.yml can't hold (Xcode's compilers and SDK path, the
# target and minimum OS), appended to the driver's configure flags; and, for Mac Catalyst, videotoolbox.c's guard:
# it hides its OpenGL(ES) pixel-buffer keys behind TARGET_OS_IPHONE, which macabi also defines although the keys are
# unavailable there (upstream steps/07). awk, not sed: portable line insertion.
before_ffmpeg() {
  flags+=(--cc="${CC}" --cxx="${CXX}" --ar="${AR}" --ranlib="${RANLIB}" --sysroot="${SDK_PATH}"
          "--extra-cflags=${CFLAGS}" "--extra-cxxflags=${CXXFLAGS}" "--extra-ldflags=${LDFLAGS}")
  case "${BUILD_RID}" in maccatalyst-*) ;; *) return 0 ;; esac
  local vt="${WORK}/ffmpeg/libavcodec/videotoolbox.c"
  grep -q TARGET_OS_MACCATALYST "${vt}" && return 0
  awk '/^#if TARGET_OS_IPHONE$/ && !done { print "#if TARGET_OS_MACCATALYST"; print "    /* Mac Catalyst: no OpenGL(ES) interop (patched by ffmpeg-build). */"; print "#elif TARGET_OS_IPHONE"; done = 1; next } { print }' \
    "${vt}" >"${vt}.patched" && mv "${vt}.patched" "${vt}"
  grep -q '^#if TARGET_OS_MACCATALYST$' "${vt}" || { echo "ERROR: videotoolbox.c Mac Catalyst patch did not apply" >&2; exit 1; }
}

toolchain_facts() {
  xcodebuild -version | tr '\n' ' '
  echo "${APPLE_SDK} $(xcrun --sdk "${APPLE_SDK}" --show-sdk-version)"
  # shellcheck disable=SC2046 # one tool per line
  brew list --versions $(grep -v '^#' "${ENGINE}/setup/apple-brew.txt")
}

# stage <install prefix> <runtime folder> <dev folder>: one .framework per libav* library (the static dependencies
# are linked into them), @rpath install names, Info.plist per platform (upstream steps/08). The dev folder holds
# headers and .pc files as on the other platforms.
stage() {
  local install="$1" run="$2" dev="$3" base fw fwdir bin ref b stem pc version
  version="$(jq -r .ffmpeg.version "${PLAN}")"
  mkdir -p "${dev}/include" "${dev}/lib/pkgconfig"
  for base in avcodec avformat avutil avfilter swscale swresample; do # as upstream: no libavdevice on iOS
    [ -e "${install}/lib/lib${base}.dylib" ] || continue
    fw="lib${base}"
    fwdir="${run}/${fw}.framework"
    mkdir -p "${fwdir}/Headers"
    cp "${install}/lib/lib${base}.dylib" "${fwdir}/${fw}" # follows the symlink: the real dylib
    cp -a "${install}/include/lib${base}/." "${fwdir}/Headers/"
    cat >"${fwdir}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${fw}</string>
  <key>CFBundleIdentifier</key><string>org.ffmpeg.${fw}</string>
  <key>CFBundleName</key><string>${fw}</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>MinimumOSVersion</key><string>${FW_MIN_OS}</string>
  <key>CFBundleSupportedPlatforms</key><array><string>${FW_PLATFORM}</string></array>
</dict>
</plist>
PLIST
  done
  for fwdir in "${run}"/*.framework; do
    fw="$(basename "${fwdir}" .framework)"
    bin="${fwdir}/${fw}"
    install_name_tool -id "@rpath/${fw}.framework/${fw}" "${bin}"
    while read -r ref; do
      b="$(basename "${ref}")"
      stem="${b%%.*}"
      case "${stem}" in libav*|libsw*) install_name_tool -change "${ref}" "@rpath/${stem}.framework/${stem}" "${bin}" ;; esac
    done < <(otool -L "${bin}" | awk 'NR>1 {print $1}')
    codesign --force --sign - "${bin}"
  done
  cp -a "${install}/include/." "${dev}/include/"
  apple_stage_pc "${install}" "${dev}"
}

# check_stage <runtime folder>: no iOS binary can run here, so check the frameworks instead: each loads its
# siblings by @rpath and nothing from the build tree or a package manager, and libavcodec has its headers.
check_stage() {
  local bin want got
  [ -f "$1/libavcodec.framework/Headers/avcodec.h" ] || { echo "ERROR: libavcodec.framework has no Headers/avcodec.h" >&2; exit 1; }
  apple_check_paths "$1"/*.framework/lib*
  # each framework is built for this platform (LC_BUILD_VERSION: 2 iOS, 6 Mac Catalyst, 7 iOS simulator)
  case "${BUILD_RID}" in ios-arm64) want=2 ;; maccatalyst-*) want=6 ;; ios-sim-*) want=7 ;; esac
  for bin in "$1"/*.framework/lib*; do
    got="$(otool -l "${bin}" | awk '/LC_BUILD_VERSION/{f=1} f&&$1=="platform"{print $2; exit}')"
    [ "${got}" = "${want}" ] || { echo "ERROR: $(basename "${bin}") is built for platform ${got}, not ${want} (${BUILD_RID})" >&2; exit 1; }
  done
  for bin in "$1"/*.framework/lib*; do echo "$(basename "${bin}"): $(lipo -archs "${bin}"), $(otool -l "${bin}" | awk '/LC_BUILD_VERSION/{f=1} f&&/platform/{print "platform " $2; exit}')"; done
}
