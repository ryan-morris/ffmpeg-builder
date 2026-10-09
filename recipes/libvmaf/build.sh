#!/usr/bin/env bash
# libvmaf: Netflix VMAF perceptual video-quality metric (BSD-2-Clause-Patent), static. Ported from devenvy/ffmpeg scripts/deps/libvmaf.sh.
# Enables FFmpeg's vmaf filter. The meson project lives in the libvmaf/ subdirectory of the repo. Default prediction
# models are compiled into the library (no runtime model files). C++ -- the C++ runtime is added to libvmaf.pc for
# FFmpeg's static link.
cd libvmaf     # meson project is in the libvmaf/ subdir
# libvmaf bundles libsvm, whose src/svm.cpp defines a global
#   template <class T> static inline void swap(T&, T&)
# Because svm_node lives in the global namespace, ADL makes that a candidate alongside
# std::swap wherever libc++ calls swap() unqualified inside <vector>, and every
# std::vector<svm_node>::push_back instantiation fails with "call to 'swap' is ambiguous".
# libstdc++ does not trip it (its internals qualify the call), which is why only llvm-mingw
# sees this. Rename libsvm's helper and its 26 call sites together -- they are all its own,
# svm.cpp pulls in no std::swap of its own. Verified by cross-building libvmaf v3.2.0 for
# aarch64-w64-mingw32 with and without the rename.
if [[ "${BUILD_RID}" == "win-arm64" ]]; then
  sed -i "s/\bswap(/libsvm_swap(/g" src/svm.cpp
  echo "libvmaf: renamed libsvm's global swap (libc++ ADL ambiguity on win-arm64)"
fi

# -Dbuilt_in_models=true is a REQUEST, not a guarantee: libvmaf's meson treats xxd as
# `required: false` and emits the model sources only inside `if xxd.found()`, with no failure
# branch. Without xxd the library builds cleanly, the FFmpeg filter still registers, and every
# model lookup returns -EINVAL -- so the default `version=vmaf_v0.6.1` silently cannot load.
# That shipped on the manylinux RIDs, which had no xxd. Assert the tool is actually there so a
# missing model set fails the build instead of the user's first vmaf invocation.
if ! command -v xxd >/dev/null 2>&1; then
  echo "ERROR: xxd not found; libvmaf would build with NO built-in models." >&2
  echo "  The filter would register and then fail on its default version=vmaf_v0.6.1." >&2
  echo "  Package providing xxd: vim-common on RPM hosts; xxd on Alpine and on Debian 11+ /" >&2
  echo "  Ubuntu 22.04+ (it was split out of vim-common there); vim-common on older Debian." >&2
  exit 1
fi
# VMAF hard-fails below NASM 2.13.02 but only WARNS below 2.14, silently dropping its AVX-512
# kernels -- the same required:false shape as the xxd problem above, one level down. The package
# lists do not pin a NASM version, so assert the floor on the x86-64 RIDs that actually use it.
case "${BUILD_RID}" in
  linux-x64|linux-musl-x64|win-x64|osx-x64|maccatalyst-x64|android-x64)
    _nasm_v="$(nasm -v 2>/dev/null | sed -nE 's/^NASM version ([0-9]+\.[0-9]+(\.[0-9]+)?).*/\1/p')"
    if [[ -z "${_nasm_v}" ]]; then
      echo "ERROR: nasm not found or its version is unparseable on ${BUILD_RID}; libvmaf needs >= 2.14" >&2
      echo "  for its AVX-512 kernels (it only warns below that and builds without them)." >&2
      exit 1
    fi
    if [[ "$(printf '%s\n2.14\n' "${_nasm_v}" | sort -V | head -1)" != "2.14" ]]; then
      echo "ERROR: nasm ${_nasm_v} is older than 2.14 on ${BUILD_RID}; libvmaf would silently build" >&2
      echo "  without AVX-512 (it warns rather than failing). Install a newer nasm." >&2
      exit 1
    fi
    echo "libvmaf: nasm ${_nasm_v} (>= 2.14) - AVX-512 kernels will be built."
    ;;
esac
meson_build -Denable_tests=false -Denable_docs=false -Dbuilt_in_models=true -Denable_float=true

# libvmaf is C++; its pkg-config declares no C++ runtime. Upstream appended it to FFmpeg's EXTRA_LIBS for the static
# --enable-libvmaf link (libstdc++ on GNU/Linux + mingw, libc++ on Apple/NDK, -l:libstdc++.a on musl, -l:libc++.a on
# win-arm64); a recipe can't touch FFmpeg's link line, so it goes into libvmaf.pc instead.
case "${BUILD_RID}" in
  osx-*|ios-*|maccatalyst-*|android-*) CXX_RT="-lc++" ;;
  win-arm64)    CXX_RT="-l:libc++.a" ;;
  linux-musl-*) CXX_RT="-l:libstdc++.a" ;;
  *)            CXX_RT="-lstdc++" ;;
esac
pc="${DEPS_DIR}/lib/pkgconfig/libvmaf.pc"
if grep -q '^Libs\.private:' "${pc}"; then
  sed -i "s#^Libs\.private:.*#& ${CXX_RT}#" "${pc}"
else
  echo "Libs.private: ${CXX_RT}" >>"${pc}"
fi
cat "${pc}"
