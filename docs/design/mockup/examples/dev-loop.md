# Developing your own muxer - no full builds

A full build is every library on every platform. Developing a patch needs one platform, the
libraries built **once**, and FFmpeg rebuilt incrementally on each edit.

```console
$ ffmpeg-build dev --profile dvr.yml --platform linux-x64
  libraries: 7/7 from cache (built by CI run #4812)          # nothing to build
  FFmpeg 9.0.2 -> .ffmpeg-dev/src (git), patches applied as commits:
    0001 avformat: add ACME muxer
    0002 avformat: add ACME demuxer
  configured with dvr's flags; first build 6m12s

$ $EDITOR .ffmpeg-dev/src/libavformat/acmeenc.c
$ ffmpeg-build dev make                                       # incremental
  CC libavformat/acmeenc.o
  LD ffmpeg
  12s

$ ffmpeg-build test --platform linux-x64
  smoke tests ......................... ok
  ./tests/acme-roundtrip.sh ............ ok

$ git -C .ffmpeg-dev/src commit -am "acme: fix timestamp rounding"
$ ffmpeg-build patches export
  patches/acme-muxer/9/0001-avformat-add-ACME-muxer.patch      unchanged
  patches/acme-muxer/9/0002-avformat-add-ACME-demuxer.patch    unchanged
  patches/acme-muxer/9/0003-acme-fix-timestamp-rounding.patch  new
```

Commit the patches. The PR's CI then builds every platform in the profile - the only step that
pays for all of them.

**The library cache** makes this work: every built library is stored by (recipe, version,
platform, toolchain image). Changing a patch never rebuilds a library; CI fills the cache and
local machines read from it.

**Hosts:** any platform the machine can build (see [hosts.md](hosts.md)); on a Mac, linux-x64 runs
in Docker and linux-arm64 runs natively in Docker on Apple Silicon.
