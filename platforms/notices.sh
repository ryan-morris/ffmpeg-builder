#!/usr/bin/env bash
# THIRD-PARTY-NOTICES.txt, the one file at the root of both archives that carries every licence and notice a build
# needs: the plan's header (effective licence and why, FFmpeg's modifications), BUILD, SOURCE, FFmpeg's own texts
# (LICENSE.md, CREDITS, the governing COPYING texts), then each library's declared licence files under its own
# heading, the patch sets' and the files the platform ships. Sourced by platforms/driver.sh (and by the tests); reads
# PLAN, DEPS_DIR, FFB_SHARE and SETUP as the driver sets them.

NOTICES_RULE="================================================================================"

# expand_vars <text>: ${NAME} replaced by that variable of the platform's setup (an unset one is an error). One pass,
# left to right: a value is never expanded again.
expand_vars() {
  local rest="$1" out="" var
  while [[ "${rest}" =~ ^([^$]*)\$\{([A-Za-z_][A-Za-z0-9_]*)\}(.*)$ ]]; do
    var="${BASH_REMATCH[2]}"
    [ -n "${!var:-}" ] || { echo "ERROR: ${var} isn't set by platforms/setup/${SETUP:-?}.sh, but platforms.yml names it in $1" >&2; return 1; }
    out+="${BASH_REMATCH[1]}${!var}"
    rest="${BASH_REMATCH[3]}"
  done
  printf '%s' "${out}${rest}"
}

# ffmpeg_configuration <config.h>: FFmpeg's configure line as it compiled it in (what ffmpeg -buildconf prints)
ffmpeg_configuration() {
  sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "$1" | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g'
}

notices_section() { printf '\n%s\n%s\n%s\n\n' "${NOTICES_RULE}" "$1" "${NOTICES_RULE}"; }

# notices_text <heading> <file>: "--- heading ---" and the file in full, ending with a newline
notices_text() {
  printf -- '--- %s ---\n\n' "$1"
  cat "$2"
  [ -z "$(tail -c 1 "$2")" ] || echo
  echo
}

