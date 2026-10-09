# Handoff: ffmpeg-build (the FFmpeg builder engine)

You are starting a new project in a fresh directory: **`ffmpeg-build`**, an engine (a CLI plus
library recipes) that builds FFmpeg from a short YAML profile. It is extracted from, and replaces
the build logic of, the existing repo **`devenvy/ffmpeg`** (local: `D:\Source\ffmpeg`), which is
your reference implementation. The owner will create two GitHub repos to vet against.

**Read first:** the mockup at **`C:\temp\ffmpeg-playground`**. It shows exactly how every repo,
profile, lock, workflow and command output should look. Start at its `README.md`, which links
every topic. This document explains the why and the build order; the mockup is the spec for the shape.

---

## 1. Why this exists

The owner ships OSS FFmpeg builds (`devenvy/ffmpeg`) and, at work, internal builds containing
proprietary code (their own muxer/demuxer) under an internal-use-only license. Keeping two copies
of complex build scripts in sync is the problem. The answer is **one engine, many small consumer
repos that only say what to build**:

| Repo | Contains | Visibility |
|---|---|---|
| `ffmpeg-build` (new) | CLI + recipes. The **only** place build logic lives. | public |
| `devenvy-ffmpeg` (today's `devenvy/ffmpeg`, slimmed) | `ffmpeg.yml` profile + `ffmpeg.lock` + 2 workflows | public |
| company repo (e.g. `company-ffmpeg`) | one profile per product + proprietary patches + lock | private |
| products (e.g. `dvr-firmware`) | one line pinning a *published* build; never build FFmpeg | private |

Goal: greatly simplify every FFmpeg use case: OSS distribution, internal builds, lightweight
builds, and builds with custom patches.

---

## 2. Settled decisions (do not reopen without the owner)

**Format and files**
- **YAML everywhere** (profiles, recipes, lock, manifest). The CLI reads YAML scalars as **strings**
  and validates against a schema, so `ffmpeg: 9.10` is never read as the number 9.1.
- Lock file: **`ffmpeg.lock`** (YAML content) next to the profiles, written only by the CLI. This
  follows the Helm `Chart.yaml`/`Chart.lock` and Dart `pubspec.yaml`/`pubspec.lock` convention.
- **Asset names stay exactly as today**: `ffmpeg-{ffmpeg}-{platform}-{variant}.tar.gz` plus
  `-dev.tar.gz`; tags `{ffmpeg}.{build}` (or `{profile}-{ffmpeg}.{build}` when a repo has
  several profiles). Each release also publishes `SHA256SUMS`, `manifest.yml` (fixed name) and
  `ffmpeg-{ffmpeg}-{variant}-sources.tar.gz`.

**Profile vocabulary** (the whole thing; see `examples/profile-reference.md` in the mockup)
- Keys: `name`, `ffmpeg`, `platforms`, `license`, `start`, `with`, `without`, `pin`,
  `patches`, `tests`.
- **No inheritance or shared files** (`extends` was rejected as overbuilding). Lists expand into
  variants: `ffmpeg: [8, 9]` × `license: [...]`.
- `start: everything | nothing`. There are no other presets.
- Names in `with`/`without`/`pin` are friendly names (`nvenc`, `x265`, `whisper`, `openssl`);
  users never need to know library versus FFmpeg option.
- **Conditions** use only `ffmpeg`, `platforms`, `license`.
  - Different keys in one condition: AND.
  - Values in one list: OR.
  - Separate entries: OR.
  - "Everything except": use `without`.
  - For `pin`, the first matching entry wins.
- **`with:` semantics.**
  - Without a condition: include it wherever FFmpeg offers it. Expected absences are reported,
    not errors (whisper on FFmpeg 4, NVENC on macOS).
  - With a condition: required within that scope.
  - Something that would be in no build at all is an error.
- **Always-on guard:** anything in the last published build that would be missing from the next
  one stops `update`/`build` until it is removed from the profile or approved.

**Licenses**
- `license: lgplv2 | lgplv3 | gplv2 | gplv3 | nonfree`.
- `nonfree` maps to FFmpeg's `--enable-gpl --enable-version3 --enable-nonfree` and means
  internal use only. Its manifest says `redistributable: false`.
- The engine **refuses to publish a nonfree build to a public repo**.
- What each license allows comes from FFmpeg's own configure classification (GPL / version3 /
  nonfree lists, regenerated nightly), plus SPDX licenses declared by each recipe and patch set.
  A patch set with `license: proprietary` requires `nonfree`.

