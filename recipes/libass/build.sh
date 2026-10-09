#!/usr/bin/env bash
# libass: SSA/ASS subtitle renderer, needs fribidi + harfbuzz + freetype + fontconfig (ISC), static. Ported from devenvy/ffmpeg scripts/deps/libass.sh.

# fontconfig is only built where the platform uses it (off on Windows/mobile,
# which fall back to DirectWrite/CoreText or an explicit fontfile=).
case "${BUILD_RID}" in
  linux-*|osx-*) FC_OPT="-Dfontconfig=enabled" ;;
  *)             FC_OPT="-Dfontconfig=disabled" ;;
esac
ASS_ARGS=("${FC_OPT}" -Dtest=disabled)
# Windows/Apple provide DirectWrite/CoreText; Linux uses fontconfig. Android has
# none, so let libass build without a system font provider (fonts are supplied
# explicitly at runtime).
case "${BUILD_RID}" in
  android-*) ASS_ARGS+=(-Drequire-system-font-provider=false) ;;
esac
# libass enables its x86 SIMD via NASM, but Android links everything
# position-independent and meson's Nasm support cannot emit a PIE — configure aborts with
# "ERROR: Language Nasm does not support position-independent executable". Only android-x64
# is affected: android-arm64 has no nasm path, and the other x86 targets (linux-x64,
# linux-musl-x64, win-x64) are not PIE-forced, so they keep their assembly. The cost here is
# scalar subtitle rasterisation on one RID.
case "${BUILD_RID}" in
  android-x64) ASS_ARGS+=(-Dasm=disabled) ;;
  # Everywhere else, REQUIRE it rather than accepting meson's `auto`. libass downgrades a missing
  # or pre-2.10 NASM to a warning and builds scalar subtitle rasterisation -- it still works, just
  # slower, so nothing downstream notices. With -Dasm=enabled libass raises the error itself
  # (meson.build: `elif asm_option.enabled() -> error`), with its own accurate diagnostic.
  #
  # This replaces a config.h probe that was wrong twice over: libass generates config.h through
  # two vcs_tag targets, so it does not exist until `meson compile` -- the probe ran right after
  # `meson setup` and reported "no CONFIG_ASM line" on a build whose own summary said
  # "ASM optimizations: YES". Letting upstream answer removes both the timing dependency and the
  # need to track its macro names.
  #
  # linux-armhf: leave meson's `auto`. libass has NO 32-bit ARM assembly -- meson.build only
  # takes the nasm path for generic_cpu_family 'x86' (x86 and x86_64) and sets enable_asm for
  # 'aarch64'; everything else falls through to a warning with asm off. Forcing -Dasm=enabled
  # there turns that into "Assembly was requested, but cannot be built", which is what it did:
  # it failed linux-armhf, a RID that had been building correctly all along.
  linux-armhf) ;;
  # Everything else is x86_64 or aarch64, where libass does support assembly. A no-op on the
  # aarch64 RIDs (enable_asm is unconditional there); on x86_64 it is the whole point, turning a
  # silent scalar fallback into an error.
  *)           ASS_ARGS+=(-Dasm=enabled) ;;
esac
meson_build "${ASS_ARGS[@]}"
