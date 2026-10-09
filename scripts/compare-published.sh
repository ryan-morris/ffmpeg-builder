#!/usr/bin/env bash
# Compares an archive built by ffmpeg-build with a published one, inside a clean container (any host): manylinux_2_28
# for glibc builds, or a bare Alpine with COMPARE_IMAGE=alpine for musl builds (no libstdc++.so or libgcc_s.so there,
# so an artifact that needs them at run time fails to run instead of passing), or the linux-armhf toolchain image with
# COMPARE_IMAGE=armhf, where both archives' ffmpeg run under qemu-user against that image's Debian armhf sysroot
# (not a clean Raspberry Pi OS, so a library the sysroot has but a Pi lacks would go unnoticed there).
# COMPARE_IMAGE=manylinux-arm64 and alpine-arm64 are the same clean images for arm64 builds (linux-arm64,
# linux-musl-arm64): native on an arm64 host, emulated by Docker on an x64 one. What it compares:
#   - the files in the runtime archive (legal/ aside), and where each symlink points;
#   - the names of the files under legal/ (from the archive's listing, not unpacked; their contents are tested on
#     ffmpeg-build's own output instead);
#   - FFmpeg's configure line (ffmpeg -buildconf), apart from build-machine paths (--prefix, -I/-L folders) and
#     --extra-libs: upstream passed link libraries there, ffmpeg-build puts them in each library's .pc file;
#   - what FFmpeg registers: encoders, decoders, filters, formats, protocols, hwaccels, bitstream filters;
#   - each program's and library's soname, needed libraries and rpath (readelf).
# Differences listed for the platform in scripts/compare-published.expected (each with its reason), or for the build
# (<platform>-<license>: legal/ differs by licence), are reported as expected and don't fail the comparison; anything
# else does.
#
#   scripts/compare-published.sh dist/ffmpeg-9.0.2-linux-x64-lgplv3.tar.gz path/to/published/ffmpeg-9.0.2-linux-x64-lgplv3.tar.gz
#
# Prints the differences and exits 1 when there are unexpected ones.
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 <built.tar.gz> <published.tar.gz>" >&2; exit 2; }
# Alpine packages at exact versions: when the 3.24 branch replaces one, the install fails instead of changing tools.
APK='apk add -q --no-cache bash=5.3.9-r1 binutils=2.45.1-r1 >/dev/null'
case "${COMPARE_IMAGE:-manylinux}" in
  alpine)    IMAGE='alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6'; PREP="${APK}" ;;
  manylinux) IMAGE='quay.io/pypa/manylinux_2_28_x86_64:2026.09.30-1@sha256:c2261579b9c2e5d45aa93312f73e2a302182e3e977b558581a1838d6fed3d8e6'; PREP=':' ;;
  alpine-arm64)
             IMAGE='alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6'; PREP="${APK}"
             PLATFORM=linux/arm64 ;;
  manylinux-arm64)
             IMAGE='quay.io/pypa/manylinux_2_28_aarch64:2026.09.30-1@sha256:acc4e63610fef1da3d687322793665205415c2b22c0d2e403f1a44eb834d63fc'; PREP=':'
             PLATFORM=linux/arm64 ;;
  armhf)     IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' ffmpeg-build-cross-armhf | head -1)"; PREP=':'
             RUN='qemu-arm -L /usr/arm-linux-gnueabihf'
             [ -n "${IMAGE}" ] || { echo "no ffmpeg-build-cross-armhf image here: build for linux-armhf once first" >&2; exit 2; } ;;
  *)         echo "COMPARE_IMAGE is manylinux, alpine, manylinux-arm64, alpine-arm64 or armhf" >&2; exit 2 ;;
esac

# The platform, from the published archive's name (ffmpeg-<version>-<platform>-<license>.tar.gz), and its expected
# differences as "<section> <diff line>" lines.
name="$(basename "$2" .tar.gz)"
name="${name#ffmpeg-*-}"
platform="${name%-*}"
expected="$(sed -n -e "s/^${platform} \+\([a-z]\+\) \+\([-+].*\)$/\1 \2/p" -e "s/^${name} \+\([a-z]\+\) \+\([-+].*\)$/\1 \2/p" \
  "$(dirname "$0")/compare-published.expected")"

# Docker on Windows wants a Windows path for a bind mount; elsewhere the plain absolute path is fine.
host_path() { (cd "$(dirname "$1")" && { pwd -W 2>/dev/null || pwd; }) | sed 's|$|/'"$(basename "$1")"'|'; }

