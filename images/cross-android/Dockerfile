# The Android toolchain image: cross-compiles android-arm64 and android-x64 with the Android NDK, as upstream
# devenvy/ffmpeg does (platform/android.sh). Upstream used whatever NDK its CI runner had (27.3.13750724, r27d, for the
# published 9.0.2.3 builds); here that release is pinned by version and SHA-256, on Ubuntu pinned by digest.
# The library cache keys on this image's Docker ID.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ENV DEBIAN_FRONTEND=noninteractive
# The build tools upstream installs, a native gcc/g++ for host tools (glslc below), patchelf for the unversioned
# sonames, unzip for the NDK.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake nasm yasm autoconf automake libtool pkg-config gperf m4 perl python3 python3-pip python3-venv \
      git curl ca-certificates xz-utils bzip2 jq xxd file unzip patch patchelf \
 && rm -rf /var/lib/apt/lists/*
# meson/ninja pinned as in the other images.
RUN python3 -m venv /opt/meson && /opt/meson/bin/pip install --no-cache-dir meson==1.12.1 ninja==1.13.2 \
 && ln -sf /opt/meson/bin/meson /usr/local/bin/meson && ln -sf /opt/meson/bin/ninja /usr/local/bin/ninja

# The Android NDK, r27d (27.3.13750724), verified by SHA-256.
ARG NDK=r27d
ARG NDK_SHA256=601246087a682d1944e1e16dd85bc6e49560fe8b6d61255be2829178c8ed15d9
RUN curl -fsSL -o /tmp/ndk.zip "https://dl.google.com/android/repository/android-ndk-${NDK}-linux.zip" \
 && echo "${NDK_SHA256}  /tmp/ndk.zip" | sha256sum -c - \
 && unzip -q /tmp/ndk.zip -d /opt \
 && mv "/opt/android-ndk-${NDK}" /opt/android-ndk \
 && rm /tmp/ndk.zip
ENV ANDROID_NDK_HOME=/opt/android-ndk

# glslc (Vulkan shader compiler) from the pinned shaderc -- the distro's predates Vulkan 1.4, and FFmpeg's Vulkan filters
# and whisper's ggml-vulkan shaders need it at build time. Upstream 03_install_packages.sh builds it the same way.
# "Is glslc present" is the WRONG question -- it has to be new enough. FFmpeg 8.1+ and 9.x probe the shader compiler
# with `glslc --target-env=vulkan1.4 --target-spv=spv1.6 -std=460`; a glslc that predates Vulkan 1.4 rejects it,
# configure disables spirv_compiler and silently drops EVERY Vulkan filter. So the probe below is a build-time
# assertion: an image whose glslc cannot do it does not build.
# Pinned to the same shaderc tag as the shaderc recipe's locked version (devenvy deps.json .defaults.shaderc): an
# unpinned clone tracked shaderc master and git-sync-deps pulled glslang/SPIRV-Tools HEAD -- a glslang change made
# spirv-opt emit LocalSizeId, which whisper's ggml-vulkan shaders (--target-env=vulkan1.2) reject.
# utils/git-sync-deps clones in worker threads whose failures never reach its exit status, so every DEPS entry is
# verified on disk at its pinned revision (as upstream's shaderc_sync_deps does) and the sync retried until it is.
ARG SHADERC_TAG=v2026.4
RUN <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
src="$(mktemp -d)"
for n in 1 2 3 4 5 6; do
  git clone -q --depth 1 --branch "${SHADERC_TAG}" https://github.com/google/shaderc "${src}" && break
  [ "${n}" -lt 6 ] || { echo "ERROR: could not clone shaderc ${SHADERC_TAG}" >&2; exit 1; }
  rm -rf "${src}" && mkdir -p "${src}" && sleep $((4 * n))
done
for n in 1 2 3 4 5 6; do
  ( cd "${src}" && GIT_TERMINAL_PROMPT=0 python3 ./utils/git-sync-deps ) || true
  bad="$(cd "${src}" && python3 - <<'PY'
import os, subprocess
# Evaluate DEPS the way git-sync-deps does: it is Python, with Var() resolving from vars.
g = {}
exec(compile(open("DEPS").read(), "DEPS", "exec"), {"Var": lambda k: g["vars"][k]}, g)
for rel, spec in sorted(g.get("deps", {}).items()):
    rev = spec.partition("@")[2]
    ok = os.path.exists(os.path.join(rel, ".git")) and subprocess.run(
        ["git", "-C", rel, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip() == rev
    if not ok:
        print(rel)
PY
  )" || bad="DEPS-unreadable"
  [ -z "${bad}" ] && break
  [ "${n}" -lt 6 ] || { echo "ERROR: shaderc third_party not synced after ${n} attempts: $(echo ${bad})" >&2; exit 1; }
  echo "shaderc git-sync-deps incomplete (attempt ${n}/6): $(echo ${bad}) -- retrying" >&2
  for d in ${bad}; do [ "${d}" = DEPS-unreadable ] || rm -rf "${src:?}/${d}"; done
  sleep $((4 * n))
done
cmake -S "${src}" -B "${src}/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build "${src}/build" --target glslc_exe -j"$(nproc)"
install -m755 "${src}/build/glslc/glslc" /usr/local/bin/glslc
rm -rf "${src}"
# The capability FFmpeg probes, not mere presence.
probe="$(mktemp -d)"
printf '#version 460\nlayout (local_size_x = 1) in;\nvoid main() {}\n' > "${probe}/probe.comp"
glslc --target-env=vulkan1.4 --target-spv=spv1.6 -std=460 -fshader-stage=compute \
      "${probe}/probe.comp" -o "${probe}/probe.spv" \
  || { echo "ERROR: the built glslc cannot compile --target-env=vulkan1.4 (FFmpeg's spirv_compiler probe)" >&2; exit 1; }
rm -rf "${probe}"
glslc --version
EOF
