# Profile reference

The whole vocabulary. Anything not written uses its default.

| Key | Meaning | Default |
|---|---|---|
| `name` | used in tags and asset names (`dvr-9.0.2.3`, `ffmpeg-9.0.2-linux-x64-dvr.tar.gz`) | required |
| `ffmpeg` | FFmpeg series: `9`, `9.0`, `[8, 9]`, or `latest` | required |
| `platforms` | `all`, or a list (`linux-x64`, `win-*`, ...) | required |
| `license` | `lgplv2`, `lgplv3`, `gplv2`, `gplv3`, `nonfree`, or a list (see below) | required |
| `start` | `everything` (all FFmpeg offers that the license allows) or `nothing` | `everything` |
| `with` | add these | - |
| `without` | remove these | - |
| `pin` | hold a version (`"4.3"` = 4.3.x, `"4.3.1"` = exactly) | newest upstream |
| `patches` | folders of your own patches (`patches/acme-muxer`) | - |
| `tests` | your own test commands, run after the smoke tests | - |

Names in `with` / `without` / `pin` are just names: `x265`, `nvenc`, `whisper`, `openssl`. You never
need to know whether something is a library or an FFmpeg option.

## Conditions

Any entry in `with`, `without` or `pin` can be limited by the three words the profile already
uses: `ffmpeg`, `platforms`, `license`.

| Rule | Example | Means |
|---|---|---|
| keys in one condition: **AND** | `whisper: { ffmpeg: ">=8", platforms: [linux-x64] }` | FFmpeg 8+ **and** linux-x64 |
| values in one list: **OR** | `nvenc: { platforms: [linux-x64, win-x64] }` | linux-x64 **or** win-x64 |
| two entries: **OR** | `- whisper: { platforms: [linux-x64] }`<br>`- whisper: { ffmpeg: ">=9" }` | either one |
| "everything except": use `without` | `without: [{ nvenc: { platforms: [linux-arm64] } }]` | not on linux-arm64 |

- `with` / `without`: any matching entry applies.
- `pin`: the **first** matching entry wins (a version needs exactly one answer); an entry with no
  condition is the fallback, so put it last.

## What `with:` promises

| Written | Behaviour |
|---|---|
| `with: [whisper]` | included **wherever FFmpeg offers it**; absences (FFmpeg 4, a platform FFmpeg doesn't support) are reported, not errors |
| `with: [whisper: { ffmpeg: ">=8" }]` | **required** within that scope: an error if it can't be built there |
| anything that would be in **no** build at all | an error (almost certainly a mistake) |

## Licenses

| `license:` | FFmpeg configure | May be given to others? |
|---|---|---|
| `lgplv2` | (default) | yes, with the source bundle |
| `lgplv3` | `--enable-version3` | yes, with the source bundle |
| `gplv2` | `--enable-gpl` | yes, with the source bundle |
| `gplv3` | `--enable-gpl --enable-version3` | yes, with the source bundle |
| `nonfree` | `--enable-gpl --enable-version3 --enable-nonfree` | **no** - internal use only |

What each license allows is not a hand-made table:
- FFmpeg's own `configure` classifies its options (GPL-only, version3-only, nonfree-only); the
  nightly regeneration copies that into `ffmpeg/<major>.yml`.
- Every recipe declares its SPDX license, covering libraries FFmpeg can't see (e.g. mbedTLS
  pulled in by SRT); it also goes into the source bundle.
- Every patch set declares its license in `about.yml`. `proprietary` requires `license: nonfree`.

`nonfree` allows anything, and marks the result: `manifest.yml` says `redistributable: false`,
release notes say "internal use only", and the engine **refuses to publish a `nonfree` build to
a public repository** (the one mistake that can't be undone). The source bundle is still produced.

## Groups (one per build)

Some things are alternatives: FFmpeg uses one TLS backend per build. Members of such a group
(`openssl`, `gnutls`, `schannel`, `securetransport`) are picked by preference per platform and
license; to choose differently, use `with` + `without` with a `platforms:` condition. Two members
requested for the same platform is a `check` error.
