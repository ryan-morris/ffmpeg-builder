#!/usr/bin/env bash
# Compares an Android archive built by ffmpeg-build with a published one. Android libraries can't run on this host, so it
# compares what can be read from the files, inside a clean manylinux_2_28 container (any host):
#   - the files in the archive, headers included
#     (one expected difference: published archives have legal/, ffmpeg-build THIRD-PARTY-NOTICES.txt);
#   - FFmpeg's configure line as compiled into libavutil.so, apart from build-machine paths: --prefix, the --extra-*
#     flags, and the NDK tool and sysroot paths (--cc, --cxx, --ar, --ranlib, --strip, --nm, --sysroot), and the
#     published build's --enable-hwaccel=h264_mediacodec and hevc_mediacodec (FFmpeg has no such hwaccels: they
#     matched nothing, so ffmpeg-build leaves them out);
#   - each library's soname and what it needs (NEEDED): what Android's loader must find.
#
#   scripts/compare-published-android.sh dist/ffmpeg-9.0.2-android-arm64-lgplv3.tar.gz path/to/published/ffmpeg-9.0.2-android-arm64-lgplv3.tar.gz
#
# Differences listed for the platform or the build (<platform>-<license>) in scripts/compare-published.expected are
# reported as expected; it prints the others and exits 1 when there are any.
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 <built.tar.gz> <published.tar.gz>" >&2; exit 2; }
IMAGE='quay.io/pypa/manylinux_2_28_x86_64:2026.09.30-1@sha256:c2261579b9c2e5d45aa93312f73e2a302182e3e977b558581a1838d6fed3d8e6'
name="$(basename "$2" .tar.gz)"
name="${name#ffmpeg-*-}"
platform="${name%-*}"
expected="$(sed -n -e "s/^${platform} \+\([a-z]\+\) \+\([-+].*\)$/\1 \2/p" -e "s/^${name} \+\([a-z]\+\) \+\([-+].*\)$/\1 \2/p" \
  "$(dirname "$0")/compare-published.expected")"

# Docker on Windows wants a Windows path for a bind mount; elsewhere the plain absolute path is fine.
host_path() { (cd "$(dirname "$1")" && { pwd -W 2>/dev/null || pwd; }) | sed 's|$|/'"$(basename "$1")"'|'; }

MSYS_NO_PATHCONV=1 docker run --rm -e "EXPECTED=${expected}" \
  --mount "type=bind,source=$(host_path "$1"),target=/built.tar.gz,readonly" \
  --mount "type=bind,source=$(host_path "$2"),target=/published.tar.gz,readonly" \
  "${IMAGE}" bash -c '
    set -euo pipefail
    for side in built published; do
      mkdir -p "/$side"
      tar -xzf "/$side.tar.gz" -C "/$side"
      (cd "/$side" && find . -mindepth 1 ! -path "./legal/*" | sed "s|^\./||" | LC_ALL=C sort) > "/$side.files"
      lib="$(find "/$side/lib" -name libavutil.so | head -1)"
      strings -a "$lib" | grep -E -- "--prefix=" | awk "{ if (length(\$0) > length(b)) b = \$0 } END { print b }" \
        | sed "s/ --/\n--/g" \
        | grep -v -E "^--(prefix|extra-[a-z]+|cc|cxx|ar|ranlib|strip|nm|sysroot)=|^--enable-hwaccel=(h264|hevc)_mediacodec$" \
        | LC_ALL=C sort -u > "/$side.flags"
      : > "/$side.deps"
      for so in $(find "/$side/lib" -name "*.so" | LC_ALL=C sort); do
        echo "$(basename "$so"): soname=$(readelf -d "$so" | sed -n "s/.*SONAME.*\[\(.*\)\]/\1/p") needs=$(readelf -d "$so" | sed -n "s/.*NEEDED.*\[\(.*\)\]/\1/p" | LC_ALL=C sort | tr "\n" " ")" >> "/$side.deps"
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
    compare files "Files" /published.files /built.files
    compare flags "Configure flags" /published.flags /built.flags
    compare deps "Sonames and dependencies" /published.deps /built.deps
    if [ "$status" -eq 0 ]; then
      echo "Same files, configure flags, sonames and dependencies ($(wc -l < /built.files) files, $(wc -l < /built.flags) flags, $(wc -l < /built.deps) libraries), but for ${seen} expected differences (scripts/compare-published.expected)."
    fi
    exit "$status"
  '
