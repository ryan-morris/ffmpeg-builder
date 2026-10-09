#!/usr/bin/env bash
# linux-musl-x64 / linux-musl-arm64: native builds in Alpine, as upstream platform/linux.sh (musl). FFmpeg links
# libgcc statically (platforms.yml --extra-ldflags) and libstdc++ statically (the .pc rewrite below), so the
# artifacts run on any musl system; the C++ recipes pick the static runtime themselves from BUILD_RID.
# Sourced by platforms/driver.sh and, after recipes/lib.sh, by every recipe build.

export CFLAGS="-fPIC" CXXFLAGS="-fPIC"
CMAKE_CROSS_ARGS=() # native: no toolchain file, no cross file
MESON_CROSS_ARGS=()

# shellcheck source=/dev/null
source "${ENGINE}/setup/linux-stage.sh"

# Upstream 07_build_ffmpeg.sh (musl): every dependency's .pc file loses -lgcc_s (it defeats -static-libgcc with
# versioned _Unwind_* references no archive satisfies) and links libstdc++ statically, so FFmpeg's configure and
# link pick up the static runtime. Each substitution loops (:a ... ta) because two adjacent copies share the space
# between them; running the whole hook twice changes nothing. A build with no libraries has no .pc files to fix.
before_ffmpeg() {
  local pc
  for pc in "${DEPS_DIR}"/lib/pkgconfig/*.pc; do
    [ -f "${pc}" ] || continue
    sed -i -E \
      -e ':a' -e 's/(^|[[:space:]])-lgcc_s([[:space:]]|$)/\1\2/' -e 'ta' \
      -e ':b' -e 's/(^|[[:space:]])-lstdc\+\+([[:space:]]|$)/\1-l:libstdc++.a\2/' -e 'tb' \
      "${pc}"
  done
}

# Linux staging, then upstream 08_stage_artifacts.sh's musl check: nothing staged may need the shared C++ runtime
# or libgcc_s at run time (musl systems often don't have them).
check_stage() {
  local f needed bad=0
  for f in "$1/ffmpeg" "$1/ffprobe" "$1"/*.so*; do
    [ -L "${f}" ] && continue
    needed="$(patchelf --print-needed "${f}")"
    if grep -qE '^(libstdc\+\+|libgcc_s)\.so' <<<"${needed}"; then
      echo "ERROR: $(basename "${f}") needs $(grep -E '^(libstdc\+\+|libgcc_s)\.so' <<<"${needed}" | tr '\n' ' ')at run time; musl builds link them statically" >&2
      bad=1
    fi
  done
  [ "${bad}" -eq 0 ] || exit 1
  "$1/ffmpeg" -hide_banner -version | sed -n 1p
  "$1/ffmpeg" -hide_banner -buildconf
}
