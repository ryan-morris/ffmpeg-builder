#!/usr/bin/env bash
# shaderc: Google's GLSL/HLSL -> SPIR-V compiler (Apache-2.0), static library. Ported from devenvy/ffmpeg
# scripts/deps/shaderc.sh.
# Its consumer here is libplacebo, whose Vulkan renderer compiles shaders to SPIR-V at runtime via libshaderc
# (and, on FFmpeg 8.x only, FFmpeg itself through --enable-libshaderc -- see the end). shaderc vendors glslang +
# SPIRV-Tools + SPIRV-Headers via its own utils/git-sync-deps (pinned by shaderc itself, not the ledger).

# Fetch shaderc's pinned third-party sources (glslang / SPIRV-Tools / SPIRV-Headers /
# abseil / re2 / ...), verified at their pinned revisions and retried on a partial sync --
# git-sync-deps alone can exit 0 with a clone missing (see sync-deps.sh next to this file).
source "$(dirname "${BASH_SOURCE[0]}")/sync-deps.sh"
shaderc_sync_deps "${SRC_DIR}"
cmake -B _build -G Ninja \
  -DCMAKE_INSTALL_PREFIX="${DEPS_DIR}" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSHADERC_SKIP_COPYRIGHT_CHECK=ON \
  -DSPIRV_SKIP_EXECUTABLES=ON -DENABLE_GLSLANG_BINARIES=OFF \
  ${CMAKE_CROSS_ARGS[@]+"${CMAKE_CROSS_ARGS[@]}"}
cmake --build _build --target install -j "${JOBS}"
# We link statically. Point the default shaderc.pc at the self-contained static archive
# (libshaderc_combined bundles glslang + SPIRV-Tools) and drop the shared library, so
# FFmpeg's static link of libplacebo pulls the static shaderc and nothing depends on a
# libshaderc_shared.so at runtime.
# sed -i.bak (attached suffix) is portable -- bare `sed -i` fails on BSD/macOS (osx/ios).
sed -i.bak 's/-lshaderc_shared/-lshaderc_combined/' "${DEPS_DIR}/lib/pkgconfig/shaderc.pc"
rm -f "${DEPS_DIR}/lib/pkgconfig/shaderc.pc.bak"
rm -f "${DEPS_DIR}"/lib/libshaderc_shared.*   # .so/.dylib/.dll across platforms
# libshaderc_combined is C++, but shaderc.pc declares no C++ runtime. Upstream got it onto FFmpeg's link through
# libplacebo's EXTRA_LIBS (global, so it also reached FFmpeg 8.x's --enable-libshaderc probe); a recipe never
# touches FFmpeg's flags, so the runtime goes into shaderc.pc's Libs.private, as libplacebo does with its own .pc.
# libstdc++ on GNU/Linux and mingw-w64, libc++ on Apple (clang) and the Android NDK, the static archive where the
# platform links the C++ runtime statically (upstream's CXX_RT_LIB).
case "${BUILD_RID}" in
  osx-*|ios-*|maccatalyst-*|android-*) CXX_RT_LIB="-lc++" ;;
  linux-musl-*) CXX_RT_LIB="-l:libstdc++.a" ;;
  win-arm64)    CXX_RT_LIB="-l:libc++.a" ;;
  *)            CXX_RT_LIB="-lstdc++" ;;
esac
pc="${DEPS_DIR}/lib/pkgconfig/shaderc.pc"
if grep -q '^Libs.private:' "${pc}"; then
  sed -i.bak "s|^Libs.private:.*|& ${CXX_RT_LIB}|" "${pc}"
else
  sed -i.bak "/^Libs:/a Libs.private: ${CXX_RT_LIB}" "${pc}"
fi
rm -f "${pc}.bak"
# shaderc's install also drops its glslc CLI into ${DEPS_DIR}/bin -- built for the TARGET
# arch on cross builds, so it shadows the host glslc (in the toolchain image) that shader steps
# must run. We only need libshaderc for libplacebo, so remove it. (-rf: on macOS/iOS
# glslc installs as a glslc.app bundle directory, not a plain file.)
rm -rf "${DEPS_DIR}"/bin/glslc*

# FFmpeg 8.x needs --enable-libshaderc for its Vulkan FILTERS; 9.x does not. (In this engine the flag is
# recipe.yml's configure:, and only ffmpeg/8.yml has the shaderc option.)
# The two lines obtain SPIR-V compilation differently and the difference is silent:
#   n8.1.2: scale_vulkan, xfade_vulkan, blend_vulkan, chromaber_vulkan, transpose_vulkan,
#           vflip_vulkan, color_vulkan, blackdetect_vulkan all carry *_filter_deps="vulkan
#           spirv_library", and spirv_library comes ONLY from --enable-libshaderc or
#           --enable-libglslang (configure:7368). We passed neither, and with
#           --disable-autodetect nothing turned it on, so EVERY 8.1.2 cell shipped with zero
#           Vulkan filters -- measured in the published 8.1.2.6 artifacts, including the RIDs
#           where 9.0.1 has them.
#   n9.0.1: the same filters depend on spirv_compiler instead, which configure derives by
#           probing a glslc BINARY; libshaderc was removed as an option entirely, so passing
#           it there would be an unknown-option error.
# We already build and install shaderc.pc (pointed at the static libshaderc_combined above),
# which is exactly what require_pkg_config wants.
