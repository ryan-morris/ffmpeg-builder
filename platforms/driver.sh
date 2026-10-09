#!/usr/bin/env bash
# Runs one FFmpeg build, for any platform: inside that platform's toolchain image, or natively on a macOS host.
# Everything it needs is in the plan (FFB_PLAN, /plan.json in a container), written by `ffmpeg-build build`. Recipes
# are at FFB_RECIPES (/recipes), this engine folder at ENGINE (/engine), the library cache at FFB_CACHE (/cache),
# the install prefix of the libraries at DEPS_DIR, scratch space at FFB_WORK (/work), and results go to FFB_OUT
# (/out). The defaults are the container's paths; a native build passes its own. Ports devenvy/ffmpeg's build.sh +
# steps 06-08.
#
# What differs by platform lives in /engine/setup/<setup>.sh (the plan names it), sourced here and again in every
# recipe's build after recipes/lib.sh: compilers, cross files (CMAKE_CROSS_ARGS / MESON_CROSS_ARGS), CFLAGS, and the
# hooks before_ffmpeg (just before FFmpeg's configure; it may add host-specific flags to `flags`), stage (lay out
# the archives) and check_stage.
#
# Legal files and sources (docs/building.md): each library's declared licence
# files are copied into its install tree (share/ffmpeg-build/legal/<recipe>/), with a record of its source
# (share/ffmpeg-build/sources/<recipe>.json), so a library from the cache brings both. Every fetched source is kept
# in the cache under sources/, never overwritten. Both archives get THIRD-PARTY-NOTICES.txt at their root (notices.sh),
# and <name>.sources.json lists what the build was made from.
set -euo pipefail

PLAN="${FFB_PLAN:-/plan.json}"
RECIPES="${FFB_RECIPES:-/recipes}"
CACHE="${FFB_CACHE:-/cache}"
OUT="${FFB_OUT:-/out}"
DEPS_DIR="${DEPS_DIR:-/opt/ffmpeg-build/deps}"
WORK="${FFB_WORK:-/work}"

# In a container the build runs as root; on a Linux host the cache and archives it writes would then be root's, which
# the user (and CI's cache save) can't read back. Hand them back to the host user on the way out, whatever happened.
if [ -n "${FFB_HOST_UID:-}" ]; then
  trap 'chown -R "${FFB_HOST_UID}:${FFB_HOST_GID:-${FFB_HOST_UID}}" "${CACHE}" "${OUT}" 2>/dev/null || true' EXIT
fi
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
NAME="$(jq -r .name "${PLAN}")"
RID="$(jq -r .platform "${PLAN}")"
SETUP="$(jq -r .setup "${PLAN}")"
ENGINE="${ENGINE:-/engine}"
SOURCES="${CACHE}/sources"
FFB_SHARE="share/ffmpeg-build" # under DEPS_DIR: each library's legal/<recipe>/ and sources/<recipe>.json
export SETUP ENGINE RECIPES DEPS_DIR BUILD_RID="${RID}" JOBS
mkdir -p "${DEPS_DIR}/include" "${DEPS_DIR}/lib/pkgconfig" "${WORK}/src" "${CACHE}/libs" "${SOURCES}"
export PKG_CONFIG_PATH="${DEPS_DIR}/lib/pkgconfig"
# shellcheck source=/dev/null
source "${ENGINE}/setup/${SETUP}.sh"

step() { echo; echo "==> $*"; }

# retry <attempts> <command...>: upstream's backoff for network steps
retry() {
  local attempts="$1" n=1 delay=4
  shift
  until "$@"; do
    if [ "${n}" -ge "${attempts}" ]; then return 1; fi
    echo "  failed (attempt ${n}/${attempts}) -- retrying in ${delay}s" >&2
    sleep "${delay}"
    delay=$((delay * 2))
    n=$((n + 1))
  done
}

clone_ref() { rm -rf "$3" && git clone -q --depth 1 --branch "$2" -- "$1" "$3"; }
clone_commit() {
  rm -rf "$3" && git init -q "$3" || return 1
  if git -C "$3" fetch -q --depth 1 -- "$1" "$2" 2>/dev/null; then
    git -C "$3" checkout -q FETCH_HEAD
    return
  fi
  # some hosts refuse to serve a single commit; a full clone can always check it out
  rm -rf "$3" && git clone -q -- "$1" "$3" && git -C "$3" checkout -q --detach "$2"
}

sha256() { sha256sum "$1" | cut -d' ' -f1; }

# place_once <temp file> <kept file>: the temp file becomes the kept one unless that is already there (another build
# sharing the cache kept it first): a kept source is never replaced. The temp file is gone either way.
place_once() {
  mv -n "$1" "$2" 2>/dev/null || true
  rm -f "$1"
}

