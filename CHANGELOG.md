# Changelog

## 0.2.0 (unreleased)

The first public version.

- `ffmpeg-build.yml`: targets (one platform, license and FFmpeg series each) and bases; `init` from the shipped
  devenvy/ffmpeg targets; `profile add/remove/missing` edit it in place.
- `check`, `plan`, `show`, `targets`, `options`: what each target builds and why, licenses checked against an SPDX
  table, offline.
- `lock`, `outdated`, `update`: one version per library for the folder, read from upstream; the update PR text.
- `build --target` for linux-x64, linux-arm64, linux-armhf, linux-musl-x64, linux-musl-arm64, win-x64, win-arm64,
  android-arm64, android-x64, and on a Mac osx-arm64, osx-x64, ios-arm64, ios-sim-arm64, maccatalyst-arm64 and
  maccatalyst-x64, reproducing devenvy/ffmpeg's published builds.
- `THIRD-PARTY-NOTICES.txt` at the root of every archive (FFmpeg's texts and the effective license, the configure
  line, where the source is, every library's licence files), kept sources and `<name>.sources.json`. It replaces the
  `legal/` folder devenvy/ffmpeg's archives had.
- `releases`, `fetch`, and reusable `build`, `update` and `fetch-update` workflows (preview).
- `migrate` for folders of the earlier matrix profiles.
