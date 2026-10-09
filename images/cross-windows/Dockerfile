# The Windows toolchain image: cross-compiles win-x64 (mingw-w64 gcc, win32 threads) and win-arm64 (llvm-mingw),
# as upstream devenvy/ffmpeg does on an ubuntu-latest runner (platform/windows.sh, 03_install_packages.sh). Upstream
# leaves both toolchains unpinned; here the base is pinned by digest and llvm-mingw by version and SHA-256. Ubuntu's
# mingw-w64 packages come with the base's apt archive; the library cache keys on this image's Docker ID.
FROM mirror.gcr.io/library/ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ENV DEBIAN_FRONTEND=noninteractive
# mingw-w64 (gcc-win32 / g++-win32, binutils), mingw-w64-tools (gendef), llvm (llvm-dlltool for MSVC .lib import
# libraries), the build tools upstream installs, and a native gcc/g++ for host tools (glslc below, nettle's helpers).
RUN apt-get update && apt-get install -y --no-install-recommends \
      mingw-w64 mingw-w64-tools llvm \
      build-essential cmake nasm yasm autoconf automake libtool pkg-config gperf m4 perl python3 python3-pip python3-venv \
      git curl ca-certificates xz-utils bzip2 jq xxd file unzip patch \
 && rm -rf /var/lib/apt/lists/*
# meson/ninja pinned as in the linux images (Ubuntu's meson works, but the same versions everywhere keep recipes alike).
RUN python3 -m venv /opt/meson && /opt/meson/bin/pip install --no-cache-dir meson==1.12.1 ninja==1.13.2 \
 && ln -sf /opt/meson/bin/meson /usr/local/bin/meson && ln -sf /opt/meson/bin/ninja /usr/local/bin/ninja

# llvm-mingw for win-arm64 (aarch64-w64-mingw32-clang): upstream's pinned release, verified by SHA-256.
ARG LLVM_MINGW=20260922
ARG LLVM_MINGW_SHA256=bb7bb7654b33d5aa8712acb837c963b2e0c56352560c76105270a3268c665c21
RUN curl -fsSL -o /tmp/llvm-mingw.tar.xz \
      "https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_MINGW}/llvm-mingw-${LLVM_MINGW}-ucrt-ubuntu-22.04-x86_64.tar.xz" \
 && echo "${LLVM_MINGW_SHA256}  /tmp/llvm-mingw.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/llvm-mingw.tar.xz -C /opt \
 && mv "/opt/llvm-mingw-${LLVM_MINGW}-ucrt-ubuntu-22.04-x86_64" /opt/llvm-mingw \
 && rm /tmp/llvm-mingw.tar.xz
# llvm-mingw on PATH after the system tools: its own x86_64-w64-mingw32-* must not shadow Ubuntu's mingw-w64 gcc,
# which win-x64 uses. The win setup calls the aarch64 tools by their full prefix.
ENV PATH="${PATH}:/opt/llvm-mingw/bin"

# glslc (Vulkan shader compiler) from the pinned shaderc -- Ubuntu's predates Vulkan 1.4, and FFmpeg's Vulkan filters
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
