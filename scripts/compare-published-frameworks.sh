#!/usr/bin/env bash
# Compares an iOS / Mac Catalyst framework archive built by ffmpeg-build with one slice of a published xcframework
# archive, natively on a Mac (iOS binaries can't run here, so FFmpeg's own record of its build is compared instead):
#   - the frameworks, and the files in each (Info.plist, Headers/);
#   - each framework's configure line (the FFmpeg configuration string compiled into it), apart from build-machine
#     paths and the --extra-*flags/--cc/--sysroot values that name them;
#   - each binary's architecture and platform (LC_BUILD_VERSION), and its direct exported symbols;
#   - the names of the files under legal/ against the published archive's legal/ (which serves every slice, so
#     expected differences are listed per build, <platform>-<license>).
#
#   scripts/compare-published-frameworks.sh dist/ffmpeg-9.0.2-ios-arm64-lgplv3.tar.gz published/ffmpeg-9.0.2-ios-lgplv3.tar.gz ios-arm64
#
# Differences listed for the built archive's platform in scripts/compare-published-apple.expected (each with its
# reason) are reported as expected and don't fail the comparison; anything else does. Expected entries that match
# nothing are reported as a warning (they may be stale). Exits 1 when there are unexpected differences.
set -euo pipefail

[ "$#" -eq 3 ] || { echo "usage: $0 <built.tar.gz> <published xcframework archive> <slice, e.g. ios-arm64>" >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo "$0 runs on macOS" >&2; exit 2; }
name_re='^ffmpeg-[0-9.]+-(.+)-(lgplv2|lgplv3|gplv2|gplv3|nonfree)\.tar\.gz$'
[[ "$(basename "$1")" =~ ${name_re} ]] || { echo "can't tell the platform from $(basename "$1") (expected ffmpeg-<version>-<platform>-<license>.tar.gz)" >&2; exit 2; }
platform="${BASH_REMATCH[1]}"
build="${platform}-${BASH_REMATCH[2]}"
expected="$(sed -n -e "s/^${platform} \{1,\}\([a-z]\{1,\}\) \{1,\}\([-+].*\)$/\1 \2/p" -e "s/^${build} \{1,\}\([a-z]\{1,\}\) \{1,\}\([-+].*\)$/\1 \2/p" \
  "$(dirname "$0")/compare-published-apple.expected")"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
mkdir -p "${tmp}/built" "${tmp}/pubx" "${tmp}/published"
tar -xzf "$1" -C "${tmp}/built"
tar -xzf "$2" -C "${tmp}/pubx"
for xc in "${tmp}/pubx"/*.xcframework; do
  cp -R "${xc}/$3/." "${tmp}/published/" 2>/dev/null || { echo "no $3 slice in $(basename "${xc}")" >&2; exit 2; }
done

describe() { # <framework folder root> <out prefix> [architecture to read a fat binary's contents from]
  (cd "$1" && find . -type f ! -path '*/_CodeSignature/*' | sed 's|^\./||' | LC_ALL=C sort) >"$2.files"
  : >"$2.flags"
  : >"$2.binaries"
  : >"$2.symbols"
  local fw bin read
  for fw in "$1"/*.framework; do
    bin="${fw}/$(basename "${fw}" .framework)"
    # a fat binary (the universal Catalyst slice) is read in the built build's architecture: each half carries its own
    # configure line and exports
    read="${bin}"
    if [ -n "${3:-}" ] && [ "$(lipo -archs "${bin}" | wc -w)" -gt 1 ]; then
      read="${tmp}/thin-$(basename "${bin}")"
      lipo -thin "$3" "${bin}" -output "${read}"
    fi
    # the configure line FFmpeg compiles in (avcodec_configuration()): the one string holding --enable-/--disable-
    { strings -a "${read}" | grep -E -- '--(enable|disable)-' | head -1 || true; } | tr ' ' '\n' \
      | { grep -E '^--' || true; } | { grep -v -e '^--prefix=' -e '^--extra-' -e '^--cc=' -e '^--cxx=' -e '^--ar=' -e '^--ranlib=' -e '^--sysroot=' || true; } \
      | LC_ALL=C sort -u | sed "s|^|$(basename "${fw}"): |" >>"$2.flags"
    echo "$(basename "${bin}") $(lipo -archs "${bin}") $(otool -l "${bin}" | awk '/LC_BUILD_VERSION/{f=1} f&&/platform/{print "platform", $2; exit}')" >>"$2.binaries"
    # direct exports only: the published 9.0.2.3 frameworks also re-export libavutil's symbols (nm type I)
    nm -gU "${read}" | awk '$1 != "I" {print $3}' | sed "s|^|$(basename "${bin}"): |" >>"$2.symbols"
  done
  LC_ALL=C sort -o "$2.flags" "$2.flags"
  LC_ALL=C sort -o "$2.symbols" "$2.symbols"
}
(cd "${tmp}/built" && { find legal -type f 2>/dev/null || true; } | LC_ALL=C sort) >"${tmp}/b.legal"
(cd "${tmp}/pubx" && { find legal -type f 2>/dev/null || true; } | LC_ALL=C sort) >"${tmp}/p.legal"
describe "${tmp}/built" "${tmp}/b"
describe "${tmp}/published" "${tmp}/p" "$(lipo -archs "$(ls "${tmp}"/built/*.framework/libavutil)")"
status=0
seen=0
: >"${tmp}/matched"
compare() { # <section> <label> <published file> <built file>
  local line unexpected=""
  diff -u "$3" "$4" >"${tmp}/d.diff" || true
  while IFS= read -r line; do
    if grep -qxF -- "$1 ${line}" <<<"${expected}"; then
      seen=$((seen + 1))
      printf '%s\n' "$1 ${line}" >>"${tmp}/matched"
    else
      unexpected="${unexpected}${line}
"
    fi
  done < <(tail -n +3 "${tmp}/d.diff" | grep '^[-+]' || true)
  if [ -n "${unexpected}" ]; then
    echo "$2 differ (- published, + built):"
    printf '%s' "${unexpected}" | head -60
    status=1
  fi
}
compare files "Framework files" "${tmp}/p.files" "${tmp}/b.files"
compare legal "Files under legal/" "${tmp}/p.legal" "${tmp}/b.legal"
compare flags "Configure flags" "${tmp}/p.flags" "${tmp}/b.flags"
compare binaries "Binaries" "${tmp}/p.binaries" "${tmp}/b.binaries"
compare symbols "Exported symbols" "${tmp}/p.symbols" "${tmp}/b.symbols"
stale="$(grep -vxF -f "${tmp}/matched" <<<"${expected}" || true)"
if [ -n "${stale}" ]; then
  echo "warning: expected differences for ${platform} that this comparison didn't meet (stale?):"
  printf '  %s\n' "${stale}"
fi
[ "${status}" -eq 0 ] && echo "Same frameworks, files, legal/ files, configure flags, architectures/platforms and exported symbols ($(wc -l <"${tmp}/b.symbols" | tr -d ' ') symbols), but for ${seen} expected differences (scripts/compare-published-apple.expected)."
exit "${status}"
