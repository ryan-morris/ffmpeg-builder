#!/usr/bin/env bash
# Shared by the Apple setups (apple-macos.sh, apple-ios.sh), which build natively on a Mac: the build folders are under
# the builder's home, so nothing from them may end up in what ships.

# Source paths recorded in compiled code (__FILE__, debug info) are rewritten to the container paths a Docker build
# would record, so a Mac build carries no username or home folder. FFmpeg's own configure line is rewritten the same
# way by the driver.
APPLE_PREFIX_MAP="-ffile-prefix-map=${FFB_WORK:-/work}=/work -ffile-prefix-map=${DEPS_DIR}=/opt/ffmpeg-build/deps"

# write_if_changed <file> <content>: toolchain and cross files are written on every setup run (the driver's and each
# recipe's); rewriting an identical file would still change its mtime.
write_if_changed() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ] || printf '%s\n' "$2" >"$1"; }

# apple_check_paths <binary...>: what a shipped Mach-O may load and reference. Fails the build when one loads a library
# from the build tree or a package manager's prefix (otool -L), looks for libraries there (LC_RPATH), or carries the
# build folders or the builder's home in its strings.
apple_check_paths() {
  local bin dep bad="" brew="${HOMEBREW_PREFIX:-/opt/homebrew}"
  for bin in "$@"; do
    [ -L "${bin}" ] && continue
    while read -r dep; do
      case "${dep}" in
        "${WORK}"/*|"${DEPS_DIR}"/*|/usr/local/*|"${brew}"/*|/opt/homebrew/*|/opt/local/*) bad="${bad}
  $(basename "${bin}") loads ${dep}" ;;
      esac
    done < <(otool -L "${bin}" | awk 'NR>1 {print $1}')
    while read -r dep; do
      case "${dep}" in
        @loader_path|@loader_path/*|@executable_path|@executable_path/*|/usr/lib|/usr/lib/*) ;;
        *) bad="${bad}
  $(basename "${bin}") searches ${dep} (LC_RPATH)" ;;
      esac
    done < <(otool -l "${bin}" | awk '/cmd LC_RPATH/{f=1} f&&$1=="path"{print $2; f=0}')
    if strings -a "${bin}" | grep -qF -e "${WORK}" -e "${DEPS_DIR}" -e "${HOME}"; then
      bad="${bad}
  $(basename "${bin}") contains the build folders or ${HOME} in its strings"
    fi
  done
  if [ -n "${bad}" ]; then
    echo "ERROR: what ships refers to this machine:${bad}" >&2
    exit 1
  fi
}

# apple_stage_pc <install prefix> <dev folder>: FFmpeg's .pc files, relocatable, with the build's deps folder written
# as the container path (as a Docker build has it) rather than this machine's.
apple_stage_pc() {
  local pc
  for pc in "$1/lib/pkgconfig/"*.pc; do
    sed -e 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
        -e 's|^exec_prefix=.*|exec_prefix=${prefix}|' \
        -e 's|^libdir=.*|libdir=${prefix}|' \
        -e 's|^includedir=.*|includedir=${prefix}/include|' \
        -e "s|${DEPS_DIR}|/opt/ffmpeg-build/deps|g" \
        "${pc}" >"$2/lib/pkgconfig/$(basename "${pc}")"
  done
}
