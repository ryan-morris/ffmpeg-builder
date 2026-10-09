#!/usr/bin/env bash
# fontconfig: system font discovery so drawtext can pick fonts by name (HPND-sell-variant), static. Ported from devenvy/ffmpeg scripts/deps/fontconfig.sh.

# M6: fontconfig compiles its sysconfdir/cachedir/templatedir INTO the library, so building
# with --prefix=${DEPS_DIR} baked the build machine's path into every shipped artifact:
#   /home/runner/work/ffmpeg/ffmpeg/.build/<rid>/deps/etc/fonts
# a directory that exists on no consumer machine. The first attempt at this simply pinned the
# prefix to /etc and /var and was REVERTED in 72f3c53, because the same options also decide
# where `meson install` WRITES -- so the install tried to create /var/cache and failed with
# permission denied on two platforms.
#
# DESTDIR staging separates the two concerns, which is what BtbN does. Configure with the
# RUNTIME prefix so the compiled-in lookup paths are the ones a real system has, then install
# under DESTDIR so nothing is written outside the build tree, then relocate the staged tree
# into DEPS_DIR for build-time linking and rewrite the .pc prefix so pkg-config still resolves
# against DEPS_DIR rather than the runtime prefix.
FC_RUNTIME_PREFIX="/usr"
FC_STAGE="${SRC_DIR}/_stage"
rm -rf "${FC_STAGE}"
FC_ARGS=(
  --prefix="${FC_RUNTIME_PREFIX}"
  --libdir="${FC_RUNTIME_PREFIX}/lib"
  --sysconfdir=/etc
  --localstatedir=/var
  --default-library=static
  --buildtype=release
  -Ddoc=disabled
  -Dtests=disabled
  -Dtools=disabled
  -Dcache-build=disabled
  # NLS off: fontconfig does dependency('intl') and, when it resolves, links libintl into
  # everything downstream. On the Intel macOS runner that resolves to HOMEBREW's
  # /usr/local/opt/gettext/lib/libintl.8.dylib -- a library present on that runner and on no
  # consumer machine, which we do not bundle. arm64 was unaffected only because its Homebrew
  # prefix differs, so the leak was silently Intel-only. Translated fontconfig messages are
  # meaningless for a library statically embedded in FFmpeg.
  -Dnls=disabled
)

# Cross targets use the shared Meson cross file.
meson setup _build "${FC_ARGS[@]}" ${MESON_CROSS_ARGS[@]+"${MESON_CROSS_ARGS[@]}"}
meson compile -C _build -j "${JOBS}"
# DESTDIR keeps the install inside the build tree: with sysconfdir=/etc and localstatedir=/var
# an un-staged install would try to write to the real filesystem, which is exactly what failed
# before. Everything lands under ${FC_STAGE} instead.
DESTDIR="${FC_STAGE}" meson install -C _build

# Relocate the staged prefix into DEPS_DIR so the rest of the build links against it as usual.
[ -d "${FC_STAGE}${FC_RUNTIME_PREFIX}" ] || {
  echo "ERROR: fontconfig DESTDIR install produced no ${FC_RUNTIME_PREFIX} tree under ${FC_STAGE}" >&2
  find "${FC_STAGE}" -maxdepth 3 2>/dev/null | sed 's/^/  /' >&2
  exit 1
}
mkdir -p "${DEPS_DIR}"
cp -a "${FC_STAGE}${FC_RUNTIME_PREFIX}/." "${DEPS_DIR}/"
# fontconfig also installs /etc/fonts/fonts.conf and conf.d, outside the prefix. Those are
# deliberately NOT relocated: staging takes libraries, binaries, headers and pkg-config
# files, so anything copied into DEPS_DIR/etc never reaches the artifact and would
# be dead weight. The library's compiled-in sysconfdir is /etc, so at runtime it reads the
# HOST's font configuration, which is the correct behaviour on a real system and the reason
# for configuring with the runtime prefix in the first place. With no host configuration
# present, fontconfig falls back to its built-in defaults rather than failing.
_pc="${DEPS_DIR}/lib/pkgconfig/fontconfig.pc"
[ -f "${_pc}" ] || { echo "ERROR: fontconfig.pc missing after staging: ${_pc}" >&2; exit 1; }
sed -i.bak -e "s|^prefix=.*|prefix=${DEPS_DIR}|" \
           -e "s|^libdir=.*|libdir=${DEPS_DIR}/lib|" \
           -e "s|^includedir=.*|includedir=${DEPS_DIR}/include|" "${_pc}"
rm -f "${_pc}.bak"
grep -q "^prefix=${DEPS_DIR}$" "${_pc}" \
  || { echo "ERROR: failed to repoint fontconfig.pc at DEPS_DIR" >&2; cat "${_pc}" >&2; exit 1; }
echo "fontconfig staged: runtime paths are /etc + /var, build-time pkg-config points at DEPS_DIR."