# write_notices <out file> <FFmpeg source dir> <source records (JSON lines)>
write_notices() {
  local out="$1" ff="$2" records="$3" f name version spdx rec origin commit kept sha path n i j tmp notice
  tmp="$(mktemp -d)"
  {
    jq -j '.notices.header' "${PLAN}"

    notices_section BUILD
    [ -f "${ff}/config.h" ] || { echo "ERROR: FFmpeg's config.h is missing; THIRD-PARTY-NOTICES.txt names its configure line" >&2; exit 1; }
    printf 'FFmpeg configure line (as ffmpeg -buildconf prints it):\n  %s\n\n' "$(ffmpeg_configuration "${ff}/config.h")"
    jq -j '.notices.build' "${PLAN}"

    notices_section SOURCE
    jq -j '.notices.source' "${PLAN}"

    notices_section FFMPEG
    printf 'FFmpeg %s: its LICENSE.md and CREDITS, then the license texts that govern this build, in full.\n\n' "$(jq -r .ffmpeg.version "${PLAN}")"
    for f in LICENSE.md CREDITS $(jq -r '.notices.governing[]' "${PLAN}"); do
      [ -f "${ff}/${f}" ] || { echo "ERROR: FFmpeg's source has no ${f} for THIRD-PARTY-NOTICES.txt" >&2; exit 1; }
      notices_text "${f}" "${ff}/${f}"
    done

    notices_section COMPONENTS
    echo 'Each library built into this build: its licence, where its source comes from (upstream, at the exact version and'
    echo 'commit), and every licence file it ships, in full.'
    echo
    while IFS=$'\t' read -r name version spdx; do
      rec="$(jq -c --arg n "${name}" 'select(.name == $n)' "${records}" | head -1)"
      [ -n "${rec}" ] || { echo "ERROR: ${name} has no source record for THIRD-PARTY-NOTICES.txt" >&2; exit 1; }
      origin="$(jq -r .origin <<<"${rec}")"
      commit="$(jq -r '.commit // empty' <<<"${rec}")"
      kept="$(jq -r .file <<<"${rec}")"
      sha="$(jq -r .sha256 <<<"${rec}")"
      printf '== %s %s ==\n\n' "${name}" "${version}"
      printf 'License: %s\n' "${spdx}"
      printf 'Origin: %s\n' "${origin}"
      [ -z "${commit}" ] || printf 'Commit: %s\n' "${commit}"
      printf 'Source: %s (sha256 %s)\n\n' "${kept}" "${sha}"
      while IFS= read -r path; do
        f="${DEPS_DIR}/${FFB_SHARE}/legal/${name}/${path}"
        [ -f "${f}" ] || { echo "ERROR: ${name}'s licence file ${path} isn't in ${DEPS_DIR}/${FFB_SHARE}/legal/${name}" >&2; exit 1; }
        notices_text "${path}" "${f}"
      done < <(jq -r --arg n "${name}" '.libraries[] | select(.name == $n) | .licenseFiles[].path' "${PLAN}")
    done < <(jq -r '.libraries | sort_by(.name)[] | [.name, .version, .license] | @tsv' "${PLAN}")

    n="$(jq '.patches | length' "${PLAN}")"
    if [ "${n}" -gt 0 ]; then
      notices_section 'PATCH SETS'
      echo 'The patch sets applied to FFmpeg, with their licence and licence texts.'
      echo
      for ((i = 0; i < n; i++)); do
        printf '== %s ==\n\n' "$(jq -r ".patches[${i}].name" "${PLAN}")"
        printf 'License: %s\n' "$(jq -r ".patches[${i}].license" "${PLAN}")"
        printf 'sha256: %s\n' "$(jq -r ".patches[${i}].sha256" "${PLAN}")"
        printf 'Patches: %s\n\n' "$(jq -r "[.patches[${i}].files[].name] | if length == 0 then \"none for this FFmpeg version\" else join(\", \") end" "${PLAN}")"
        for ((j = 0; j < $(jq ".patches[${i}].licenses | length" "${PLAN}"); j++)); do
          jq -j ".patches[${i}].licenses[${j}].text" "${PLAN}" >"${tmp}/text"
          notices_text "$(jq -r ".patches[${i}].licenses[${j}].path" "${PLAN}")" "${tmp}/text"
        done
      done
    fi

    if [ "$(jq '.ships | length' "${PLAN}")" -gt 0 ]; then
      notices_section 'FILES THE PLATFORM SHIPS'
      echo "Parts of the platform's toolchain that the archives carry or link in, each with its licence and notice."
      echo
      while IFS=$'\t' read -r name spdx notice; do
        notice="$(expand_vars "${notice}")" || exit 1
        [ -f "${notice}" ] || { echo "ERROR: ${notice}, the notice platforms.yml names for ${name}, is missing" >&2; exit 1; }
        printf '== %s ==\n\n' "${name}"
        printf 'License: %s\n\n' "${spdx}"
        notices_text "$(basename "${notice}")" "${notice}"
      done < <(jq -r '.ships[] | [.file, .license, .notice] | @tsv' "${PLAN}")
    fi
  } >"${out}"
  rm -rf "${tmp}"
}

# check_notices <file>: there, with FFmpeg's header first, its governing texts, and a section for every library
check_notices() {
  local file="$1" missing=() name version t
  [ -f "${file}" ] || { echo "ERROR: ${file} is missing" >&2; exit 1; }
  head -n 1 "${file}" | grep -q "^FFmpeg $(jq -r .ffmpeg.version "${PLAN}") — " || { echo "ERROR: ${file} doesn't start with FFmpeg's header" >&2; exit 1; }
  for t in LICENSE.md CREDITS $(jq -r '.notices.governing[]' "${PLAN}"); do
    grep -qxF -- "--- ${t} ---" "${file}" || missing+=("${t}")
  done
  while IFS=$'\t' read -r name version; do
    grep -qxF -- "== ${name} ${version} ==" "${file}" || missing+=("${name} ${version}")
  done < <(jq -r '.libraries[] | [.name, .version] | @tsv' "${PLAN}")
  [ "${#missing[@]}" -eq 0 ] || { echo "ERROR: $(basename "${file}") lacks: ${missing[*]}" >&2; exit 1; }
}
