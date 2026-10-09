#!/usr/bin/env bash
# libva: VA-API dispatch library (MIT), static, DRM backend only. Ported from devenvy/ffmpeg scripts/deps/libva.sh.
# Built STATIC with the DRM backend only (no X11/GLX/Wayland) and linked into FFmpeg, so the artifact carries no
# libva.so runtime dependency; the static dispatcher dlopens the system VA driver (iHD/i965/radeonsi) at runtime --
# so VAAPI works when a driver is installed, and nothing is required just to start ffmpeg. Needs libdrm.

# libva's meson uses shared_library() explicitly, which ignores --default-library.
# Rewrite to library() so --default-library=static yields static archives (library()
# still accepts the version:/soversion: kwargs, unlike static_library()).
sed -i 's/\bshared_library(/library(/g' va/meson.build
meson_build \
  -Dwith_x11=no -Dwith_glx=no -Dwith_wayland=no -Dwith_win32=no -Ddisable_drm=false

# Static libva dlopens the VA driver at runtime, so its consumers need -ldl; libva-drm
# also pulls in libva + libdrm. Make sure pkg-config --static exposes these for FFmpeg.
for pc in libva libva-drm; do
  f="${DEPS_DIR}/lib/pkgconfig/${pc}.pc"
  [ -f "$f" ] || continue
  grep -q '^Libs.private:' "$f" && sed -i 's/^Libs.private:.*/Libs.private: -ldl/' "$f" \
                                || sed -i '/^Libs:/a Libs.private: -ldl' "$f"
done
