#!/usr/bin/env bash
# openh264: Cisco's H.264 software encoder/decoder (BSD-2-Clause), static. Gives the LGPL builds a software H.264
# encoder (x264 is GPL-only). Ported from devenvy/ffmpeg scripts/deps/openh264.sh.
meson_build -Dtests=disabled

# openh264's meson build doesn't reliably install a pkg-config file FFmpeg finds;
# write one (FFmpeg's configure requires openh264 >= 1.3.0). pkg-config Version:
# is conventionally bare (no leading 'v'), unlike the git tag.
cat > "${DEPS_DIR}/lib/pkgconfig/openh264.pc" <<PC
prefix=${DEPS_DIR}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: openh264
Description: OpenH264 — Cisco H.264 codec
Version: ${VERSION#v}
Libs: -L\${libdir} -lopenh264
Libs.private: -lstdc++ -lm
Cflags: -I\${includedir}
PC
