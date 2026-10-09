#!/usr/bin/env bash
# Helpers for recipes/<name>/build.sh. Sourced (with set -euo pipefail already on) before each recipe, inside
# the toolchain image. A recipe runs from $SRC_DIR and installs into $DEPS_DIR; see
# CONTRIBUTING.md and platforms/driver.sh for every variable it gets.

# Cross-compilation arguments; empty for native builds (linux-x64).
CMAKE_CROSS_ARGS=()
MESON_CROSS_ARGS=()

# Old CMakeLists still declare cmake_minimum_required(< 3.5), which CMake 4 rejects. Upstream's wrapper.
cmake() {
  if [[ "${1:-}" == "--build" || "${1:-}" == "--install" ]]; then
    command cmake "$@"
  else
    command cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 "$@"
  fi
}

# cmake_build [cmake args...]: a static library into $DEPS_DIR (upstream's build_cmake_dep).
# Set CMAKE_SOURCE for a CMakeLists.txt that isn't at the top of the source (x265: source/).
cmake_build() {
  cmake -B _build -S "${CMAKE_SOURCE:-.}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="${DEPS_DIR}" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_PREFIX_PATH="${DEPS_DIR}" \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    ${CMAKE_CROSS_ARGS[@]+"${CMAKE_CROSS_ARGS[@]}"} \
    "$@"
  cmake --build _build -j"${JOBS}"
  cmake --install _build
}

# retry <command...>: up to 6 tries with backoff, for network steps inside a recipe (git submodule update).
retry() {
  local n=1 delay=4
  until "$@"; do
    if [ "${n}" -ge 6 ]; then return 1; fi
    echo "  failed (attempt ${n}/6): $* -- retrying in ${delay}s" >&2
    sleep "${delay}"
    delay=$((delay * 2))
    n=$((n + 1))
  done
}

# meson_build [meson args...]: a static library into $DEPS_DIR.
meson_build() {
  meson setup _build \
    --prefix="${DEPS_DIR}" \
    --libdir=lib \
    --default-library=static \
    --buildtype=release \
    ${MESON_CROSS_ARGS[@]+"${MESON_CROSS_ARGS[@]}"} \
    "$@"
  meson compile -C _build -j "${JOBS}"
  meson install -C _build
}
