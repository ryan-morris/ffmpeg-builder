#!/usr/bin/env bash
# whisper.cpp: on-device speech-to-text engine (MIT) behind FFmpeg's af_whisper filter, static, with a per-platform
# GGML backend (Vulkan / Metal / CPU). Ported from devenvy/ffmpeg scripts/deps/whisper.sh.

# The per-platform GGML backend (upstream's WHISPER_BACKEND, from platform/*.sh).
case "${BUILD_RID}" in
  linux-x64|linux-arm64|linux-musl-x64|linux-musl-arm64) WHISPER_BACKEND=vulkan ;;
  win-x64|win-arm64|android-arm64|android-x64)           WHISPER_BACKEND=vulkan ;;
  osx-*|ios-*|maccatalyst-*)                             WHISPER_BACKEND=metal ;;
  linux-armhf) WHISPER_BACKEND=cpu ;; # no dependable 32-bit-ARM GPU path for ggml; CPU-only ASR here
  *)           WHISPER_BACKEND=cpu ;;
esac
# On linux the Vulkan loader is optional for whisper (recipe.yml uses:), so it is in the build only where the
# license allows it. A build without it (the v2 builds: the loader is Apache-2.0) gets the CPU backend, as
# upstream's 04_select_license.sh did. Other platforms get Vulkan from the toolchain (mingw shim, NDK sysroot).
if [[ "${WHISPER_BACKEND}" == vulkan && "${BUILD_RID}" == linux-* ]] && ! compgen -G "${DEPS_DIR}/lib/libvulkan.so*" >/dev/null; then
  WHISPER_BACKEND=cpu
fi
# Windows likewise: the static Vulkan shim is optional (recipe.yml uses:); without it, the CPU backend.
if [[ "${WHISPER_BACKEND}" == vulkan && "${BUILD_RID}" == win-* ]] && ! compgen -G "${DEPS_DIR}/lib/libvulkan*.a" >/dev/null; then
  WHISPER_BACKEND=cpu
fi
# The C++ runtime the other C++ deps use (upstream's CXX_RT_LIB, set in platform/*.sh; unset means -lstdc++).
case "${BUILD_RID}" in
  linux-musl-*) CXX_RT_LIB="-l:libstdc++.a" ;;
  win-arm64)    CXX_RT_LIB="-l:libc++.a" ;;
esac
echo "Building whisper.cpp (static, backend=${WHISPER_BACKEND})..."

