#!/usr/bin/env bash
# win-x64 (mingw-w64 gcc, win32 threads) and win-arm64 (llvm-mingw clang), cross-compiled in images/cross-windows.
# Ports upstream devenvy/ffmpeg platform/windows.sh, the Windows parts of 05_write_toolchain.sh, 07_build_ffmpeg.sh's
# .pc rewrites and 08_stage_artifacts.sh's Windows staging. Sourced by platforms/driver.sh and, after
# recipes/lib.sh, by every recipe build.

case "${BUILD_RID}" in
  win-x64)
    CROSS_PREFIX="x86_64-w64-mingw32"
    # the -win32 thread model: no runtime dependency on libwinpthread-1.dll (the -posix variant pulls it in)
    CC="${CROSS_PREFIX}-gcc-win32"
    CXX="${CROSS_PREFIX}-g++-win32"
    # upstream's CMake toolchain names the default-alternative driver; kept as upstream builds it
    CMAKE_CC="${CROSS_PREFIX}-gcc"
    CMAKE_CXX="${CROSS_PREFIX}-g++"
    CMAKE_PROCESSOR="x86_64"
    MESON_CPU="x86_64"
    DLLTOOL_MACHINE="i386:x86-64" # the import libraries' machine type is the target's, not the build host's
    ;;
  win-arm64)
    # llvm-mingw: clang drivers, win32 threads by default; it names the C++ runtime as a static archive because a
    # bare -lstdc++ resolves to libc++.dll.a and collides with -static-libstdc++ (upstream windows.sh)
    CROSS_PREFIX="aarch64-w64-mingw32"
    CC="${CROSS_PREFIX}-clang"
    CXX="${CROSS_PREFIX}-clang++"
    CMAKE_CC="${CC}"
    CMAKE_CXX="${CXX}"
    CMAKE_PROCESSOR="ARM64"
    MESON_CPU="aarch64"
    DLLTOOL_MACHINE="arm64"
    export CXX_RT_LIB="-l:libc++.a"
    ;;
  *) echo "ERROR: setup/windows.sh: unexpected platform ${BUILD_RID}" >&2; exit 1 ;;
esac
export CROSS_PREFIX CROSS_HOST="${CROSS_PREFIX}" CC CXX
export AR="${CROSS_PREFIX}-ar" RANLIB="${CROSS_PREFIX}-ranlib" NM="${CROSS_PREFIX}-nm" STRIP="${CROSS_PREFIX}-strip"

# The CMake toolchain and meson cross files (upstream 05_write_toolchain.sh). DEPS_DIR on the include and library
# paths: meson's cmake dependency lookup can't see the prefix on a cross build, so consumers like librist would
# otherwise fall back to vendored copies of what the lock pins.
TOOLCHAIN_DIR="${DEPS_DIR%/*}/toolchain"
mkdir -p "${TOOLCHAIN_DIR}"
cat >"${TOOLCHAIN_DIR}/windows.cmake" <<CMAKE
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR ${CMAKE_PROCESSOR})
set(CMAKE_C_COMPILER ${CMAKE_CC})
set(CMAKE_CXX_COMPILER ${CMAKE_CXX})
set(CMAKE_RC_COMPILER ${CROSS_PREFIX}-windres)
set(CMAKE_FIND_ROOT_PATH ${DEPS_DIR})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
CMAKE
cat >"${TOOLCHAIN_DIR}/windows-meson.ini" <<MESON
[binaries]
c = '${CC}'
cpp = '${CXX}'
ar = '${CROSS_PREFIX}-ar'
strip = '${CROSS_PREFIX}-strip'
windres = '${CROSS_PREFIX}-windres'
pkg-config = 'pkg-config'
[host_machine]
system = 'windows'
cpu_family = '${MESON_CPU}'
cpu = '${MESON_CPU}'
endian = 'little'
[properties]
pkg_config_libdir = '${DEPS_DIR}/lib/pkgconfig'
needs_exe_wrapper = true
[built-in options]
c_args = ['-I${DEPS_DIR}/include']
cpp_args = ['-I${DEPS_DIR}/include']
c_link_args = ['-L${DEPS_DIR}/lib']
cpp_link_args = ['-L${DEPS_DIR}/lib']
MESON
CMAKE_CROSS_ARGS=(-DCMAKE_TOOLCHAIN_FILE="${TOOLCHAIN_DIR}/windows.cmake")
MESON_CROSS_ARGS=(--cross-file "${TOOLCHAIN_DIR}/windows-meson.ini")