MSYS_NO_PATHCONV=1 docker run --rm ${PLATFORM:+--platform "${PLATFORM}"} -e "RUN=${RUN:-}" -e "EXPECTED=${expected}" -e "IMAGE=${IMAGE}" \
  --mount "type=bind,source=$(host_path "$1"),target=/built.tar.gz,readonly" \
  --mount "type=bind,source=$(host_path "$2"),target=/published.tar.gz,readonly" \
  "${IMAGE}" sh -c "${PREP} && exec bash -c \"\$0\"" '
    set -euo pipefail
    command -v readelf >/dev/null || { echo "readelf missing in $IMAGE" >&2; exit 2; }
    lists="encoders decoders filters formats protocols hwaccels bsfs"
    for side in built published; do
      mkdir -p "/$side"
      # legal/ is not compared, so it is not unpacked (a guard too: tar under qemu 9.2 fails to create files in it)
      tar -xzf "/$side.tar.gz" -C "/$side" --exclude=./legal
      (cd "/$side" && find . -mindepth 1 -maxdepth 1 ! -name legal | sed "s|^\./||" | LC_ALL=C sort) > "/$side.files"
      tar -tzf "/$side.tar.gz" | sed "s|^\./||" | grep "^legal/." | grep -v "/\$" | LC_ALL=C sort > "/$side.legal"
      (cd "/$side" && for l in $(find . -maxdepth 1 -type l | LC_ALL=C sort); do echo "${l#./} -> $(readlink "$l")"; done) > "/$side.links"
      $RUN "/$side/ffmpeg" -hide_banner -buildconf | sed -n "s/^ *\(--.*\)$/\1/p" \
        | grep -v -e "^--prefix=" -e "^--extra-cflags=" -e "^--extra-ldflags=" -e "^--extra-libs=" \
        | LC_ALL=C sort -u > "/$side.flags"
      for what in $lists; do
        $RUN "/$side/ffmpeg" -hide_banner -$what 2>/dev/null | awk "{print \$1\" \"\$2}" | LC_ALL=C sort > "/$side.$what"
      done
      : > "/$side.deps"
      for f in $(cd "/$side" && find . -maxdepth 1 -type f \( -name ffmpeg -o -name ffprobe -o -name "*.so*" \) | LC_ALL=C sort); do
        d="$(readelf -d "/$side/$f")"
        echo "${f#./}: soname=$(sed -n "s/.*(SONAME).*\[\(.*\)\]/\1/p" <<<"$d") needs=$(sed -n "s/.*(NEEDED).*\[\(.*\)\]/\1/p" <<<"$d" | LC_ALL=C sort | tr "\n" " ")rpath=$(sed -n "s/.*R[UN]*PATH).*\[\(.*\)\]/\1/p" <<<"$d")" >> "/$side.deps"
      done
    done
    status=0 seen=0
    compare() { # <section> <label> <published file> <built file>: differences not in EXPECTED fail
      local line
      diff -u "$3" "$4" | tail -n +3 | grep "^[-+]" > /d.diff || true
      : > /d.bad
      while IFS= read -r line; do
        if grep -qxF -- "$1 $line" <<<"$EXPECTED"; then seen=$((seen + 1)); else echo "$line" >> /d.bad; fi
      done < /d.diff
      if [ -s /d.bad ]; then echo "$2 differ (- published, + built):"; cat /d.bad; status=1; fi
    }
    compare files "Runtime files" /published.files /built.files
    compare links "Symlinks" /published.links /built.links
    compare legal "Files under legal/" /published.legal /built.legal
    compare flags "Configure flags" /published.flags /built.flags
    for what in $lists; do compare "$what" "Registered $what" "/published.$what" "/built.$what"; done
    compare deps "Sonames and dependencies" /published.deps /built.deps
    if [ "$status" -eq 0 ]; then
      echo "Same runtime files, configure flags and registered components ($(for w in $lists; do printf "%s %s, " "$(wc -l < /built.$w)" "$w"; done | sed "s/, $//"))."
      echo "Same symlinks ($(wc -l < /built.links)), legal/ files ($(wc -l < /built.legal)), sonames, needed libraries and rpaths ($(wc -l < /built.deps) files), but for ${seen} expected differences (scripts/compare-published.expected)."
    fi
    exit "$status"
  '
