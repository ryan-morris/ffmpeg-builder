#!/usr/bin/env bash
# libplacebo: GPU-accelerated video processing (HDR tone-mapping, high-quality scaling, colorspace conversion) built
# on Vulkan (LGPL-2.1-or-later), static. Ported from devenvy/ffmpeg scripts/deps/libplacebo.sh.
# Enables FFmpeg's libplacebo filter. Needs the Vulkan headers and a SPIR-V compiler (shaderc).

# libplacebo builds from vendored submodules: glad (Vulkan loader), jinja + markupsafe
# (build-time templating), and fast_float (float parsing -- required where the C++ stdlib
# lacks floating-point std::from_chars, e.g. the Android NDK / older libc++). Fetch just
# those (skip demos/nuklear and the bundled Vulkan-Headers -- we supply our own).
# Retried with backoff, as upstream's git wrapper retried `git submodule` (a network step).
n=1 delay=4
until git submodule update --init --depth 1 \
    3rdparty/glad 3rdparty/jinja 3rdparty/markupsafe 3rdparty/fast_float; do
  if [ "${n}" -ge 6 ]; then
    echo "ERROR: libplacebo's submodules could not be fetched after ${n} attempts" >&2
    exit 1
  fi
  echo "  git submodule update failed (attempt ${n}/6) -- retrying in ${delay}s" >&2
  sleep "${delay}"
  delay=$((delay * 2)) n=$((n + 1))
done

meson_build \
  -Dvulkan=enabled -Dshaderc=enabled -Dglslang=disabled -Dopengl=disabled \
  -Ddemos=false -Dtests=false -Dlcms=enabled -Dd3d11=disabled \
  -Dvk-proc-addr=disabled
# -Dvk-proc-addr=disabled: don't link vkGetInstanceProcAddr ourselves -- FFmpeg's vf_libplacebo supplies
# the Vulkan loader/proc-addr at runtime. Linking it needs a Vulkan import lib the
# mingw/win deps don't provide (undefined vkGetInstanceProcAddr at FFmpeg link).

# libplacebo and the static shaderc it pulls are C++ (std::to_chars / std::from_chars),
# but their pkg-config files declare no C++ runtime. Upstream added it to FFmpeg's link through EXTRA_LIBS;
# a recipe never touches FFmpeg's flags, so it goes into libplacebo.pc's Libs.private instead, which FFmpeg's
# static --enable-libplacebo probe and final link read through pkg-config --static.
# The runtime differs by toolchain: libstdc++ on GNU/Linux and mingw-w64, libc++ on Apple (clang) and the Android
# NDK; the static archive where the platform links the C++ runtime statically (upstream's CXX_RT_LIB).
case "${BUILD_RID}" in
  osx-*|ios-*|maccatalyst-*|android-*) CXX_RT_LIB="-lc++" ;;  # clang libc++ (matches whisper/x265)
  linux-musl-*) CXX_RT_LIB="-l:libstdc++.a" ;;                # musl: no host C++ runtime (platform/linux.sh)
  win-arm64)    CXX_RT_LIB="-l:libc++.a" ;;                   # llvm-mingw (platform/windows.sh)
  *)            CXX_RT_LIB="-lstdc++" ;;
esac
pc="${DEPS_DIR}/lib/pkgconfig/libplacebo.pc"
if grep -q '^Libs.private:' "${pc}"; then
  sed -i.bak "s|^Libs.private:.*|& ${CXX_RT_LIB}|" "${pc}"
else
  sed -i.bak "/^Libs:/a Libs.private: ${CXX_RT_LIB}" "${pc}"
fi
rm -f "${pc}.bak"
