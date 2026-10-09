#!/usr/bin/env bash
# compare-published.sh for macOS archives, run natively on a Mac. Compares:
#   - the files at the top of the runtime archive
#     (one expected difference: published archives have legal/, ffmpeg-build THIRD-PARTY-NOTICES.txt);
#   - FFmpeg's configure line, apart from build-machine paths (--prefix, -I/-L folders) and the --extra-* flags
#     (--extra-libs: upstream passed link libraries there, ffmpeg-build puts them in each library's .pc file);
#   - each Mach-O's architectures, minimum macOS, install name and the shipped libraries it loads (@rpath; the system
#     frameworks it uses follow from the configure line);
#   - what FFmpeg registers (encoders, decoders, filters, formats, protocols, hwaccels, bitstream filters) when this
#     Mac can run the programs, else the direct exported symbols of FFmpeg's own libraries (other shipped libraries are
#     compared as files).
# The programs can run here when they're built for this Mac's architecture, or for x86_64 with Rosetta installed.
# When they can, they must: an ffmpeg that should run and doesn't fails the comparison.
#
#   scripts/compare-published-macos.sh dist/ffmpeg-9.0.2-osx-arm64-lgplv3.tar.gz path/to/ffmpeg-9.0.2-osx-arm64-lgplv3.tar.gz
#
# Differences listed for the built archive's platform in scripts/compare-published-apple.expected (each with its
# reason) are reported as expected and don't fail the comparison; anything else does. Expected entries that match
# nothing are reported as a warning (they may be stale). Exits 1 when there are unexpected differences.
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 <built.tar.gz> <published.tar.gz>" >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo "$0 runs on macOS; use compare-published.sh for Linux archives" >&2; exit 2; }
name_re='^ffmpeg-[0-9.]+-(.+)-(lgplv2|lgplv3|gplv2|gplv3|nonfree)\.tar\.gz$'
[[ "$(basename "$1")" =~ ${name_re} ]] || { echo "can't tell the platform from $(basename "$1") (expected ffmpeg-<version>-<platform>-<license>.tar.gz)" >&2; exit 2; }
platform="${BASH_REMATCH[1]}"
build="${platform}-${BASH_REMATCH[2]}" # differences can also be listed per build
expected="$(sed -n -e "s/^${platform} \{1,\}\([a-z]\{1,\}\) \{1,\}\([-+].*\)$/\1 \2/p" -e "s/^${build} \{1,\}\([a-z]\{1,\}\) \{1,\}\([-+].*\)$/\1 \2/p" \
  "$(dirname "$0")/compare-published-apple.expected")"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
lists="encoders decoders filters formats protocols hwaccels bsfs"
for side in built published; do
  archive="$1"
  [ "${side}" = published ] && archive="$2"
  mkdir -p "${tmp}/${side}"
  tar -xzf "${archive}" -C "${tmp}/${side}"
  (cd "${tmp}/${side}" && find . -mindepth 1 -maxdepth 1 | sed 's|^\./||' | LC_ALL=C sort) >"${tmp}/${side}.files"
  : >"${tmp}/${side}.deps"
  : >"${tmp}/${side}.symbols"
  for bin in "${tmp}/${side}/ffmpeg" "${tmp}/${side}/ffprobe" "${tmp}/${side}"/*.dylib; do
    [ -L "${bin}" ] && continue
    id="$(otool -D "${bin}" | sed -n 2p)"
    printf '%s: archs=%s minos=%s id=%s loads=%s\n' "$(basename "${bin}")" "$(lipo -archs "${bin}" | tr ' ' ',')" \
      "$(otool -l "${bin}" | awk '/LC_BUILD_VERSION/{f=1} f&&$1=="minos"{print $2; exit}')" "${id}" \
      "$(otool -L "${bin}" | awk 'NR>1 {print $1}' | { grep '^@rpath/' || true; } | { grep -vxF -- "${id:-none}" || true; } | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')" \
      >>"${tmp}/${side}.deps"
    case "${bin}" in
      */libav*.dylib|*/libsw*.dylib) nm -gU "${bin}" | awk '$1 != "I" {print $3}' | sed "s|^|$(basename "${bin}"): |" >>"${tmp}/${side}.symbols" ;;
    esac
  done
  LC_ALL=C sort -o "${tmp}/${side}.symbols" "${tmp}/${side}.symbols"