**TLS:** no special flag. OpenSSL, GnuTLS and mbedTLS are ordinary recipes; SChannel and Apple's
TLS are FFmpeg built-ins.
- They share `group: tls` (FFmpeg uses one per build), and `prefer:` decides which one `start:
  everything` picks per platform. License facts do the rest: OpenSSL (Apache-2.0) is excluded
  from v2 builds, so those get GnuTLS on Linux/Android.
- SRT/RIST crypto is `needs-one-of: [gnutls, mbedtls, openssl]`.
- Today's TLS logic is scattered across `scripts/steps/04_select_license.sh`,
  `03_install_packages.sh`, `scripts/deps/{mbedtls,librist,libsrt}.sh`. Port its *behavior*, not
  its structure.

**Versions and updates**
- **The engine tracks no library versions.** Recipes say how to build a library and where its
  versions come from (`versions:` git-tag regex, or release-listing URL plus filename regex).
- Each consumer's `ffmpeg-build update` asks **upstream directly**, writes its own lock, and opens a
  PR. The consumer's CI is the safety check.
- There is no central catalog, no vetting step, no Renovate and no vcpkg/Conan. vcpkg was
  evaluated: it covers ~47 of ~55 libraries but lags upstream, lacks 8 we need, and upstreaming
  ports means maintaining them through their review queue. Rejected.
- Update rules are in `examples/update-rules.md`:
  - `ffmpeg: 9` takes any 9.x; a new minor is called out at the top of the PR. `ffmpeg: 9.0`
    stays on 9.0.x.
  - A new major is reported, never applied. `ffmpeg: latest` moves only when every check passes.
  - Engine majors are never applied automatically.
  - A license change the profile doesn't allow is not taken.
  - A version below FFmpeg's minimum is flagged.
- **Maintenance is triggered by breakage, not by releases.** A new library version needs no one;
  a recipe gets fixed only when the version fails to build (consumers pin meanwhile).

**FFmpeg support (the only thing the engine watches)**
- Nightly and **stateless**: regenerate `ffmpeg/<major>.yml` from the `configure` of every release
  of the handled majors and compare with what's committed. No diff is a no-op.
- Each option records: built-in or needs-library, `since:`, `min:` version, license class,
  platforms.
- Pure-data differences auto-merge and ship as a CLI patch release.
- An option needing a library with **no recipe** gets a scaffold PR (upstream guessed via Repology
  plus Debian `Vcs-Git`, build system detected, Linux try-build), **never auto-merged**: a person
  confirms the upstream.
- Point releases (x.y.z) rarely change anything; minors (x.y) are where new options appear.

**Developing patches** (`examples/dev-loop.md`)
- `ffmpeg-build dev` sets up a one-platform workspace: cached libraries, plus the FFmpeg source as
  a git checkout with patches applied as commits.
- `dev make` rebuilds incrementally. `test` runs smoke tests plus the profile's `tests:`.
  `patches export` writes the commits back to `patches/<major>/*.patch`.
- The **library cache** keyed by (recipe, version, platform, toolchain image) is core, not optional.

**CLI** (Node/TypeScript, npm `ffmpeg-build`). Commands: `check`, `plan`, `lock`, `outdated`,
`update`, `build`, `dev`, `test`, `bundle`, `patches export`, `fetch` (and `fetch --update`).
- Managing profiles needs only Node.
- Building: Apple targets need macOS/Xcode; everything else runs in the engine's pinned toolchain
  images (Docker), whose digests are recorded in the lock (`examples/hosts.md`).
