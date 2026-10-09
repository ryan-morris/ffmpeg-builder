# The linux-musl-x64 toolchain image: upstream devenvy/ffmpeg's pinned Alpine (musl libc), provisioned with the
# packages upstream's 03_install_packages.sh installs for musl. Artifacts link libgcc and libstdc++ statically, so
# they run on any musl system. The library cache keys on this image's Docker ID.
FROM mirror.gcr.io/library/alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# bash, jq and GNU findutils/coreutils/tar/sed/grep for the driver (BusyBox lacks find -printf and friends);
# xxd for libvmaf's built-in models; python3 for meson. Alpine's own glslc is new enough (probed below).
RUN apk add --no-cache \
      bash autoconf automake libtool build-base cmake curl diffutils gperf git linux-headers m4 meson nasm ninja \
      patchelf perl pkgconf xz yasm xxd glslang shaderc jq python3 tar findutils coreutils sed grep

# FFmpeg 8.1+ / 9.x probe the shader compiler with Vulkan 1.4 / SPIR-V 1.6; a glslc that predates Vulkan 1.4 makes
# configure drop every Vulkan filter silently. The image fails to build rather than produce such builds.
RUN printf '#version 460\nvoid main() {}\n' > /tmp/probe.comp \
 && glslc --target-env=vulkan1.4 --target-spv=spv1.6 -std=460 -c /tmp/probe.comp -o /tmp/probe.spv \
 && rm -f /tmp/probe.comp /tmp/probe.spv