done

# Can this Mac run the built programs? Decided from their architectures, never from whether they happen to run.
host="$(uname -m)"
archs="$(lipo -archs "${tmp}/built/ffmpeg")"
runs=0
if [[ " ${archs} " == *" ${host} "* ]]; then
  runs=1
elif [[ " ${archs} " == *" x86_64 "* ]] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  runs=1
fi
status=0
if [ "${runs}" -eq 1 ]; then
  for side in built published; do
    if ! "${tmp}/${side}/ffmpeg" -hide_banner -version >"${tmp}/${side}.run" 2>&1; then
      echo "The ${side} ffmpeg (${archs}) should run on this ${host} Mac and doesn't:"
      sed -n 1,5p "${tmp}/${side}.run"
      status=1
    fi
  done
  [ "${status}" -eq 0 ] || exit 1
fi

flags() { # <side>: the configure line, from the program when it runs, else from libavcodec
  if [ "${runs}" -eq 1 ]; then
    "${tmp}/$1/ffmpeg" -hide_banner -buildconf | sed -n 's/^ *\(--.*\)$/\1/p'
  else
    strings -a "${tmp}/$1"/libavcodec.*.*.*.dylib | grep -E -- '--(enable|disable)-' | head -1 | tr ' ' '\n' | grep '^--' || true
  fi | grep -v -e '^--prefix=' -e '^--extra-' | LC_ALL=C sort -u
}
for side in built published; do flags "${side}" >"${tmp}/${side}.flags"; done
if [ "${runs}" -eq 1 ]; then
  for side in built published; do
    for what in ${lists}; do
      "${tmp}/${side}/ffmpeg" -hide_banner "-${what}" 2>/dev/null | awk '{print $1" "$2}' | LC_ALL=C sort >"${tmp}/${side}.${what}"
    done
  done
fi

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
    printf '%s' "${unexpected}"
    status=1
  fi
}
compare files "Runtime files" "${tmp}/published.files" "${tmp}/built.files"
compare flags "Configure flags" "${tmp}/published.flags" "${tmp}/built.flags"
compare deps "Mach-O facts" "${tmp}/published.deps" "${tmp}/built.deps"
if [ "${runs}" -eq 1 ]; then
  for what in ${lists}; do compare "${what}" "Registered ${what}" "${tmp}/published.${what}" "${tmp}/built.${what}"; done
else
  compare symbols "Exported symbols" "${tmp}/published.symbols" "${tmp}/built.symbols"
  echo "Registered components not compared: this ${host} Mac can't run ${archs} programs (x86_64 needs Rosetta:"
  echo "  softwareupdate --install-rosetta --agree-to-license); exported symbols compared instead."
fi
# expected entries this comparison never met: a warning, since they may be stale (or belong to the other mode)
stale="$(grep -vxF -f "${tmp}/matched" <<<"${expected}" | { if [ "${runs}" -eq 1 ]; then grep -v '^symbols '; else grep -vE "^($(tr ' ' '|' <<<"${lists}")) "; fi; } || true)"
if [ -n "${stale}" ]; then
  echo "warning: expected differences for ${platform} that this comparison didn't meet (stale?):"
  printf '  %s\n' "${stale}"
fi
if [ "${status}" -eq 0 ]; then
  what="runtime files, configure flags and Mach-O facts ($(wc -l <"${tmp}/built.deps" | tr -d ' ') binaries)"
  if [ "${runs}" -eq 1 ]; then
    what="${what} and registered components ($(for w in ${lists}; do printf '%s %s, ' "$(wc -l <"${tmp}/built.${w}" | tr -d ' ')" "${w}"; done | sed 's/, $//'))"
  else
    what="${what} and exported symbols ($(wc -l <"${tmp}/built.symbols" | tr -d ' '))"
  fi
  echo "Same ${what}, but for ${seen} expected differences (scripts/compare-published-apple.expected)."
fi
exit "${status}"
