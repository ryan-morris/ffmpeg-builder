#!/usr/bin/env bash
# Compares an xcframework bundle made by `ffmpeg-build bundle --apple` with a published one, on a Mac. It checks what
# the bundle adds to its four builds (what's in each slice, compare-published-frameworks.sh compares per build):
#   - the xcframeworks, and the slices in each;
#   - each xcframework's Info.plist: per slice its identifier, path, platform, variant and architectures;
#   - each slice framework's binary (architectures, platform) and whether it is signed (_CodeSignature/);
#   - what sits beside the xcframeworks (the published archive has legal/ where ffmpeg-build ships
#     THIRD-PARTY-NOTICES.txt: one expected difference).
#
#   scripts/compare-published-ios-bundle.sh dist/ffmpeg-9.0.2-ios-lgplv3.tar.gz published/ffmpeg-9.0.2-ios-lgplv3.tar.gz
#
# Differences listed for platform `ios` in scripts/compare-published-apple.expected (each with its reason) are reported
# as expected and don't fail the comparison; anything else does. Expected entries that match nothing are reported as a
# warning (they may be stale). Exits 1 when there are unexpected differences.
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 <built ios bundle .tar.gz> <published ios bundle .tar.gz>" >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo "$0 runs on macOS" >&2; exit 2; }
[[ "$(basename "$1")" =~ ^ffmpeg-[0-9.]+-ios-(lgplv2|lgplv3|gplv2|gplv3|nonfree)\.tar\.gz$ ]] \
  || { echo "$(basename "$1") isn't an xcframework bundle (expected ffmpeg-<version>-ios-<license>.tar.gz)" >&2; exit 2; }
expected="$(sed -n -e 's/^ios \{1,\}\([a-z]\{1,\}\) \{1,\}\([-+].*\)$/\1 \2/p' "$(dirname "$0")/compare-published-apple.expected")"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
mkdir -p "${tmp}/built" "${tmp}/published"
tar -xzf "$1" -C "${tmp}/built"
tar -xzf "$2" -C "${tmp}/published"

key() { # <plist> <key path> [format]: the value, or - when there's none (plutil prints its error on stdout)
  local v
  if v="$(plutil -extract "$2" "${3:-raw}" -o - "$1" 2>/dev/null)"; then printf '%s\n' "${v}"; else echo -; fi
}
describe() { # <bundle root> <out prefix>
  (cd "$1" && find . -mindepth 1 -maxdepth 1 ! -name '*.xcframework' | sed 's|^\./||' | LC_ALL=C sort) >"$2.root"
  : >"$2.slices"
  : >"$2.plist"
  : >"$2.binaries"
  local xc name i id fw bin
  for xc in "$1"/*.xcframework; do
    name="$(basename "${xc}")"
    (cd "${xc}" && find . -mindepth 1 -maxdepth 1 | sed 's|^\./||' | LC_ALL=C sort | sed "s|^|${name}: |") >>"$2.slices"
    i=0
    while plutil -extract "AvailableLibraries.${i}" json -o /dev/null "${xc}/Info.plist" >/dev/null 2>&1; do
      id="$(key "${xc}/Info.plist" "AvailableLibraries.${i}.LibraryIdentifier")"
      printf '%s: %s path=%s binary=%s platform=%s variant=%s archs=%s\n' "${name}" "${id}" \
        "$(key "${xc}/Info.plist" "AvailableLibraries.${i}.LibraryPath")" \
        "$(key "${xc}/Info.plist" "AvailableLibraries.${i}.BinaryPath")" \
        "$(key "${xc}/Info.plist" "AvailableLibraries.${i}.SupportedPlatform")" \
        "$(key "${xc}/Info.plist" "AvailableLibraries.${i}.SupportedPlatformVariant")" \
        "$(key "${xc}/Info.plist" "AvailableLibraries.${i}.SupportedArchitectures" json | tr -d '[]"' | tr ',' ' ')" >>"$2.plist"
      i=$((i + 1))
    done
    for fw in "${xc}"/*/*.framework; do
      bin="${fw}/$(basename "${fw}" .framework)"
      echo "$(basename "$(dirname "${fw}")")/$(basename "${fw}") $(lipo -archs "${bin}") $(otool -l "${bin}" | awk '/LC_BUILD_VERSION/{f=1} f&&/platform/{print "platform", $2; exit}') $([ -d "${fw}/_CodeSignature" ] && echo signed || echo unsigned)" >>"$2.binaries"
    done
  done
  LC_ALL=C sort -o "$2.plist" "$2.plist"
  LC_ALL=C sort -o "$2.binaries" "$2.binaries"
}
describe "${tmp}/built" "${tmp}/b"
describe "${tmp}/published" "${tmp}/p"
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
compare root "Beside the xcframeworks" "${tmp}/p.root" "${tmp}/b.root"
compare slices "Slices" "${tmp}/p.slices" "${tmp}/b.slices"
compare plist "Info.plist slices" "${tmp}/p.plist" "${tmp}/b.plist"
compare binaries "Slice binaries" "${tmp}/p.binaries" "${tmp}/b.binaries"
stale="$(grep -vxF -f "${tmp}/matched" <<<"${expected}" || true)"
if [ -n "${stale}" ]; then
  echo "warning: expected differences for ios that this comparison didn't meet (stale?):"
  printf '  %s\n' "${stale}"
fi
[ "${status}" -eq 0 ] && echo "Same xcframeworks, slices, Info.plist slices and slice binaries ($(wc -l <"${tmp}/b.binaries" | tr -d ' ') frameworks), but for ${seen} expected differences (scripts/compare-published-apple.expected)."
exit "${status}"