# Explicit Release (cmake_build passes -DCMAKE_BUILD_TYPE=Release, like build_cmake_dep gives the helper-built
# deps): without a build type a single-configuration generator leaves whisper/ggml with NO optimisation flags.
# cmake_build also gives the prefix, lib dir, prefix path, BUILD_SHARED_LIBS=OFF and PIC upstream listed here.
WHISPER_CMAKE=(
  -DGGML_NATIVE=OFF
  -DGGML_OPENMP=OFF
  -DWHISPER_BUILD_EXAMPLES=OFF
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_SERVER=OFF
  -DGGML_BUILD_TESTS=OFF
  -DGGML_BUILD_EXAMPLES=OFF
)
# win-x64: upstream's symbols build (its issue #20; ffmpeg-build doesn't ship the symbols, but keeps the flags so the
# shipped DLLs match upstream's): CMake's own GCC Release flags plus -g, so code generation is the
# same as before and only DWARF is added; the shipped avfilter DLL is stripped at install.
case "${BUILD_RID}" in
  win-x64) WHISPER_CMAKE+=(-DCMAKE_C_FLAGS_RELEASE="-O3 -DNDEBUG -g" -DCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG -g") ;;
esac
# musl links the C++ runtime STATICALLY rather than depending on it. A base Alpine image ships
# no libstdc++.so.6/libgcc_s.so.1, so a dynamic link makes the artifact unable to start at all:
#   Error loading shared library libstdc++.so.6: No such file or directory
# Bundling the runtimes would fix that, but it means REDISTRIBUTING GPLv3 libraries -- the GCC
# Runtime Library Exception covers our linked output, not shipping the runtime itself, so it
# would pull a GPLv3 section 6 corresponding-source obligation into every musl artifact,
# including the lgplv2 cell. Static linking avoids the obligation instead of complying with it:
# the result is "Target Code" under the Exception, which is exactly what the Exception exists to
# permit. It also matches what BtbN ships -- their libavcodec has no libstdc++ dependency.
#
# -l:libstdc++.a is the same archive-name trick this repo already uses for win-arm64's
# -l:libc++.a: a bare -lstdc++ resolves to the shared library, and -static-libstdc++ is a driver
# flag the C link does not honour here. Verified on a shared library with C++ exceptions: the
# result has only libc and the loader in DT_NEEDED, and still runs.
case "${BUILD_RID}" in
  linux-musl-*)
    # Derived from CXX_RT_LIB -- the variable the other five C++ deps read -- so the two cannot
    # drift apart again. They already did once: this one was made static while chromaprint, libjxl,
    # libplacebo, libsrt and libvmaf kept the dynamic default, and the different name hid it.
    CXX_STATIC_LIB="${CXX_RT_LIB--l:libstdc++.a}"
    # libstdc++.a comes from Alpine's libstdc++-dev, pulled in transitively by build-base -> g++.
    # That chain is not ours to control, and if it ever stops holding the failure would surface
    # as an obscure "cannot find -l:libstdc++.a" deep inside FFmpeg's configure link tests, with
    # whisper silently reported as "not found". Check it up front and say what to install.
    if ! "${CC:-gcc}" -print-file-name=libstdc++.a 2>/dev/null | grep -q '/'; then
      echo "ERROR: libstdc++.a not found on this musl toolchain." >&2
      echo "  ${BUILD_RID} links the C++ runtime statically so the artifact needs none at runtime." >&2
      echo "  Install it with: apk add libstdc++-dev   (normally transitive via build-base -> g++)" >&2
      exit 1
    fi
    ;;
  *)            CXX_STATIC_LIB="-lstdc++" ;;
