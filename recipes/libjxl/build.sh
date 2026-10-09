#!/usr/bin/env bash
# libjxl: JPEG XL reference codec (BSD-3-Clause), static. Ported from devenvy/ffmpeg scripts/deps/libjxl.sh.
# Enables FFmpeg's libjxl JPEG XL en/decoder. Consumes the brotli, highway, and lcms2 static libs built earlier via
# JPEGXL_FORCE_SYSTEM_* (no vendored submodules). C++ -- the C++ runtime is added to its .pc files for FFmpeg's static
# link, covering the whole libjxl->highway chain.

# SJPEG + TRANSCODE_JPEG are OFF: they are the lossless JPEG->JXL recompression path
# (FFmpeg's libjxl codec doesn't use it) and SJPEG=ON pulls a third_party/sjpeg submodule
# that a shallow no-submodule clone doesn't have -- turning them off keeps us submodule-free.
#
# CMAKE_FIND_ROOT_PATH=${DEPS_DIR}: libjxl is the only dep that locates OTHER built deps
# (highway/brotli/lcms2) via find_library/find_path. The win/armhf/ios toolchains already put
# DEPS_DIR on the find-root path, but android uses the NDK's own toolchain file which doesn't --
# so without this, find_library(HWY) fails under the NDK cross ("Could NOT find HWY"). Adding
# DEPS_DIR to the root path (keeping the strict MODE=ONLY) makes android match the others.
cmake_build \
  -DCMAKE_FIND_ROOT_PATH="${DEPS_DIR}" \
  -DBUILD_TESTING=OFF \
  -DJPEGXL_ENABLE_TOOLS=OFF -DJPEGXL_ENABLE_BENCHMARK=OFF \
  -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_ENABLE_MANPAGES=OFF \
  -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_JPEGLI=OFF \
  -DJPEGXL_ENABLE_PLUGINS=OFF -DJPEGXL_ENABLE_SKCMS=OFF \
  -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_TRANSCODE_JPEG=OFF \
  -DJPEGXL_FORCE_SYSTEM_BROTLI=ON -DJPEGXL_FORCE_SYSTEM_HWY=ON \
  -DJPEGXL_FORCE_SYSTEM_LCMS2=ON

# libjxl + highway are C++; upstream appended the C++ runtime to FFmpeg's EXTRA_LIBS for the static --enable-libjxl
# link (libstdc++ GNU/mingw, libc++ Apple/NDK; -l:libstdc++.a on musl and -l:libc++.a on win-arm64 via CXX_RT_LIB).
# On Android, libjxl's __ANDROID__ logging path calls __android_log_write (in -llog) but its .pc doesn't declare it,
# so the static link test fails without an explicit -llog. A recipe can't touch FFmpeg's link line, so these go into
# the Libs.private of the two .pc files FFmpeg's configure asks for (libjxl, libjxl_threads) when not already there.
# (libjxl 0.12's own libjxl.pc already lists -lstdc++ on GNU toolchains; libjxl_threads.pc, std::thread based, doesn't.)
case "${BUILD_RID}" in
  osx-*|ios-*|maccatalyst-*) CXX_RT="-lc++" ;;
  android-*)    CXX_RT="-lc++ -llog" ;;
  win-arm64)    CXX_RT="-l:libc++.a" ;;
  linux-musl-*) CXX_RT="-l:libstdc++.a" ;;
  *)            CXX_RT="-lstdc++" ;;
esac
for pc in "${DEPS_DIR}/lib/pkgconfig/libjxl.pc" "${DEPS_DIR}/lib/pkgconfig/libjxl_threads.pc"; do
  add=""
  for l in ${CXX_RT}; do
    grep -qE "^Libs(\.private)?:.*[[:space:]]${l//+/\\+}([[:space:]]|$)" "${pc}" || add="${add} ${l}"
  done
  if [[ -n "${add}" ]]; then
    if grep -q '^Libs\.private:' "${pc}"; then
      sed -i "s#^Libs\.private:.*#&${add}#" "${pc}"
    else
      echo "Libs.private:${add}" >>"${pc}"
    fi
  fi
  echo "--- ${pc##*/}"; cat "${pc}"
done
