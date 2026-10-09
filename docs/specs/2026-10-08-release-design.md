# Releases: legal files, sources, bundle, workflows, fetch (step 6)

Status: decided 2026-10-08. It builds on the handoff (§2 "Format and files", "Licenses", "Products") and on targets
(`2026-10-08-targets-and-bases-design.md`). A Codex critique was adopted (see "Revisions" at the end). Upstream's
release.yml, build.yml and 10_write_legal.sh were read for what a replacement must keep.

## The gap

`build --target` writes `ffmpeg-<version>-<target>.tar.gz` and `-dev.tar.gz`. Nothing after that exists.
- **No `legal/`.** Upstream puts it in every archive; we ship only Android's libc++ NOTICE. This compliance gap
  comes first.
- **No release record:** no source capture, `manifest.yml`, `SHA256SUMS`, release notes or iOS bundle.
- **No CI.**
- **No way for a product to consume a release.**

## Release groups and identity

- A **release group** is a set of targets released together. Its key is `release-group:` on the target (default:
  the folder's single group, unnamed). `migrate` sets it to the old profile name when a folder had several.
- A **release** is one group at one resolved FFmpeg version.
  - Tag: `<ffmpeg>.<build>`, e.g. `9.0.2.3`. With a named group: `<group>-<ffmpeg>.<build>`, e.g.
    `dvr-9.1.0.0`, as in the handoff.
  - Build number: the highest existing tag with that base, plus 1, starting from 0.
  - The shipped devenvy targets give one release per FFmpeg line, as upstream does today.
- **Changed-only, decided per release.** A release is due when any target in it differs from that release's last
  manifest. Differences that count: FFmpeg version, resolved components and their versions, toolchain identity,
  patch hashes, the target's resolved definition, and engine version.
  - When a release is due, **every target in it is rebuilt.** Assets are never carried over from an older release,
    so each `SOURCE_OFFER.txt` names the release it ships in.
- This supersedes the mockup's profile-variant model, which predates targets.

## 6a. Legal files and source capture, at build time

**Licence files are declared, not guessed.**
- Every recipe lists `license-files:`, paths relative to its source, e.g. `[COPYING, LICENSE.md]`.
  - A recipe with no such file in its source (header-only drops) lists files of its own, kept beside `recipe.yml`.
- Every `ships:` entry in `platforms.yml` names its notice file.
- Patch sets name theirs in `about.yml`.
- A build fails before writing the cache entry when a declared file is missing.
- A discovery pass (`COPYING*`, `LICENSE*`, `COPYRIGHT*`, `NOTICE*`, any depth) reports undeclared candidates as a
  lint in the recipe tests. It is not a source of truth.

**What `legal/` holds.** It goes into each runtime archive, and into `-dev` too.
- `legal/LICENSE.md` and `legal/CREDITS`, from FFmpeg's source tree.
- The governing texts, as upstream picks them:
  - gplv3, and nonfree: `COPYING.GPLv3`
  - gplv2: `COPYING.GPLv2`
  - lgplv3: `COPYING.LGPLv3` and `COPYING.GPLv3`
  - lgplv2: `COPYING.LGPLv2.1` and `COPYING.GPLv2`
- `legal/licenses/<recipe>/<declared path>`, relative paths kept.
  - These are captured into the library's install tree under `share/ffmpeg-build/legal/<recipe>/`, so a cached
    library still brings them.
  - Patch sets go to `legal/licenses/patches-<set>/`. Shipped platform files go to `legal/licenses/<file>/`.
- `legal/LICENSE-NOTICE.txt`, generated from the plan:
  - the effective licence
  - why: the Apache-2.0 parts that need v3, or the TLS member chosen for v2, read from the plan's TLS group
  - pointers to licenses/ and SOURCE_OFFER.txt
- `legal/SOURCE_OFFER.txt`, upstream's text filled with:
  - the FFmpeg version, licence label and target
  - the release tag and the sources archive's name
  - the repository URL and commit (`FFMPEG_BUILD_SOURCE_REPO` / `_REF`, set by CI; locally the folder's git remote
    and HEAD, else the fallback wording)

**Source capture.**
- When the driver fetches a source, it keeps an immutable copy in the cache, under `sources/`:
  - a git checkout becomes `git archive` of the exact commit, with its submodules included
  - a downloaded tarball is kept as downloaded
- Each copy's sha256 (and commit, for git) goes into `<artifact>.sources.json`, written next to the archives, with:
  - FFmpeg's tarball, and the patch sets applied
  - each cached library's recorded source, so a library built from the cache still has its source on file
- A library whose source copy is missing from the cache is rebuilt, never shipped without one.

**Parity.** The comparison scripts gain a `legal/` section. Names come from the published archives; contents are
checked by tests on our own output (the governing texts per licence, and every declared file present).

**6a as built (rulings).**
- A file kept beside recipe.yml is written `{ recipe: LICENSE }` in `license-files:` (nv-codec, libdrm).
- `ships:` entries are `{ license, notice }`; the notice is a toolchain path where `${VAR}` is a variable of the
  platform's setup (`${TOOLCHAIN}/NOTICE` on Android). It lands in `legal/licenses/<file>/`, so libc++'s notice
  moves from `licenses/libc++/` to `licenses/libc++_shared.so/`.
- The discovery lint lists and doesn't fail (tests/license-lint.test.ts, over the sources a build kept): most
  candidates are tests, examples, vendored copies the build doesn't use, or build-time tools. It fails only when a
  declared file is missing from the kept source.
- Patch sets are planned, hashed and their licence texts shipped, but the driver doesn't apply patches yet.
- The release group isn't a target field yet, so the sources archive is named `ffmpeg-<ffmpeg>-sources.tar.gz`
  until 6b adds it; `release` is an option of the plan, unset by `build` (the offer then says the build is
  unreleased).
- Result: linux-x64-lgplv3 and win-x64-lgplv3 at the parity versions match the published 9.0.2.3 archives but for
  legal/ names, each difference listed with its reason in scripts/compare-published.expected.

## 6b. `ffmpeg-build bundle`

`ffmpeg-build bundle --release <ffmpeg>[:<group>] --dist <dir> [--build N] [--previous <manifest.yml>]`

It runs once per release, after all of that release's targets have built into `--dist`. It writes the rest of the
release into `--dist` and never uploads; the workflow does that.

**Refusals:**
- any target of the release is missing either archive or its `.sources.json`
- any asset name doesn't match the plan

**Writes:**
- **Sources:** one archive per release, `ffmpeg-<ffmpeg>[-<group>]-sources.tar.gz`. It is the union of every
  target's captured sources, plus:
  - the folder's `ffmpeg-build.yml` and `ffmpeg.lock`
  - the engine's recipes, platform scripts and image Dockerfiles at its version
  - each target's configure line
  - `SOURCES.md`: per target, which sources it used (sha256, commit, origin URL), and how to rebuild it

  A superset of each target's source is still that target's complete corresponding source. One archive avoids
  per-licence naming and duplication. This replaces the handoff's per-variant sources name.
- **`manifest.yml`**, fixed name: `release`, `ffmpeg`, `build`, `engine`, `group`, and `targets[]`. Each target
  has:
  - `name`, `platform`, `license`
  - `redistributable`: false for nonfree
  - `assets` (runtime and dev, each with name and sha256)
  - `toolchain` (its identity)
  - `components` (recipe and version)
  - `patches` (set name and sha256)
  - `not-included` (leftOut)
  - `definition` (sha256 of the target's resolved definition)

  The release also has `sources` (name and sha256).
- **`SHA256SUMS`:** every other asset, sorted, in `sha256sum` format. It doesn't list itself.
- **`release-notes.md`,** as the mockup's: a header, a nonfree banner, downloads, pins, not-included, and a collapsed
  component × target table with SPDX licences.
- **iOS bundle:** `bundle --apple`, a separate macOS step. For each licence it takes the ios-arm64, ios-sim-arm64,
  maccatalyst-arm64 and maccatalyst-x64 archives and writes `ffmpeg-<v>-ios-<license>.tar.gz`, keeping upstream's
  checks:
  - `lipo` fuses the two Catalyst slices, which are then re-signed (ad hoc)
  - each Catalyst slice's architectures are validated
  - each xcframework has exactly three slices
  - every slice's `legal/licenses/*` is present in the bundle's legal/
- **The removal guard (always-on, as in the handoff):**
  - A component in the last release's manifest that disappears from a target fails `update` and `bundle`.
  - The fix is `allow-removal: [<name>]` on that target, or on the folder for every target.
  - `update` and `bundle` find the last manifest themselves: the latest release of the same group and FFmpeg
    series, from the repository in `GITHUB_REPOSITORY` or the folder's git remote. `--previous` overrides it.
  - `check` stays offline and doesn't apply it.

## 6c. Workflows (reusable, in this repository)

**`.github/workflows/build.yml`** (`workflow_call`)
- Inputs:
  - `folder` (default `.`)
  - `publish`: `changed-only | always | never`
- Secrets: `token` (optional, for private patch repos)
- Steps:
  1. **plan:** `check`, then `releases --json --due`, a new command that lists each release with its targets,
     whether it's due, and each target's runner.
     - `runner:` per platform, in `platforms.yml`: `ubuntu-24.04-arm` for arm64 Linux, `macos-15` for every Apple
       platform (osx-x64 cross-builds there, with Rosetta for its checks), `ubuntu-24.04` otherwise.
     - Runner images are pinned by version.
  2. **build:** a matrix over every target in a due release, running `build --target`.
     - Images: buildx with `type=gha` cache, scoped per image folder.
     - The library cache uses `actions/cache`. Its key is a hash of the plan's library cache keys, which already
       hold the recipe, version, platform and toolchain identity, so a recipe or driver change gets a new key.
       Its restore keys are per platform.
     - Archives and `.sources.json` are uploaded as workflow artifacts, kept 5 days, with explicit timeouts.
  3. **ios:** on macOS, `bundle --apple` per release that has Apple targets.
  4. **bundle and release:** one job per due release.
     1. The job reads the repository's visibility from the API (`gh api repos/{repo} --jq .private`), not from an
        input.
     2. It refuses a nonfree target outright in a public repository. In a private one, the folder must say
        `nonfree-release: internal` (an acknowledgement); otherwise it refuses.
     3. It runs `bundle`.
     4. It runs `gh release create --draft`, then uploads, then `gh release edit --draft=false`, with
        `--latest` on the highest release.
     - The job uses `concurrency: release` and is never cancelled.
  5. **all-builds:** a gate job, to use as the single required check.
- **Done** means `actionlint`-clean and run once for real on the vetting repository (handoff step 9). Until then it is
  marked preview in the README.

**`.github/workflows/update.yml`** (`workflow_call`) runs `update --summary pr.md`. It opens or refreshes one PR
on `ffmpeg-build/update`, and can automerge.

**`.github/workflows/fetch-update.yml`** (`workflow_call`) for products. Input: `pin-file`. It runs
`fetch --update`, then opens or refreshes one PR.

**`examples/workflows/`** holds a consumer's `release.yml` (daily train, `publish: changed-only`), `update.yml`
and `dependabot.yml` (github-actions, weekly, grouped). This repository gets its own `.github/dependabot.yml`:
npm and github-actions, weekly, each grouped.

## 6d. `ffmpeg-build fetch` (products)

The pin file holds one line, `owner/repo@tag`, as in the mockup's `ffmpeg.version`.

**`fetch <owner/repo@tag> --target <name> [--dev] --out <dir>`** (`--platform` works when the release has exactly
one target for it):
1. Download the release's `manifest.yml`, using `GITHUB_TOKEN` or `GH_TOKEN` for private repositories.
2. Download the target's assets and check each sha256 against the manifest.
3. Extract into a temporary folder beside `--out`, refusing absolute paths, `..` entries and links that leave the
   folder.
4. Swap it into place, so `--out` holds exactly that release. The runtime and dev archives are merged when `--dev`
   is given. A `.ffmpeg-build-fetch` stamp makes a repeat run a no-op.

Release tags are treated as immutable: a manifest whose checksums differ from what the stamp recorded for the same
tag is an error.

**`fetch --update <pin-file> --target <name>`** finds the newest release of the same group in the same FFmpeg series
that has the target. It skips drafts and prereleases, and reads every page of releases. It then rewrites the pin
file and prints the change, for the PR body.

**Exit codes:** 0 when fetched or up to date; 1 on a checksum mismatch, a missing target or an unsafe archive; 2 on
usage, network or data errors.

## Not in this step

- `dev`, `test` and `patches export` (step 7).
- `ffmpeg-support.yml` (step 8).
- Attestations and SBOM formats. They can follow: `actions/attest-build-provenance`, and SPDX output from the
  manifest.
- **A legal review of the internal (nonfree, private) distribution model.** It is the owner's to arrange; the engine
  only enforces the acknowledgement.

## Order and checks

6a, 6b, 6d, then 6c.
- **6a:** a real linux-x64 lgplv3 rebuild; `legal/` names compared with the published archive; content tests; the
  lint over all recipes; the cache keeps legal files and sources.
- **6b and 6d:** unit and CLI tests, one real bundle of real builds, and a fetch of a real published release.
- **6c:** `actionlint`, then the plan job's commands run locally. A real run waits for the vetting repository.

## Revisions after the Codex critique (adopted)

1. **Changed-only rebuilds whole releases**, so assets never carry over.
2. **Sources are captured at build time**, as immutable objects with hashes, not re-fetched. The archive includes
   the build definition.
3. **One sources archive per release:** the union, with a per-target index. No per-licence name surgery.
4. **Licence files are declared per recipe**; discovery is only a lint.
5. **The nonfree guard reads repository visibility itself**, and private release needs an explicit acknowledgement.
6. **Release groups are explicit;** tags use the resolved FFmpeg version, as the handoff says.
7. **The removal guard is always on** in `update` and `bundle`, and finds the previous manifest itself.
8. **The iOS bundle keeps upstream's checks.** Cache keys come from library identities, runner versions are
   pinned, and "done" needs a real run.
9. **`fetch` follows the mockup's pin format**, with safe atomic extraction and immutable tags.
