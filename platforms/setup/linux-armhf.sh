#!/usr/bin/env bash
# linux-armhf: 32-bit ARM (armv7 + VFPv3/NEON), cross-compiled in images/cross-armhf with Debian's gcc, as upstream
# platform/linux.sh (linux-armhf) and 05_write_toolchain.sh. Sourced by platforms/driver.sh and, after recipes/lib.sh,
# by every recipe build.

export CROSS_HOST="arm-linux-gnueabihf"
export CROSS_PREFIX="${CROSS_HOST}"
# CC/CXX/AR are deliberately not exported, as upstream: each recipe names the target its own way (autotools --host,
# the CMake/meson files below, OpenSSL's CROSS_COMPILE, x264/libvpx cross prefixes), and an exported CC would be
# prefixed twice by those that add the prefix themselves.
# -fPIC on the static dependencies: Debian's cross gcc is PIE by default, but that doesn't change the TLS model, and a
# file-static _Thread_local (GnuTLS's random.c) would compile to local-exec TLS the linker refuses in a shared libav*.so.
export CFLAGS="-fPIC" CXXFLAGS="-fPIC"

# The CMake toolchain and meson cross file (upstream 05_write_toolchain.sh). DEPS_DIR on the include and library paths:
# meson's cmake lookups can't see the prefix on a cross build (librist would otherwise vendor its own mbedTLS).
TOOLCHAIN_DIR="${DEPS_DIR%/*}/toolchain"
mkdir -p "${TOOLCHAIN_DIR}"
cat >"${TOOLCHAIN_DIR}/armhf.cmake" <<CMAKE
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR arm)
set(CMAKE_C_COMPILER ${CROSS_HOST}-gcc)
set(CMAKE_CXX_COMPILER ${CROSS_HOST}-g++)
set(CMAKE_C_FLAGS_INIT "-mfpu=neon")
set(CMAKE_CXX_FLAGS_INIT "-mfpu=neon")
set(CMAKE_FIND_ROOT_PATH ${DEPS_DIR})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
CMAKE
cat >"${TOOLCHAIN_DIR}/armhf-meson.ini" <<MESON
[binaries]
c = '${CROSS_HOST}-gcc'
cpp = '${CROSS_HOST}-g++'
ar = '${CROSS_HOST}-ar'
strip = '${CROSS_HOST}-strip'
pkg-config = 'pkg-config'
[host_machine]
system = 'linux'
cpu_family = 'arm'
cpu = 'armv7'
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
CMAKE_CROSS_ARGS=(-DCMAKE_TOOLCHAIN_FILE="${TOOLCHAIN_DIR}/armhf.cmake")
MESON_CROSS_ARGS=(--cross-file "${TOOLCHAIN_DIR}/armhf-meson.ini")

# shellcheck source=/dev/null
source "${ENGINE}/setup/linux-stage.sh"

before_ffmpeg() { :; }

# The staged ffmpeg is an ARM binary: run it under qemu-user, with Debian's armhf runtime as its root (rpath $ORIGIN
# finds the libav* libraries next to it).
check_stage() {
  qemu-arm -L "/usr/${CROSS_HOST}" "$1/ffmpeg" -hide_banner -version | sed -n 1p
  qemu-arm -L "/usr/${CROSS_HOST}" "$1/ffmpeg" -hide_banner -buildconf
}
