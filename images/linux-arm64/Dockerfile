# The linux-arm64 toolchain image: upstream devenvy/ffmpeg's pinned manylinux_2_28 for aarch64 (AlmaLinux 8, glibc
# 2.28, so the artifacts run on any glibc >= 2.28), provisioned as images/linux-x64 is. An arm64 image: it runs
# natively on an arm64 host and under qemu on an x64 one, as upstream builds it on arm64 runners. Builds use
# gcc-toolset-14, which the driver enables. The library cache keys on this image's Docker ID.
FROM --platform=linux/arm64 quay.io/pypa/manylinux_2_28_aarch64:2026.09.30-1@sha256:acc4e63610fef1da3d687322793665205415c2b22c0d2e403f1a44eb834d63fc

# vim-common supplies xxd (libvmaf's built-in models silently vanish without it).
RUN dnf -y install --setopt=install_weak_deps=False \
      nasm cmake git pkgconfig autoconf automake libtool perl gperf xz bzip2 curl make diffutils gcc-c++ jq vim-common \
 && dnf clean all
# meson/ninja: the system python is 3.6 (pip caps meson at 0.61) and dnf's meson is 0.58, below libdrm's >= 0.59.
RUN /opt/python/cp312-cp312/bin/pip install --no-cache-dir meson==1.12.1 ninja==1.13.2 \
 && ln -sf /opt/python/cp312-cp312/bin/meson /usr/local/bin/meson \
 && ln -sf /opt/python/cp312-cp312/bin/ninja /usr/local/bin/ninja
# patchelf 0.19.2, static: AlmaLinux 8's 0.17.2 corrupts gcc-toolset PIE executables on --set-rpath '$ORIGIN'
# (CET/GNU_PROPERTY notes), and the staged ffmpeg then segfaults in the loader. SHA-256 as GitHub lists the asset.
RUN curl -fsSL -o /tmp/pe.tgz https://github.com/NixOS/patchelf/releases/download/0.19.2/patchelf-0.19.2-aarch64.tar.gz \
 && echo 'ba6850c1a6f4cbdb050e1cc22fa5239159ad31c43606846e49c408d335f594ff  /tmp/pe.tgz' | sha256sum -c - \
 && tar -xzf /tmp/pe.tgz -C /tmp \
 && install -m755 /tmp/bin/patchelf /usr/local/bin/patchelf \
 && rm -rf /tmp/pe.tgz /tmp/bin

# glslc (Vulkan shader compiler) from the pinned shaderc -- AlmaLinux 8 has no package, and FFmpeg's Vulkan filters
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
