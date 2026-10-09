#!/usr/bin/env bash
# x265: H.265/HEVC encoder (GPL-2.0-or-later), static. Ported from devenvy/ffmpeg scripts/deps/libx265.sh.
EXTRA=()
case "${BUILD_RID}" in
  linux-armhf|osx-*|android-*|ios-*|maccatalyst-*) EXTRA+=(-DENABLE_ASSEMBLY=OFF) ;;
esac
CMAKE_SOURCE=source cmake_build \
  -DLIB_INSTALL_DIR=lib -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_LIBNUMA=OFF \
  ${EXTRA[@]+"${EXTRA[@]}"}

# The CMake-generated x265.pc carries platform-specific Libs.private (-lgcc_s -lrt) that break
# `pkg-config --static`; write the one FFmpeg's link needs instead.
case "${BUILD_RID}" in
  osx-*|android-*|ios-*|maccatalyst-*) PRIVATE="-lc++ -lm" ;;
  win-*) PRIVATE="-lstdc++ -lm" ;;
  *) PRIVATE="-lstdc++ -lm -lpthread" ;;
esac
cat > "${DEPS_DIR}/lib/pkgconfig/x265.pc" <<PC
prefix=${DEPS_DIR}
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: x265
Description: H.265/HEVC video encoder
Version: ${VERSION}
Libs: -L\${libdir} -lx265
Libs.private: ${PRIVATE}
Cflags: -I\${includedir}
PC