# keep_source <path under sources/> <file>: a copy of a fetched source in the cache, written once and never replaced.
# A tarball is its own identity, so a download that differs from the kept copy of the same name is an error:
# upstream changed a released file.
keep_source() {
  local final="${SOURCES}/$1" tmp
  if [ ! -f "${final}" ]; then
    mkdir -p "${final%/*}" || return 1
    tmp="$(mktemp "${final}.tmp.XXXXXX")" || return 1
    cp "$2" "${tmp}" || { rm -f "${tmp}"; return 1; }
    place_once "${tmp}" "${final}"
  fi
  [ "$(sha256 "${final}")" = "$(sha256 "$2")" ] && return 0
  echo "ERROR: the download of $1 differs from the copy the cache kept earlier (sha256 $(sha256 "${final}")); if upstream really replaced it, delete sources/$1 and the library entries built from it (simplest: the whole libs/ folder) from the cache folder, and build again" >&2
  return 1
}

# no_attributes <checkout>: git archive writes the tree as checked out, not as its .gitattributes would export it
# (export-ignore drops files, export-subst rewrites them). $GIT_DIR/info/attributes outranks every .gitattributes;
# attr.tree would do it too, but needs git 2.40 and the armhf image has 2.39.
no_attributes() {
  local dir
  dir="$(git -C "$1" rev-parse --absolute-git-dir)" || return 1
  mkdir -p "${dir}/info"
  grep -qxF '* -export-ignore -export-subst' "${dir}/info/attributes" 2>/dev/null || printf '%s\n' '* -export-ignore -export-subst' >>"${dir}/info/attributes"
}

# fetch_archive <dest> <keep under> <url...>: the first url that downloads and unpacks, without its top folder. The
# download is kept as sources/<keep under>/<its file name>; KEPT and KEPT_FROM say which file and url.
# Every step checks its own result: callers test this function with ||, which switches set -e off inside it.
fetch_archive() {
  local dest="$1" keep="$2" url file="${WORK}/download.$$"
  shift 2
  for url in "$@"; do
    if ! retry 3 curl -fsSL --connect-timeout 30 "${url}" -o "${file}"; then
      echo "  ${url} unavailable; trying the next one" >&2
      continue
    fi
    rm -rf "${dest}" && mkdir -p "${dest}" || return 1
    if tar -xf "${file}" -C "${dest}" --strip-components=1; then
      KEPT="${keep}/$(basename "${url%%\?*}")"
      KEPT_FROM="${url}"
      keep_source "${KEPT}" "${file}" || return 1
      rm -f "${file}"
      return 0
    fi
    echo "  ${url} downloaded but didn't unpack; trying the next one" >&2
  done
  echo "ERROR: could not download from any of: $*" >&2
  return 1
}

# fetch_source <source json> <dest> <name>: a git ref or commit (falling back to a mirror), or tarballs (kept under
# sources/<name>/). KEPT_FROM is the url it came from.
fetch_source() {
  local src="$1" dest="$2" name="$3" git mirror kind value attempts=6
  KEPT="" KEPT_FROM=""
  if jq -e '.archives' <<<"${src}" >/dev/null; then
    local urls
    mapfile -t urls < <(jq -r '.archives[]' <<<"${src}")
    fetch_archive "${dest}" "${name}" "${urls[@]}"
    return
  fi
  git="$(jq -r .git <<<"${src}")"
  mirror="$(jq -r '.mirror // empty' <<<"${src}")"
  kind=ref
  value="$(jq -r '.ref // empty' <<<"${src}")"
  if [ -z "${value}" ]; then
    kind=commit
    value="$(jq -r .commit <<<"${src}")"
  fi
  [ -n "${mirror}" ] && attempts=2 # the origin gets a short budget when a mirror can take over
  KEPT_FROM="${git}"
  if retry "${attempts}" "clone_${kind}" "${git}" "${value}" "${dest}"; then return 0; fi
  if [ -z "${mirror}" ]; then
    echo "ERROR: could not fetch ${git} at ${value}" >&2
    return 1
  fi
  echo "  ${git} unavailable; using the mirror ${mirror}" >&2
  KEPT_FROM="${mirror}"
  retry 6 "clone_${kind}" "${mirror}" "${value}" "${dest}"
}