- The **~60 bash recipes stay bash**, moved from `scripts/deps/*.sh`.

**Products** never build FFmpeg. They pin a published release (`ffmpeg.version`), `ffmpeg-build
fetch` reads `manifest.yml` and checks sha256, and a reusable `fetch-update.yml` opens bump PRs.
Every consumer owns and publishes its own builds; nothing depends on someone else's hosted
binaries. (FFmpegKit was retired in Jan 2025 and its binaries deleted; don't repeat that.)

---

## 3. Mapping from today's repo (`D:\Source\ffmpeg`)

| Today | Becomes |
|---|---|
| `scripts/deps/*.sh` (~60 recipes) | `recipes/<name>/build.sh` + a new `recipe.yml` (facts: license, provides, configure flags, source, versions, platforms, group/prefer) |
| `deps.json` (the ledger) | gone from the engine. Versions move into each consumer's `ffmpeg.lock`; source/origin/mirror facts move into recipes |
| `scripts/platform/*`, `scripts/steps/02,05` | `platforms/` + toolchain images |
| `scripts/steps/04_select_license.sh`, TLS bits | license logic driven by FFmpeg's classification + recipe SPDX; TLS via group/prefer |
| `scripts/steps/07` (FFmpeg build), `08` (stage), `09` (verify), `10` (legal) | engine build pipeline; `10_write_legal.sh` grows into the source bundle |
| `scripts/gen-coverage.sh` / `gen-matrix.sh` (configure parsing) | the nightly `ffmpeg/<major>.yml` generator; the matrix becomes release notes + `plan` output, **not committed docs** |
| `scripts/test/*` | engine smoke tests (`ffmpeg-build test`) |
| `.github/workflows/build.yml`, `test*.yml`, `release.yml` | engine reusable `build.yml`; the consumer keeps only a short `release.yml` |
| Renovate + `renovate-matrix.yml` + `check-updates.yml` | replaced by `ffmpeg-build update` (consumers) and `ffmpeg-support.yml` (engine) |

Hard-won fixes live in today's recipes and their comments; read them before changing anything.
Examples: x265 4.3 on ARM64, whisper via the static Vulkan shim on win-arm64, freetype/fontconfig
GitHub mirrors, SourceForge→Debian tarball fallbacks, shaderc DEPS verification, bounded apt, the
nv-codec 13.0 driver-floor reasoning (issue #54).

---

## 4. Suggested build order

1. **Skeleton:** repo layout per the mockup, profile schema, YAML loading (strings only), `check`
   and `plan` against hand-written `ffmpeg/9.yml` and a few recipes. Pure data, no building yet.
2. **`lock` + `outdated` + `update`** with upstream version discovery from recipe `versions:`
   entries, plus the update rules and their tests.
3. **`build` for one platform** (linux-x64) using ported recipes inside a pinned toolchain image,
   with the library cache. Reproduce today's linux-x64 LGPLv3 artifact and compare it with the
   published one.
4. **Licenses, groups (TLS), conditions, the always-on removal guard.**
5. **Remaining platforms**, porting recipes and platform setup; Apple on macOS runners.
6. **`bundle`** (source bundle, `manifest.yml`, release notes with the matrix) and the reusable
   `build.yml` / `update.yml` / `fetch-update.yml` workflows.
7. **`dev` / `test` / `patches export`.**
8. **Nightly `ffmpeg-support.yml`**, porting the configure parsing from `gen-coverage.sh`.
9. **Vet with the two repos the owner creates:** one mirroring today's OSS distribution
   (`examples` in the mockup's `devenvy-ffmpeg/`), one with a nonfree profile plus a dummy
   proprietary patch set.
10. Only then: migrate `devenvy/ffmpeg` onto the engine.

---

## 7. Parked for later (not v1)

- A web profile editor (explicitly dropped).
- Extensions that add whole new libraries (v1: patches + configure flags only).
- `ffmpeg: [4, 9]`-style "use where available" was solved by the `with:` semantics above; no
  extra syntax needed.
- Optional: contributing ports to vcpkg as goodwill, unrelated to the engine.
