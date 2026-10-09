# ffmpeg: update ffmpeg.lock

_Opened by `ffmpeg-build update` (nightly). Only `ffmpeg.lock` changed._

## ⚠ New FFmpeg minor: 9.0 -> 9.1 (dvr, playback)
Your profiles say `ffmpeg: 9`, which allows 9.x. FFmpeg minors are ABI-compatible but add features:
- new: `whep` muxer, `scale_d3d12` filter (Windows) - included by `start: everything` (playback only)
- deprecated: none
To stay on 9.0.x, change the profile to `ffmpeg: 9.0` and close this PR.

## dvr
| | from | to |
|---|---|---|
| FFmpeg | 9.0.2 | **9.1.0** |
| srt | 1.5.7 | 1.5.8 |

## playback
| | from | to | |
|---|---|---|---|
| FFmpeg 9 | 9.0.2 | **9.1.0** | |
| libvpx | 1.17.0 | 1.18.0 | |
| libplacebo | 7.360.1 | 7.362.0 | win-arm64 stays on pinned 7.349.0 |

## Not applied
- **nv-codec 13.1.15.0**: outside your pin `"13.0"` (needs NVIDIA driver 610+).
- **FFmpeg 10.0.0**: profiles say `ffmpeg: 9`; `patches/acme-muxer` has no `10/` folder yet.

## Nothing removed
Every component in the last published `dvr` and `playback` builds is still present.