# keep_git <source dir> <name>: a git checkout as built, kept as sources/<name>/<name>-<commit>.tar.gz: `git archive`
# of its exact commit, with every git checkout inside it (submodules, and repositories a recipe cloned, like
# shaderc's third_party) at its own commit, every file as checked out (no_attributes). Its name holds the commit, so
# an existing copy is kept as it is: git versions differ in the bytes they write for the same commit, and the record
# takes its sha256 from the copy in place. Sets KEPT and KEPT_COMMIT.
keep_git() {
  local src="$1" name="$2" commit rel tar="${WORK}/keep.tar" part="${WORK}/keep-part.tar" tmp
  commit="$(git -C "${src}" rev-parse HEAD)"
  KEPT="${name}/${name}-${commit}.tar.gz"
  KEPT_COMMIT="${commit}"
  [ -f "${SOURCES}/${KEPT}" ] && return 0
  no_attributes "${src}"
  git -C "${src}" archive --format=tar --prefix="${name}-${commit}/" HEAD >"${tar}"
  while IFS= read -r rel; do
    no_attributes "${src}/${rel}"
    git -C "${src}/${rel}" archive --format=tar --prefix="${name}-${commit}/${rel}/" HEAD >"${part}"
    tar -Af "${tar}" "${part}"
  done < <(cd "${src}" && find . \( -path ./.git -prune \) -o \( -name .git -prune -printf '%h\n' \) | sed 's|^\./||' | LC_ALL=C sort)
  mkdir -p "${SOURCES}/${name}"
  tmp="$(mktemp "${SOURCES}/${KEPT}.tmp.XXXXXX")"
  gzip -n -c "${tar}" >"${tmp}"
  place_once "${tmp}" "${SOURCES}/${KEPT}"
  rm -f "${tar}" "${part}"
}

# copy_licenses <name> <version> <source dir> <library json>: the recipe's license-files (paths in its source, or
# files beside recipe.yml) into the library's install tree, so its cache entry carries them. A missing one fails the
# build here, before the cache entry is written.
copy_licenses() {
  local name="$1" version="$2" src="$3" dest="${DEPS_DIR}/${FFB_SHARE}/legal/$1" path where from
  local -a missing=()
  rm -rf "${dest}"
  while IFS=$'\t' read -r path where; do
    if [ "${where}" = recipe ]; then from="${RECIPES}/${name}/${path}"; else from="${src}/${path}"; fi
    if [ ! -f "${from}" ]; then
      missing+=("${path}")
      continue
    fi
    mkdir -p "$(dirname "${dest}/${path}")"
    cp "${from}" "${dest}/${path}"
  done < <(jq -r '.licenseFiles[] | [.path, (if .recipe then "recipe" else "source" end)] | @tsv' <<<"$4")
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: ${name} ${version} has no ${missing[*]}, which recipes/${name}/recipe.yml lists in license-files" >&2
    exit 1
  fi
}

# source_record <name> <version> <kept file> <url> [commit]: one library's (or FFmpeg's) entry in sources.json
source_record() {
  jq -cn --arg name "$1" --arg version "$2" --arg file "$3" --arg sha "$(sha256 "${SOURCES}/$3")" --arg url "$4" --arg commit "${5:-}" \
    '{name: $name, version: $version, origin: $url, file: $file, sha256: $sha} + (if $commit == "" then {} else {commit: $commit} end)'
}

# write_notices, check_notices and expand_vars: THIRD-PARTY-NOTICES.txt
# shellcheck source=/dev/null
source "${ENGINE}/notices.sh"

# Everything under DEPS_DIR with size, mtime, mode and link target: comparing two listings shows what a build
# added or changed. (A build that deletes files from DEPS_DIR can't be replayed from the cache; none does. A build
# that overwrites another library's file replays correctly only because it comes later in the build order and its
# key includes that library's: vulkan-loader replacing vulkan-headers' vulkan.pc is the one case.)
listing() { find "${DEPS_DIR}" \( -type f -o -type l \) -printf '%P\t%s\t%T@\t%m\t%l\n' | LC_ALL=C sort; }

