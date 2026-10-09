# ffmpeg-playground

A **mockup** of the proposed FFmpeg builder: the exact repo layouts, profiles, lock files,
workflows and command output, so the design can be judged before anything is built. Versions,
hashes and run numbers are made up.

> The `ffmpeg.lock` files here are an early sketch. The real format is in
> `docs/specs/2026-10-08-lock-update-design.md`, so `ffmpeg-build check` run in these folders
> rejects them.

## The four repos

| Folder | What it is | Visibility |
|---|---|---|
| [`ffmpeg-build/`](ffmpeg-build/) | **The engine.** The `ffmpeg-build` CLI and the recipes it runs. The only place build logic lives. Knows *how* to build each library; tracks no library versions. | public |
| [`devenvy-ffmpeg/`](devenvy-ffmpeg/) | **Our OSS distribution.** A profile, a lock and two short workflows. Publishes the builds we offer today, with today's asset names. | public |
| [`company-ffmpeg/`](company-ffmpeg/) | **Internal builds.** One profile per product, proprietary patches, `license: nonfree` (internal use only, never published publicly). Same engine, so there is no build logic to keep in sync. | private |
| [`dvr-firmware/`](dvr-firmware/) | **A product.** Pins one *published* build and downloads it in seconds. Never builds FFmpeg. | private |

## Who watches what

```
FFmpeg releases ─────▶ ffmpeg-build, nightly: regenerate ffmpeg/<major>.yml from every release's
                       configure; no difference = no-op; safe differences merge themselves;
                       a new library needs a person (scaffold provided)

library releases ────▶ no one centrally. Each repo's `ffmpeg-build update` asks upstream directly
                       (each recipe says where versions come from), writes that repo's
                       ffmpeg.lock, opens a PR; the repo's own CI decides

new CLI release ─────▶ consumers' `ffmpeg-build update` offers it within `engine: 1`

new published build ─▶ products' `ffmpeg-build fetch --update` bumps their one-line pin -> PR
```

## The rules in one place

- **Profiles say what you want; `ffmpeg.lock` says exactly what you got.** Only `ffmpeg-build update` / `lock` write the lock.
- **Majors never move by themselves.** `ffmpeg: 9` stays on 9.x; a new major is reported with what moving would take.
- **`with:` means "wherever FFmpeg offers it".** Expected absences (whisper on FFmpeg 4, NVENC on macOS) are reported, not errors. A condition (`whisper: { ffmpeg: ">=8" }`) makes it *required* within that scope.
- **Nothing disappears silently.** Anything in the last published build that would be missing from the next one stops the build until it is removed from the profile or approved.
- **Maintenance is triggered by breakage, not by releases.** New library versions need no one; a recipe needs attention only when a new version fails to build (pin, then fix).
- **Every consumer owns its published builds.** Nothing depends on someone else's hosted binaries staying up (the FFmpegKit lesson).
- **No third-party package manager, no Renovate, no central version catalog.**

## Walk-through

| Topic | File |
|---|---|
| The simplest real profile | [`company-ffmpeg/dvr.yml`](company-ffmpeg/dvr.yml) |
| A profile using conditions | [`company-ffmpeg/playback.yml`](company-ffmpeg/playback.yml) |
| Our whole OSS distribution in one profile | [`devenvy-ffmpeg/ffmpeg.yml`](devenvy-ffmpeg/ffmpeg.yml) |
| What the lock records | [`company-ffmpeg/ffmpeg.lock`](company-ffmpeg/ffmpeg.lock) |
| What the engine knows about a library (no versions) | [`ffmpeg-build/recipes/x265/recipe.yml`](ffmpeg-build/recipes/x265/recipe.yml) |
| What the engine knows about FFmpeg (generated) | [`ffmpeg-build/ffmpeg/9.yml`](ffmpeg-build/ffmpeg/9.yml) |
| TLS as ordinary recipes (one per build, by preference) | [`ffmpeg-build/recipes/openssl/recipe.yml`](ffmpeg-build/recipes/openssl/recipe.yml) |
| `check`: what `with:` does across versions/platforms | [`examples/check.txt`](examples/check.txt) |
| Every profile key, conditions, licenses (incl. `nonfree`) | [`examples/profile-reference.md`](examples/profile-reference.md) |
| `outdated` | [`examples/outdated.txt`](examples/outdated.txt) |
| The update PR | [`examples/update-pr.md`](examples/update-pr.md) |
| Every rule `update` follows | [`examples/update-rules.md`](examples/update-rules.md) |
| Developing your own muxer without full builds | [`examples/dev-loop.md`](examples/dev-loop.md) |
| A published release's notes (with the build matrix) | [`examples/release-notes.md`](examples/release-notes.md) |
| The index products and scripts read | [`examples/manifest.yml`](examples/manifest.yml) |
| What the engine's nightly FFmpeg check opens | [`examples/ffmpeg-support-pr.md`](examples/ffmpeg-support-pr.md) |
| Where builds can run | [`examples/hosts.md`](examples/hosts.md) |
