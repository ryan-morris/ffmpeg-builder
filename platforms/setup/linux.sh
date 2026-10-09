#!/usr/bin/env bash
# linux-x64 (and later linux-arm64): native builds in manylinux_2_28, as upstream platform/linux.sh. Sourced by
# platforms/driver.sh and, after recipes/lib.sh, by every recipe build.

# manylinux's compiler: gcc-toolset-14 (its enable script reads unset variables, so -u is off around it)
set +u
source /opt/rh/gcc-toolset-14/enable
set -u
export CFLAGS="-fPIC" CXXFLAGS="-fPIC" # the RHEL toolset isn't PIE by default
CMAKE_CROSS_ARGS=()                    # native: no toolchain file, no cross file
MESON_CROSS_ARGS=()

# shellcheck source=/dev/null
source "${ENGINE}/setup/linux-stage.sh"

before_ffmpeg() { :; }