# ---- libraries --------------------------------------------------------------------------------------------
: >"${WORK}/sources.jsonl" # each library's source record, for <name>.sources.json
count="$(jq '.libraries | length' "${PLAN}")"
for ((i = 0; i < count; i++)); do
  lib="$(jq -c ".libraries[${i}]" "${PLAN}")"
  name="$(jq -r .name <<<"${lib}")"
  version="$(jq -r .version <<<"${lib}")"
  key="$(jq -r .key <<<"${lib}")"
  cached="${CACHE}/libs/${key}.tar.gz"
  record="${FFB_SHARE}/sources/${name}.json"
  recorded="" kept=""
  if [ -f "${cached}" ]; then
    # a cache entry counts only with its source record and the kept source it names, unchanged since (entries from
    # before sources were kept have neither): never ship a library whose source isn't on file
    if recorded="$(tar -xzf "${cached}" -O "${record}" 2>/dev/null)" && kept="$(jq -r '.file // empty' <<<"${recorded}")" \
      && [ -n "${kept}" ] && [ -f "${SOURCES}/${kept}" ] && [ "$(sha256 "${SOURCES}/${kept}")" = "$(jq -r '.sha256 // empty' <<<"${recorded}")" ]; then
      step "${name} ${version}: from cache"
      tar -xzf "${cached}" -C "${DEPS_DIR}" || { echo "ERROR: the cache entry for ${name} ${version} is unreadable; delete ${cached#"${CACHE}"/} from the cache folder and build again" >&2; exit 1; }
      jq -c '. + {cached: true}' "${DEPS_DIR}/${record}" >>"${WORK}/sources.jsonl"
      continue
    fi
    echo "  ${name} ${version}: the cache entry's source isn't on file under sources/ as recorded; building it again"
    # a kept git archive that no longer matches its record is written again from the new checkout (a tarball isn't:
    # the download is checked against it, and a difference stops the build)
    if [ -n "${kept:-}" ] && [ -f "${SOURCES}/${kept}" ] && [ -n "$(jq -r '.commit // empty' <<<"${recorded}")" ]; then
      rm -f "${SOURCES}/${kept}"
    fi
  fi
  step "${name} ${version}: building"
  src="${WORK}/src/${name}"
  fetch_source "$(jq -c .source <<<"${lib}")" "${src}" "${name}" || { echo "ERROR: could not fetch ${name} ${version}" >&2; exit 1; }
  listing >"${WORK}/before"
  (
    cd "${src}"
    # the setup comes after lib.sh, so its cross arrays are the ones the recipe sees
    SRC_DIR="${src}" VERSION="${version}" \
      bash -c 'set -euo pipefail; source "${RECIPES}/lib.sh"; source "${ENGINE}/setup/${SETUP}.sh"; source "${RECIPES}/$1/build.sh"' _ "${name}"
  ) || { echo "ERROR: building ${name} ${version} failed (see above)" >&2; exit 1; }
  # its licence texts and its source record go into its install tree, so the cache entry carries them; the source
  # itself is kept under sources/ (a tarball when it was fetched, else a git archive of the checkout as built)
  copy_licenses "${name}" "${version}" "${src}" "${lib}"
  KEPT_COMMIT=""
  [ -n "${KEPT}" ] || keep_git "${src}" "${name}"
  mkdir -p "${DEPS_DIR}/${FFB_SHARE}/sources"
  source_record "${name}" "${version}" "${KEPT}" "${KEPT_FROM}" "${KEPT_COMMIT}" >"${DEPS_DIR}/${record}"
  jq -c '. + {cached: false}' "${DEPS_DIR}/${record}" >>"${WORK}/sources.jsonl"
  listing >"${WORK}/after"
  LC_ALL=C comm -13 "${WORK}/before" "${WORK}/after" | cut -f1 >"${WORK}/files"
  if ! grep -qv "^${FFB_SHARE}/" "${WORK}/files"; then
    echo "ERROR: ${name} installed nothing into ${DEPS_DIR}" >&2
    exit 1
  fi
  # a unique temp name (every container's shell is pid 1, so not $$), then one rename: two builds sharing the
  # cache never clobber each other's half-written file
  tmp="$(mktemp "${cached}.tmp.XXXXXX")"
  tar -czf "${tmp}" -C "${DEPS_DIR}" --verbatim-files-from -T "${WORK}/files"
  mv -f "${tmp}" "${cached}"
done

# A plan without an "ffmpeg" part only builds libraries (scripts/try-recipes.ts, when porting recipes).
if ! jq -e '.ffmpeg' "${PLAN}" >/dev/null; then
  step "libraries done (this plan has no FFmpeg build)"
  exit 0
fi

# ---- FFmpeg -----------------------------------------------------------------------------------------------
ff_version="$(jq -r .ffmpeg.version "${PLAN}")"
step "FFmpeg ${ff_version}"
mapfile -t urls < <(jq -r '.ffmpeg.archives[]' "${PLAN}")
fetch_archive "${WORK}/ffmpeg" ffmpeg "${urls[@]}" || { echo "ERROR: could not download FFmpeg ${ff_version}" >&2; exit 1; }
ff_record="$(source_record ffmpeg "${ff_version}" "${KEPT}" "${KEPT_FROM}")"