# Upstream 07_build_ffmpeg.sh: FFmpeg links shared DLLs, and the driver ignores -static-libgcc/-static-libstdc++ with
# -shared, so runtimes a dependency's .pc names would become DLL imports (libstdc++-6.dll, libwinpthread-1.dll,
# libc++.dll, libunwind.dll) that the archive doesn't ship. Every .pc loses -lgcc_s (it also collides with the static
# libgcc_eh); win-x64 wraps -lpthread/-lstdc++ in -Bstatic, win-arm64 names the static archives. The substitutions
# loop because two adjacent matches share the space between them. Running it twice changes nothing.
before_ffmpeg() {
  local pc
  for pc in "${DEPS_DIR}"/lib/pkgconfig/*.pc; do
    [ -f "${pc}" ] || continue
    sed -i -E -e ':a' -e 's/(^|[[:space:]])-lgcc_s([[:space:]]|$)/\1\2/' -e 'ta' "${pc}"
    if [[ "${BUILD_RID}" == win-arm64 ]]; then
      sed -i -E -e ':a' \
        -e 's/(^|[[:space:]])-l(std)?c\+\+([[:space:]]|$)/\1-l:libc++.a\3/' \
        -e 's/(^|[[:space:]])-lunwind([[:space:]]|$)/\1-l:libunwind.a\2/' \
        -e 's/(^|[[:space:]])-l(win)?pthread([[:space:]]|$)/\1-l:libwinpthread.a\3/' \
        -e 'ta' "${pc}"
      continue
    fi
    grep -q -- '-Wl,-Bstatic' "${pc}" && continue
    sed -i -e 's/-lpthread/-Wl,-Bstatic -lpthread -Wl,-Bdynamic/g' -e 's/-lstdc++/-Wl,-Bstatic -lstdc++ -Wl,-Bdynamic/g' "${pc}"
  done
}

# Upstream 08_stage_artifacts.sh (win-*): FFmpeg's DLLs and programs in the runtime archive; headers, relocatable .pc
# files and MSVC import libraries (lib/avcodec.lib: gendef, then llvm-dlltool, named by the library's base name so
# MSVC and CMake find them) in the -dev archive.
stage() {
  local install="$1" run="$2" dev="$3" pc dll stem
  mkdir -p "${dev}/include" "${dev}/lib/pkgconfig"
  cp -a "${install}/bin/"*.dll "${install}/bin/ffmpeg.exe" "${install}/bin/ffprobe.exe" "${run}/"
  cp -a "${install}/include/." "${dev}/include/"
  for pc in "${install}/lib/pkgconfig/"*.pc; do
    sed -e 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
        -e 's|^exec_prefix=.*|exec_prefix=${prefix}|' \
        -e 's|^libdir=.*|libdir=${prefix}/lib|' \
        -e 's|^includedir=.*|includedir=${prefix}/include|' \
        "${pc}" >"${dev}/lib/pkgconfig/$(basename "${pc}")"
  done
  for dll in "${run}"/*.dll; do
    stem="$(basename "${dll}" .dll)" # avcodec-63
    gendef - "${dll}" >"/tmp/${stem}.def"
    llvm-dlltool -m "${DLLTOOL_MACHINE}" -d "/tmp/${stem}.def" -D "$(basename "${dll}")" -l "${dev}/lib/${stem%-*}.lib"
  done
}

# The programs can't run here, so check what Windows would load (upstream test/win.sh audit_runtime_dll_imports): no
# DLL or program may import a toolchain runtime the archive doesn't ship (each was a real failure upstream: ffmpeg.exe
# died before main) -- libgcc_s*, libstdc++*, libwinpthread*, libc++*, libunwind*, libssp*, libatomic*, libgomp* -- nor
# vulkan-1.dll (the shim resolves it at run time, so machines without a Vulkan driver still start). Then the
# configure line FFmpeg embeds.
check_stage() {
  local f imports bad=0 runtime='^(libgcc_s|libstdc\+\+|libwinpthread|libc\+\+|libunwind|libssp|libatomic|libgomp)[^/]*\.dll$|^vulkan-1\.dll$'
  for f in "$1"/*.dll "$1"/*.exe; do
    imports="$("${CROSS_PREFIX}-objdump" -p "${f}" | sed -n 's/^[[:space:]]*DLL Name: //p')"
    if grep -qiE "${runtime}" <<<"${imports}"; then
      echo "ERROR: $(basename "${f}") imports $(grep -iE "${runtime}" <<<"${imports}" | tr '\n' ' ')which the archive doesn't ship" >&2
      bad=1
    fi
  done
  [ "${bad}" -eq 0 ] || exit 1
  echo "imports: no toolchain runtime DLLs, no vulkan-1.dll"
  grep -aom1 -- '--prefix=[ -~]*' "$1/ffmpeg.exe" || true
}
