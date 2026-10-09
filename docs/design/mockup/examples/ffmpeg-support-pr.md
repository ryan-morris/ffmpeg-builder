# ffmpeg: support FFmpeg 9.1.0

_Opened in ffmpeg-build by the nightly `ffmpeg-support.yml`: regenerating `ffmpeg/9.yml` from every
9.x release's configure produced a difference. No library versions are involved._

| Difference | Kind | Handled |
|---|---|---|
| `whep` muxer, `since: 9.1.0` | built-in | data only |
| `scale_d3d12` filter, Windows | built-in | data only |
| `libplacebo` minimum 7.349.0 -> 7.351.0 | raised minimum | data only; locks below it get a clear `check` error |
| `--enable-libfoo` (`libfoo >= 2.0`, version3) | **needs a library with no recipe** | split out to #212 |

This PR is data only, so it merges itself when CI is green and ships in CLI 1.4.3.

#212 (separate, never auto-merged): recipe scaffold for libfoo -
upstream guessed from Repology + Debian's `Vcs-Git` (github.com/example/libfoo, CMake);
Linux x64 build ✓, other platforms pending. A person confirms the upstream and finishes it.
