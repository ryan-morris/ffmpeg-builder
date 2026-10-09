# Releases, CI and products

## Releases

Targets with the same `release-group:` (by default, all of them) and FFmpeg version release together, tagged
`[<group>-]<ffmpeg>.<build>` (e.g. `9.0.2.3`, or `dvr-9.1.0.0`). Each release publishes every target's archives,
`manifest.yml` (fixed name: what each target is made of, with every asset's sha256), `SHA256SUMS`, release notes and
the sources archive.

- **`ffmpeg-build releases [--due] [--json]`** lists them: the next tag (one past the last published build), whether
  each release is **due** (anything a build is made of changed since its last release: versions, toolchain, patches,
  the target itself, the engine) and why, and the CI runner of each target. It finds the last releases on GitHub,
  from `GITHUB_REPOSITORY` or the folder's git remote; `--offline` treats every release as new.
- **Nothing disappears silently.** A target that would lose a component its last release had stops `update` and the
  release, until you say so with `allow-removal: [x264]` (on the target, or at the top for every target).
- **Nonfree builds stay internal.** They are never published to a public repository, and a private one needs
  `nonfree-release: internal` at the top of `ffmpeg-build.yml`.

## CI (GitHub Actions)

The engine ships reusable workflows (preview: they are being run end to end for the first time):

- **`build.yml`**: plan (`releases --json`), then each target of each due release on its runner (`platforms.yml`
  `runner:`; Linux images through buildx and the Actions cache, the library cache per target), the iOS bundle on
  macOS, and the release (`bundle`, then a GitHub release with every asset). `publish: changed-only | always | never`;
  `never` is a pull-request check. One `all-builds` job to require.
- **`update.yml`**: `ffmpeg-build update`, then one pull request on `ffmpeg-build/update` with the update summary.
  `automerge: true` merges it when CI passes. Opening the pull request needs either a `token` secret (a token whose
  pushes also run your CI) or the repository setting *Allow GitHub Actions to create and approve pull requests*
  (Settings, Actions, General); with only the latter, the PR's own CI doesn't start until someone pushes to it.
- **`fetch-update.yml`**: for products (below).

Copy-ready callers are in [`examples/workflows/`](../examples/workflows): a daily release train, a pull-request check,
lock updates, a product's FFmpeg bumps, and a `dependabot.yml` for the actions they use.

## Products: using a build without building FFmpeg

A product commits one line, `owner/repo@tag`, in a pin file (`ffmpeg.version`):

    ffmpeg-build fetch ffmpeg.version --target linux-x64-lgplv3 --out vendor/ffmpeg   # --dev adds headers and libraries
    ffmpeg-build fetch --update ffmpeg.version --target linux-x64-lgplv3            # newest build, same FFmpeg major

`fetch` reads the release's `manifest.yml`, downloads the target's archives, checks each sha256 and unpacks them
(every entry must stay inside the folder). `--out` is replaced whole, so it must be new, empty or an earlier fetch,
and a repeat run is a no-op. `GITHUB_TOKEN` or `GH_TOKEN` reach private repositories; the token goes only to the
GitHub API. Exit codes: 0 fetched or up to date, 1 a checksum mismatch, missing target or unsafe archive, 2 usage,
network or data problems.
