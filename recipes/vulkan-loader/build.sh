#!/usr/bin/env bash
# Vulkan-Loader: minimal SHARED Vulkan ICD loader (Apache-2.0), built with WSI disabled so it's libc-only and can
# be bundled in the artifact (recipe.yml runtime:). Ported from devenvy/ffmpeg scripts/deps/vulkan-loader.sh.
#
# On glibc Linux, whisper's ggml-vulkan HARD-LINKS the loader (FFmpeg itself only
# dlopens it -- vulkan.pc stays header-only). Rather than depend on the
# system libvulkan (which is built with X11/xcb WSI and would re-introduce an
# install requirement), build a minimal shared Vulkan-Loader with WSI disabled --
# its only dependency is libc -- so it can be bundled in the artifact. It still
# dlopens the system GPU ICD driver at runtime (GPU when present, CPU fallback).
#
# The Vulkan-Headers CMake package its find_package needs is installed by the vulkan-headers recipe.
cmake -S . -B _build \
  -DCMAKE_INSTALL_PREFIX="${DEPS_DIR}" -DVULKAN_HEADERS_INSTALL_DIR="${DEPS_DIR}" \
  -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF \
  -DBUILD_WSI_XLIB_SUPPORT=OFF -DBUILD_WSI_XCB_SUPPORT=OFF \
  -DBUILD_WSI_WAYLAND_SUPPORT=OFF -DBUILD_WSI_DIRECTFB_SUPPORT=OFF
cmake --build _build -j "${JOBS}"
cmake --install _build
