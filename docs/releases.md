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
- **Where releases go is checked before anything builds.** A public repository takes no nonfree target. A private
  one takes releases only when `ffmpeg-build.yml` says `private-release: internal` at the top: its builds, and the
  source their `THIRD-PARTY-NOTICES.txt` links to, then reach only people with access to that repository. `releases`
  checks this in CI's plan step, so nothing is built (or uploaded as a workflow artifact) that couldn't be published,
  and `bundle` checks it again.

### iOS and Mac Catalyst: the xcframework bundle

A licence's four framework builds (ios-arm64, ios-sim-arm64, maccatalyst-arm64 and maccatalyst-x64) ship as one
archive, `ffmpeg-<version>-ios-<license>.tar.gz`, as devenvy/ffmpeg published them: one `<lib>.xcframework` per FFmpeg
library, each with three slices (`ios-arm64`, `ios-arm64-simulator`, and `ios-arm64_x86_64-maccatalyst`, the two
Catalyst builds fused with `lipo` and signed again ad hoc), and one `THIRD-PARTY-NOTICES.txt` at the root that holds
each of the four builds' notices in full, after a header saying which build went into which slice.

    ffmpeg-build bundle --apple --release 9.0.2.3 --dist dist   # on a Mac with Xcode, after building the four
    ffmpeg-build bundle --release 9.0.2.3 --dist dist           # anywhere: the release, with the bundle in it

A licence with some but not all four targets (or two of one) in a release is refused by `check` and `releases`, so CI
stops before building anything; `bundle --apple` applies the same rule. It also refuses off macOS, when a slice's
archive is missing, and when a slice's binaries aren't that slice's architectures and platform. Beside each bundle it
writes `ffmpeg-<version>-ios-<license>.slices.json`: the bundle's sha256 and each slice archive's, with each slice's
components.

Plain `bundle` then publishes the bundle in place of the four builds' archives, as one `manifest.yml` entry named
`ios-<license>` with platform `ios`; its runtime and dev assets are the same file (the xcframeworks carry the headers).
The entry's components are the four builds' together, and its toolchain and definition change when any build's do.
The four builds' sources are in the sources archive, each with its own section in `SOURCES.md`. Plain `bundle`
refuses a release whose bundle or `.slices.json` isn't in `--dist`, and a stale bundle: one whose slice archives were
built again after `bundle --apple` made it. It publishes the `.slices.json` with the release, and the next release's
removal guard compares each slice with it, so a component dropped from one slice only stops the release too (allow it
with `allow-removal:` on that slice's target).

## CI (GitHub Actions)

The engine ships reusable workflows (preview: each has been run end to end on the engine's own test repository, building, publishing and fetching real releases; their inputs may still change before 1.0):

- **`build.yml`**: plan (`releases --json`), then each target of each due release on its runner (`platforms.yml`
  `runner:`; Linux images through buildx and the Actions cache, the library cache per target), the iOS bundle on
  macOS, and the release (`bundle`, then a GitHub release with every asset). `publish: changed-only | always | never`;
  `never` is a pull-request check. One `all-builds` job to require. Its caller grants `contents: write` even with
  `never`: GitHub won't start a run whose called workflow has a job (the skipped release job) asking for more than
  the caller grants.
- **`update.yml`**: `ffmpeg-build update`, then one pull request on `ffmpeg-build/update` with the update summary.
  Opening the pull request needs the repository setting *Allow GitHub Actions to create and approve pull requests*
  (Settings, Actions, General), or a `token` secret.
- **`fetch-update.yml`**: for products (below); the same PR handling.
- **`automerge.yml`**: merges the PR of `update.yml` or `fetch-update.yml` with `automerge: true` once its CI passes.

**The PR's CI starts without any token.** Pushes made with `GITHUB_TOKEN` start no workflows, so after pushing,
`update.yml` and `fetch-update.yml` dispatch the CI workflow named by their `ci-workflow` input (default `ci.yml`;
empty dispatches nothing) on the PR's branch. That workflow needs a `workflow_dispatch:` trigger, and the caller must
grant `actions: write` (with `contents: write` and `pull-requests: write`). The `token` secret stays optional: a token
whose pushes start CI by themselves (then nothing is dispatched).

**Automerge needs no repository settings** (no auto-merge, branch protection or required checks, which free private
repositories can't have). With `automerge: true` the PR is labelled `ffmpeg-build:automerge`; a workflow triggered by
`workflow_run` (your CI's `completed` runs) calls `automerge.yml`, which merges the labelled `ffmpeg-build/` PR whose
head is still the commit the passing run tested (`gh pr merge --squash --match-head-commit`). A merge made with
`GITHUB_TOKEN` starts no workflows on the default branch; the scheduled release train picks it up.

Each takes an `engine` input: the ffmpeg-build to run. A version installs that npm release (the default is the
version `ffmpeg.lock` records); a git or npm spec (one with `:` or `/`) is installed from it, and `source` builds the
calling repository itself (the engine's own tests). Until the package is on npm, set
`engine: github:<owner>/<repo>#<ref>` (e.g. `github:ryan-morris/ffmpeg-builder#main`, or a tag or commit to pin it).
npm builds `dist/` from a git spec when it packs it (the `prepare` script). The workflows run `npm pack "<spec>"` and
install the package it makes, because `npm install --global <git spec>` runs `prepare` without the devDependencies it
needs (TypeScript). By hand, the same:

    npm install --global "$(npm pack --silent github:ryan-morris/ffmpeg-builder#main | tail -1)"

Copy-ready callers are in [`examples/workflows/`](../examples/workflows): a daily release train, a pull-request check,
lock updates, a product's FFmpeg bumps, their automerge, and a `dependabot.yml` for the actions they use.

## Products: using a build without building FFmpeg

A product commits one line, `owner/repo@tag`, in a pin file (`ffmpeg.version`):

    ffmpeg-build fetch ffmpeg.version --target linux-x64-lgplv3 --out vendor/ffmpeg   # --dev adds headers and libraries
    ffmpeg-build fetch --update ffmpeg.version --target linux-x64-lgplv3            # newest build, same FFmpeg major

`fetch` reads the release's `manifest.yml`, downloads the target's archives, checks each sha256 and unpacks them
(every entry must stay inside the folder). `--out` is replaced whole, so it must be new, empty or an earlier fetch,
and a repeat run is a no-op. `GITHUB_TOKEN` or `GH_TOKEN` reach private repositories; the token goes only to the
GitHub API. Exit codes: 0 fetched or up to date, 1 a checksum mismatch, missing target or unsafe archive, 2 usage,
network or data problems.
