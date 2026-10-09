# Where things run

## Managing profiles - anywhere

`check`, `plan`, `lock`, `outdated`, `update`, `fetch`: Node and the CLI only. No compilers,
no Docker. Any Mac, Linux or Windows machine, or any CI.

## Building

| Target | on a Mac | on Linux | on Windows |
|---|---|---|---|
| osx-*, ios-*, maccatalyst-* | native (Xcode) | ✗ | ✗ |
| linux-*, linux-musl-* | Docker (pinned images) | Docker or native | Docker / WSL |
| win-* (cross-compiled, mingw) | Docker | Docker | Docker / WSL |
| android-* | Docker | Docker | Docker / WSL |

- Apple targets need macOS: Xcode only runs there. Nothing can change that.
- Everything else builds inside the engine's pinned toolchain images, so a build on a laptop and
  in CI uses the same compiler, and `ffmpeg.lock` records the image digest.
- On Apple Silicon, x64 Linux images run under emulation (slow); arm64 images run natively.
- In CI, the reusable `build.yml` sends Apple targets to macOS runners and the rest to Linux
  runners automatically.
