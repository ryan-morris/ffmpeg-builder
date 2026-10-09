#!/usr/bin/env bash
# Vulkan-Shim-Loader (MIT), static, in IMPERSONATE mode: the archive is named vulkan-1 (libvulkan-1.a) so it takes the
# place an import library would. Ported from devenvy/ffmpeg scripts/deps/vulkan-shim.sh.

# Its generator reads the Vulkan-Headers submodule directly, so the submodule is needed even though the
# vulkan-headers recipe installs headers too.
retry git submodule update --init --depth 1
# CMAKE_CXX_COMPILER is required: the submodule's own CMakeLists enables CXX.
cmake -B _build \
  -DCMAKE_INSTALL_PREFIX="${DEPS_DIR}" -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=Release \
  -DVULKAN_SHIM_IMPERSONATE=ON \
  ${CMAKE_CROSS_ARGS[@]+"${CMAKE_CROSS_ARGS[@]}"}
cmake --build _build -j"${JOBS}"
# By hand rather than `cmake --install`: what's needed is precisely the impersonating archive.
lib="$(find _build -name 'libvulkan-1.a' -o -name 'libvulkan.a' | head -1)"
[ -n "${lib}" ] || { echo "ERROR: the Vulkan shim built no libvulkan-1.a / libvulkan.a" >&2; exit 1; }
# If this were ever an import library, the hard vulkan-1.dll dependency would silently come back.
file -b "${lib}" | grep -qiE 'archive' || { echo "ERROR: the Vulkan shim is not a static archive: $(file -b "${lib}")" >&2; exit 1; }
mkdir -p "${DEPS_DIR}/lib"
cp "${lib}" "${DEPS_DIR}/lib/"
