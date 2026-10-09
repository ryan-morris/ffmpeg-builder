#!/usr/bin/env bash
# Staging for Linux (glibc and musl): FFmpeg's shared libraries and programs flat in one folder with rpath $ORIGIN,
# headers and relocatable .pc files in the -dev folder. Upstream steps/08 + release.yml, linux. Sourced by the linux
# setups; uses the driver's PLAN and DEPS_DIR.

# stage <install prefix> <runtime folder> <dev folder>
stage() {
  local install="$1" run="$2" dev="$3" glob f pc
  local -a files
  mkdir -p "${dev}/include" "${dev}/lib/pkgconfig"
  cp -a "${install}/lib/"*.so* "${run}/"
  cp -a "${install}/bin/ffmpeg" "${install}/bin/ffprobe" "${run}/"
  # files recipes ship next to FFmpeg's libraries (recipe.yml runtime:, e.g. the Vulkan loader); globs, so unquoted
  while read -r glob; do
    shopt -s nullglob
    files=("${DEPS_DIR}"/${glob})
    shopt -u nullglob
    [ "${#files[@]}" -gt 0 ] || { echo "ERROR: nothing in ${DEPS_DIR} matches ${glob} (a recipe's runtime:)" >&2; exit 1; }
    cp -a "${files[@]}" "${run}/"
  done < <(jq -r '.runtime[]' "${PLAN}")
  for f in "${run}/ffmpeg" "${run}/ffprobe" "${run}"/*.so*; do
    [ -L "${f}" ] || patchelf --set-rpath '$ORIGIN' "${f}"
  done
  cp -a "${install}/include/." "${dev}/include/"
  for pc in "${install}/lib/pkgconfig/"*.pc; do
    sed -e 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
        -e 's|^exec_prefix=.*|exec_prefix=${prefix}|' \
        -e 's|^libdir=.*|libdir=${prefix}|' \
        -e 's|^includedir=.*|includedir=${prefix}/include|' \
        "${pc}" >"${dev}/lib/pkgconfig/$(basename "${pc}")"
  done
}

# check_stage <runtime folder>: the staged ffmpeg runs from there (rpath $ORIGIN) and reports how it was built
check_stage() {
  "$1/ffmpeg" -hide_banner -version | sed -n 1p # sed reads it all, no SIGPIPE
  "$1/ffmpeg" -hide_banner -buildconf
}