esac
case "${WHISPER_BACKEND}" in
  vulkan)
    WHISPER_CMAKE+=(-DGGML_VULKAN=ON -DGGML_CPU=ON)
    WHISPER_SYS_LIBS="-lvulkan ${CXX_STATIC_LIB} -lm -lpthread"
    # glibc-native linux-x64/arm64 get Vulkan + SPIRV headers from system packages
    # (libvulkan-dev, spirv-headers). For the mingw/NDK cross targets (can't use host
    # /usr/include — glibc pollution) and for Alpine/musl (header-package names are less
    # predictable), supply Vulkan-Headers + SPIRV-Headers in DEPS_DIR (distro-independent)
    # and point ggml's find_package at them. The loader lib still comes from the
    # toolchain/system (mingw import-lib, NDK sysroot, or apk vulkan-loader-dev).
    case "${BUILD_RID}" in
      win-x64|win-arm64|android-arm64|android-x64|linux-musl-x64|linux-musl-arm64|linux-x64|linux-arm64)
        # Vulkan-Headers come from the vulkan-headers recipe (upstream cloned them here when DEPS_DIR had none).
        [ -d "${DEPS_DIR}/include/vulkan" ] || {
          echo "ERROR: ${BUILD_RID} whisper needs Vulkan-Headers in ${DEPS_DIR}/include (the vulkan-headers recipe)." >&2
          exit 1
        }
        # SPIRV-Headers (headers + cmake config) are installed into DEPS_DIR by the
        # spirv-headers recipe, built before this one (recipe.yml needs:).
        # ggml-vulkan does find_package(SPIRV-Headers) (CONFIG mode), so point it
        # straight at the installed config dir (avoids cross-toolchain
        # find-root-path issues).
        SPIRV_HEADERS_CFG="$(dirname "$(find "${DEPS_DIR}" -iname 'spirv-headers*config.cmake' 2>/dev/null | head -1)")"
        WHISPER_CMAKE+=(-DVulkan_INCLUDE_DIR="${DEPS_DIR}/include"
                        -DSPIRV-Headers_DIR="${SPIRV_HEADERS_CFG}")
        ;;
    esac
    case "${BUILD_RID}" in
      win-x64|win-arm64)
        # mingw ships no Windows Vulkan loader import-lib. We used to synthesize one from the
        # headers with dlltool, which worked but made vulkan-1.dll a HARD import of the
        # resulting libavfilter -- so ffmpeg.exe would not start at all on a machine without
        # the Vulkan runtime (any host with no GPU driver: headless server, container, fresh
        # VM). Confirmed in our own published 9.0.1.6 artifact:
        #   objdump -p avfilter-12.dll | grep 'DLL Name'  ->  DLL Name: vulkan-1.dll
        # Link the static shim instead (upstream deps/vulkan-shim.sh); it resolves vulkan-1.dll through
        # LoadLibraryExA on first use, so the import disappears while the capability stays.
        # Verified with mingw locally: identical consumer object links to 1 vulkan import via
        # the dlltool lib and 0 via the shim, with LoadLibraryExA present instead.
        # The shim installs its impersonating archive into DEPS_DIR/lib (libvulkan-1.a or libvulkan.a).
        VULKAN_SHIM_LIB=""
        for f in "${DEPS_DIR}/lib/libvulkan-1.a" "${DEPS_DIR}/lib/libvulkan.a"; do
          [ -f "${f}" ] && { VULKAN_SHIM_LIB="${f}"; break; }
        done
        [ -n "${VULKAN_SHIM_LIB}" ] || {
          echo "ERROR: ${BUILD_RID} whisper needs the Vulkan shim, but it is not in ${DEPS_DIR}/lib." >&2
          echo "  (upstream builds it with deps/vulkan-shim.sh for this RID; see scripts/platform/windows.sh)" >&2
          exit 1
        }
        WHISPER_CMAKE+=(-DVulkan_LIBRARY="${VULKAN_SHIM_LIB}")
        # C++ runtime as in the cpu branch below: llvm-mingw (win-arm64) must take the static
        # libc++ archive in CXX_RT_LIB, never a bare -lstdc++ (resolves to libc++.dll.a there).
        case "${BUILD_RID}" in
          win-arm64) WHISPER_SYS_LIBS="-l:$(basename "${VULKAN_SHIM_LIB}") ${CXX_RT_LIB-} -lm" ;;
          *)         WHISPER_SYS_LIBS="-l:$(basename "${VULKAN_SHIM_LIB}") -lstdc++ -lm" ;;
        esac
        ;;
      android-arm64|android-x64)
        # NDK API-28 sysroot libvulkan.so exports the Vulkan 1.1 symbols ggml links directly.
        # TOOLCHAIN / ANDROID_TRIPLE / API: the NDK cross environment (upstream platform/android.sh).
        WHISPER_CMAKE+=(-DVulkan_LIBRARY="${TOOLCHAIN}/sysroot/usr/lib/${ANDROID_TRIPLE}/${API}/libvulkan.so")
        WHISPER_SYS_LIBS="-lvulkan -lc++ -lm"
        ;;
      linux-x64|linux-arm64)
        # Link OUR bundled libc-only Vulkan loader (the vulkan-loader recipe), not
        # the system one — so the artifact has no external libvulkan dependency.
        # Headers come from DEPS_DIR (vulkan-headers); SPIRV-Headers from DEPS_DIR (spirv-headers).
        WHISPER_CMAKE+=(-DVulkan_INCLUDE_DIR="${DEPS_DIR}/include"
                        -DVulkan_LIBRARY="${DEPS_DIR}/lib/libvulkan.so")
        ;;
    esac
    ;;
  metal)  WHISPER_CMAKE+=(-DGGML_BLAS_VENDOR=Apple -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_CPU=ON)
          # GGML_BLAS_VENDOR is pinned to Apple rather than left to ggml's platform
          # detection. That detection works for a native macOS build but not through the
          # macabi cross-build, where it fell back to a generic BLAS search and failed:
          #   -- x86 detected / Could NOT find BLAS (missing: BLAS_LIBRARIES)
          #   CMake Error at ggml/src/ggml-blas/CMakeLists.txt:98
          # Accelerate is present in the macOS SDK for Catalyst, so naming the vendor is
          # enough; every Apple RID wants Apple here, so this is not Catalyst-specific.
          # Apple auto-enables the BLAS backend (Accelerate); its archive is picked up by the
          # installed-archive enumeration below. Frameworks: Metal + Foundation + Accelerate.
          WHISPER_SYS_LIBS="-lc++ -lm -framework Foundation -framework Metal -framework MetalKit -framework Accelerate" ;;
  cpu|*)  WHISPER_CMAKE+=(-DGGML_CPU=ON)
          # Android/Bionic has no libstdc++ (it uses libc++) and pthread lives in libc, so
          # -lstdc++/-lpthread don't resolve there — FFmpeg's whisper link check then fails
          # ("whisper not found"), so Android must use -lc++. Android builds take the Vulkan
          # backend in every license (v2 too: it needs only vulkan-headers, Apache-2.0 OR MIT,
          # and the NDK's libvulkan), so this case is only for a build that falls back to the
          # CPU. Linux (glibc/musl) keeps libstdc++.
          case "${BUILD_RID}" in
            # win-arm64 lands here when the build has no Vulkan shim (llvm-mingw, cpu backend). A bare -lstdc++ must NOT
            # be added there: llvm-mingw resolves it to libc++.dll.a, which then collides
            # with the static libc++ from -static-libstdc++. CXX_RT_LIB carries the archive
            # this RID actually wants (-l:libc++.a). -lpthread is likewise omitted -- it does
            # not exist under mingw, whose threading is built in.
            android-*) WHISPER_SYS_LIBS="-lc++ -lm" ;;
            win-arm64) WHISPER_SYS_LIBS="${CXX_RT_LIB-} -lm" ;;
            *)         WHISPER_SYS_LIBS="${CXX_STATIC_LIB} -lm -lpthread" ;;
          esac ;;
