#!/usr/bin/env bash
# Vulkan-Headers: Khronos Vulkan API headers (Apache-2.0 OR MIT) for FFmpeg's Vulkan filters/hwaccel and whisper's
# GPU backend, header-only. Ported from devenvy/ffmpeg scripts/deps/vulkan-headers.sh.
mkdir -p "${DEPS_DIR}/include"
cp -r include/vulkan "${DEPS_DIR}/include/"
cp -r include/vk_video "${DEPS_DIR}/include/"
# Install the Vulkan registry (vk.xml) too: libplacebo generates its Vulkan bindings
# from it and looks for it under <prefix>/share/vulkan/registry. Ship the copy that
# matches these headers so the build never depends on a system-provided vk.xml.
mkdir -p "${DEPS_DIR}/share/vulkan/registry"
cp registry/vk.xml "${DEPS_DIR}/share/vulkan/registry/"

# Install the Vulkan-Headers CMake package so the loader's find_package works. (Upstream did this at the top of
# vulkan-loader.sh, from the Vulkan-Headers checkout; here the loader recipe only has its own source, so the
# headers recipe installs it. It is header-only: it adds the VulkanHeaders CMake config and nothing that links.)
cmake -S . -B _build -DCMAKE_INSTALL_PREFIX="${DEPS_DIR}" >/dev/null
cmake --install _build >/dev/null

VULKAN_HEADER_FILE="${DEPS_DIR}/include/vulkan/vulkan_core.h"
VULKAN_HEADER_REV="$(awk '/^#define VK_HEADER_VERSION / { print $3; exit }' "${VULKAN_HEADER_FILE}")"
if grep -q '^#define VK_API_VERSION_1_4 ' "${VULKAN_HEADER_FILE}"; then
  VULKAN_API_VERSION="1.4"
elif grep -q '^#define VK_API_VERSION_1_3 ' "${VULKAN_HEADER_FILE}"; then
  VULKAN_API_VERSION="1.3"
else
  echo "Vulkan support requires Vulkan 1.3+ headers." >&2
  exit 1
fi

VULKAN_PC_VERSION="${VULKAN_API_VERSION}.${VULKAN_HEADER_REV}"
mkdir -p "${DEPS_DIR}/lib/pkgconfig"
cat > "${DEPS_DIR}/lib/pkgconfig/vulkan.pc" <<PKGCONFIG
prefix=${DEPS_DIR}
includedir=\${prefix}/include

Name: Vulkan-Headers
Description: Vulkan header-only SDK for FFmpeg configure checks
Version: ${VULKAN_PC_VERSION}
Cflags: -I\${includedir}
PKGCONFIG
echo "Vulkan headers ${VULKAN_PC_VERSION} installed"