# the target's patch sets in order, each set's patches in name order. git apply works outside a repository; the ceiling
# keeps it from finding one the work folder happens to be inside, which would shift where the paths land
n_sets="$(jq '.patches | length' "${PLAN}")"
for ((i = 0; i < n_sets; i++)); do
  set_name="$(jq -r ".patches[${i}].name" "${PLAN}")"
  for ((j = 0; j < $(jq ".patches[${i}].files | length" "${PLAN}"); j++)); do
    patch_name="$(jq -r ".patches[${i}].files[${j}].name" "${PLAN}")"
    jq -j ".patches[${i}].files[${j}].text" "${PLAN}" >"${WORK}/patch.diff"
    step "patch ${set_name}/${patch_name}"
    GIT_CEILING_DIRECTORIES="$(dirname "${WORK}")" git -C "${WORK}/ffmpeg" apply --whitespace=nowarn -p1 "${WORK}/patch.diff" \
      || { echo "ERROR: patches/${set_name}: ${patch_name} doesn't apply to FFmpeg ${ff_version}; update it for this version" >&2; exit 1; }
  done
done
mapfile -t flags < <(jq -r '.ffmpeg.configure[]' "${PLAN}")
before_ffmpeg
cd "${WORK}/ffmpeg"
if ! ./configure --prefix="${WORK}/install" "${flags[@]}"; then
  tail -n 200 ffbuild/config.log >&2 || true
  echo "ERROR: FFmpeg's configure failed (the end of ffbuild/config.log is above)" >&2
  exit 1
fi
# FFmpeg compiles paths from config.h into what ships: its configure line (ffmpeg -buildconf) and the programs' data
# folder (FFMPEG_DATADIR, under the install prefix). A native build's folders are under the builder's home: record
# them as a container build does. In a container this changes nothing.
sed -i -e "s|${DEPS_DIR}|/opt/ffmpeg-build/deps|g" -e "s|${WORK}|/work|g" config.h
missing=()
while read -r flag; do
  grep -qx "CONFIG_${flag}=yes" ffbuild/config.mak || missing+=("${flag}")
done < <(jq -r '.ffmpeg.verify[]' "${PLAN}")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "ERROR: FFmpeg's configure left out: ${missing[*]} (asked for, but not enabled)" >&2
  exit 1
fi
make -j"${JOBS}"
make install

# ---- stage (upstream steps/08 + release.yml) ------------------------------------------------------------------
step "staging ${NAME}"
RUN="${WORK}/stage/run"
DEV="${WORK}/stage/dev"
mkdir -p "${RUN}" "${DEV}"
stage "${WORK}/install" "${RUN}" "${DEV}"
# one file at the root of both archives carries every licence and notice (in place of upstream's legal/ folder)
write_notices "${RUN}/THIRD-PARTY-NOTICES.txt" "${WORK}/ffmpeg" "${WORK}/sources.jsonl"
cp "${RUN}/THIRD-PARTY-NOTICES.txt" "${DEV}/"
check_notices "${RUN}/THIRD-PARTY-NOTICES.txt"
check_notices "${DEV}/THIRD-PARTY-NOTICES.txt"

step "checking ${NAME}"
check_stage "${RUN}"

tar -czf "${OUT}/${NAME}.tar.gz" -C "${RUN}" .
tar -czf "${OUT}/${NAME}-dev.tar.gz" -C "${DEV}" .
# what the build was made from: FFmpeg's tarball, each library's kept source (from the cache too) and the patch sets,
# each kept file named relative to the cache's sources/ folder
jq -n --arg name "${NAME}" --argjson ffmpeg "${ff_record}" --slurpfile libraries "${WORK}/sources.jsonl" --slurpfile plan "${PLAN}" '
  $plan[0] as $p
  | { artifact: $name, target: $p.target, platform: $p.platform, license: $p.license, release: ($p.release // null),
      ffmpeg: $ffmpeg, libraries: $libraries, patches: [$p.patches[] | {name, sha256}] }' >"${OUT}/${NAME}.sources.json.tmp"
mv -f "${OUT}/${NAME}.sources.json.tmp" "${OUT}/${NAME}.sources.json"
# and the kept files themselves beside it: a release is bundled on another machine, whose cache doesn't have them
rm -rf "${OUT}/${NAME}.sources"
jq -r '.ffmpeg.file, .libraries[].file' "${OUT}/${NAME}.sources.json" | while read -r kept; do
  mkdir -p "$(dirname "${OUT}/${NAME}.sources/${kept}")"
  cp "${SOURCES}/${kept}" "${OUT}/${NAME}.sources/${kept}"
done
step "done: ${NAME}.tar.gz, ${NAME}-dev.tar.gz, ${NAME}.sources.json and the sources in ${NAME}.sources/"