esac

# mingw-w64 headers lack the Win10 THREAD_POWER_THROTTLING_* definitions that ggml-cpu.c
# uses unconditionally on _WIN32 (they exist in the real Windows SDK but are gated out at
# MinGW's default NTDDI level). Force-include a shim so ggml-cpu compiles. ggml-cpu is built
# by EVERY backend, so this applies to all Windows RIDs — hoisted out of the vulkan branch so
# the v2 series (Vulkan dropped → cpu backend) gets it too, not just the v3/vulkan path.
# win-* rather than win-x64: llvm-mingw (win-arm64) bundles the same mingw-w64 headers with
# the same NTDDI gating, so ggml-cpu.c fails there identically.
case "${BUILD_RID}" in win-*)
  cat > "${SRC_DIR}/win_ggml_compat.h" <<'SHIM'
#ifndef WHISPER_WIN_GGML_COMPAT_H
#define WHISPER_WIN_GGML_COMPAT_H
#include <windows.h>
#ifndef THREAD_POWER_THROTTLING_CURRENT_VERSION
typedef struct _THREAD_POWER_THROTTLING_STATE {
    ULONG Version; ULONG ControlMask; ULONG StateMask;
} THREAD_POWER_THROTTLING_STATE, *PTHREAD_POWER_THROTTLING_STATE;
#define THREAD_POWER_THROTTLING_CURRENT_VERSION 1
#define THREAD_POWER_THROTTLING_EXECUTION_SPEED 0x1
#define THREAD_POWER_THROTTLING_VALID_FLAGS THREAD_POWER_THROTTLING_EXECUTION_SPEED
#endif
#endif
SHIM
  WHISPER_CMAKE+=(-DCMAKE_C_FLAGS="-include ${SRC_DIR}/win_ggml_compat.h"
                  -DCMAKE_CXX_FLAGS="-include ${SRC_DIR}/win_ggml_compat.h")
  ;;
