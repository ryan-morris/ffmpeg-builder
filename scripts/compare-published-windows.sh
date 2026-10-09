#!/usr/bin/env bash
# Compares a Windows archive built by ffmpeg-build with a published one. The programs can't run on a Linux host, so it
# compares what can be read from the files, inside the Windows toolchain image (llvm-objdump reads x64 and ARM64 PE):
#   - the files in the runtime archive (legal/ aside);
#   - the names of the files under legal/;
#   - FFmpeg's configure line as embedded in ffmpeg.exe, apart from build-machine paths (--prefix) and the --extra-*
#     flags (paths, and upstream passed link libraries there that ffmpeg-build puts in each library's .pc file);
#   - every DLL's and program's imports: what Windows must find to load it.
#
#   scripts/compare-published-windows.sh dist/ffmpeg-9.0.2-win-x64-lgplv3.tar.gz path/to/published/ffmpeg-9.0.2-win-x64-lgplv3.tar.gz
#
# Needs the cross-windows toolchain image (ffmpeg-build builds it the first time it builds for Windows). Differences
# listed for the platform or the build (<platform>-<license>) in scripts/compare-published.expected are reported as
# expected; it prints the others and exits 1 when there are any.
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 <built.tar.gz> <published.tar.gz>" >&2; exit 2; }
IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' ffmpeg-build-cross-windows | head -1)"
[ -n "${IMAGE}" ] || { echo "no ffmpeg-build-cross-windows image here: build for win-x64 once first" >&2; exit 2; }
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
      (cd "/$side" && find . -mindepth 1 -maxdepth 1 ! -name legal | sed "s|^\./||" | LC_ALL=C sort) > "/$side.files"
      (cd "/$side" && find legal -type f | LC_ALL=C sort) > "/$side.legal"
      grep -aom1 -- "--prefix=[ -~]*" "/$side/ffmpeg.exe" | sed "s/ --/\n--/g" \
        | grep -v -e "^--prefix=" -e "^--extra-" | LC_ALL=C sort -u > "/$side.flags"
      : > "/$side.imports"
      for f in "/$side"/*.dll "/$side"/*.exe; do
        llvm-objdump -p "$f" 2>/dev/null | sed -n "s/^[[:space:]]*DLL Name: //p" | LC_ALL=C sort | sed "s|^|$(basename "$f"): |" >> "/$side.imports"
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
    compare legal "Files under legal/" /published.legal /built.legal
    compare flags "Configure flags" /published.flags /built.flags
    compare imports "DLL imports" /published.imports /built.imports
    if [ "$status" -eq 0 ]; then
      echo "Same runtime files, legal/ files ($(wc -l < /built.legal)), configure flags and DLL imports ($(wc -l < /built.flags) flags, $(wc -l < /built.imports) imports), but for ${seen} expected differences (scripts/compare-published.expected)."
    fi
    exit "$status"
  '