esac

cmake_build "${WHISPER_CMAKE[@]}"

# Some toolchains (notably mingw) install the ggml archives WITHOUT the 'lib' prefix
# (ggml.a instead of libggml.a), so -lggml won't resolve at FFmpeg link time. Normalize
# to libggml*.a so the whisper.pc below works uniformly across platforms.
for f in ggml ggml-base ggml-cpu ggml-vulkan ggml-metal ggml-blas; do
  if [ -f "${DEPS_DIR}/lib/${f}.a" ]; then mv "${DEPS_DIR}/lib/${f}.a" "${DEPS_DIR}/lib/lib${f}.a"; fi
done

# Assemble the ggml archive link line from what actually got INSTALLED (not a hardcoded
# per-backend guess). The ggml registry (libggml.a) references every backend it was
# compiled with — including the BLAS backend ggml auto-enables on Apple — so list the
# registry first, then all backends present, then libggml-base last (all depend on it).
WHISPER_GGML="-lggml"
for b in cpu metal vulkan blas; do
  if [ -f "${DEPS_DIR}/lib/libggml-${b}.a" ]; then WHISPER_GGML="${WHISPER_GGML} -lggml-${b}"; fi
done
WHISPER_GGML="${WHISPER_GGML} -lggml-base"

# Assembling from "whatever got installed" is right for the OPTIONAL backends (ggml auto-enables
# BLAS on Apple, for instance) but it silently tolerates the REQUESTED one going missing. If
# ggml's cmake cannot find Vulkan/Metal it falls back to CPU without failing, so libggml-vulkan.a
# simply would not exist, the loop above would skip it, and whisper would register and transcribe
# -- on the CPU. Every test would pass: the filter is there, inference works, and nothing states
# which backend ran. That is the GPU equivalent of the Vulkan-filter defect this branch exists
# for, so require the archive that WHISPER_BACKEND asked for.
case "${WHISPER_BACKEND}" in
  cpu) _ggml_want="" ;;                       # CPU is libggml-cpu.a, already required below
  *)   _ggml_want="libggml-${WHISPER_BACKEND}.a" ;;
esac
if [[ -n "${_ggml_want}" && ! -f "${DEPS_DIR}/lib/${_ggml_want}" ]]; then
  echo "ERROR: whisper requested the ${WHISPER_BACKEND} ggml backend on ${BUILD_RID}, but" >&2
  echo "  ${DEPS_DIR}/lib/${_ggml_want} was not installed - ggml fell back to CPU silently." >&2
  echo "  Installed ggml archives:" >&2
  ls -1 "${DEPS_DIR}/lib/"libggml*.a 2>/dev/null | sed 's|.*/|    |' >&2
  exit 1
fi
if [[ ! -f "${DEPS_DIR}/lib/libggml-cpu.a" ]]; then
  echo "ERROR: libggml-cpu.a missing - whisper has no CPU fallback path on ${BUILD_RID}." >&2
  exit 1
fi
echo "whisper: ggml backend verified present (${WHISPER_BACKEND})."
WHISPER_PRIV="${WHISPER_GGML} ${WHISPER_SYS_LIBS}"

# whisper.cpp installs no pkg-config file; hand-author one (as done for x265/vpl).
# Static link: Libs.private lists the ggml archives + loader/toolchain in dependency order.
# pkg-config Version: is conventionally bare (no leading 'v'), unlike the git tag.
whisper_pc_ver="${VERSION#v}"
cat > "${DEPS_DIR}/lib/pkgconfig/whisper.pc" <<PKGCONFIG
prefix=${DEPS_DIR}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: whisper
Description: whisper.cpp speech recognition
Version: ${whisper_pc_ver}
Libs: -L\${libdir} -lwhisper
Libs.private: ${WHISPER_PRIV}
Cflags: -I\${includedir}
PKGCONFIG
echo "whisper.cpp (af_whisper filter, backend=${WHISPER_BACKEND}) built."
