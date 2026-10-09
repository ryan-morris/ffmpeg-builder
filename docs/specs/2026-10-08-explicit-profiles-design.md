# Explicit profiles, licenses and profile helpers: design (handoff step 4)

Decided with the owner on 2026-10-08. This replaces parts of the earlier profile vocabulary.

## The rule

**A profile is the complete list of what it builds. The code makes no choices; it only checks.**

- **Not listed means not included.** Nothing is opted in by default, by an engine release, or by an FFmpeg
  release. A tight profile (e.g. a DVR's five libraries) stays tight.
- **Recommendations live in profiles the engine ships**, not in code. `ffmpeg-build profile init` copies one to start
  from, and the `profile` helpers edit a profile without hand-editing YAML.
- **What the code still does:**
  - **Availability facts:** whether FFmpeg or a recipe can build something on that platform or FFmpeg version. An
    unconditional `with:` entry that isn't available there is left out and reported, as before.
  - **License compliance as a check:** an entry that would put a library into a build whose license doesn't allow it
    is an **error** with a fix. It is never silently dropped.
  - **Conflicts as errors:** two TLS backends in one build.
  - **Optional pieces a recipe uses when the license allows** (SRT's encryption through mbedTLS). This is how a
    library is built, not a choice between alternatives.

## Profile changes

- **`start:` is removed.** A profile with `start:` gets one plain error: "start: was removed: a profile now lists everything it builds. Delete the `start:` line. If it said `start: everything`, then run `ffmpeg-build profile add-missing` to list what it used to build in."
- **`prefer:` is removed** from recipes and FFmpeg data. The `group:` facts stay, so conflicts can be found.
- Everything else is unchanged: `with`, `without`, conditions, `pin`, `patches`, `tests`.
- **What a condition asks for:** a `platforms:` or `ffmpeg:` condition requires the entry wherever it matches (an
  error where it can't be built). A `license:` limit is compliance only: it is what check's license fix adds, so it
  never turns into a requirement. A matching `without:` entry is the profile's own exception: reported, never an
  error.

## Licenses

`licenses.yml` in the engine data says which profile licenses each SPDX licence may be linked into. This is reviewed
policy, not legal advice, carried over from devenvy/ffmpeg's `04_select_license.sh`:

| SPDX | Allowed in |
|---|---|
| permissive (MIT, BSD-*, ISC, Zlib, libpng, FTL, HPND, Unicode, WTFPL, TU-Berlin-2.0, BSD-2-Clause-Patent, ...) | all |
| LGPL-2.0-or-later, LGPL-2.1-or-later, MPL-2.0 | all |
| LGPL-3.0-or-later | lgplv3, gplv3, nonfree |
| GPL-2.0-or-later | gplv2, gplv3, nonfree |
| GPL-3.0-or-later | gplv3, nonfree |
| Apache-2.0 | lgplv3, gplv3, nonfree |
| FDK-AAC, proprietary | nonfree |

- **How an expression is read:**
  - `A OR B` is allowed wherever either is.
  - `A AND B` is allowed only where both are.
  - Parentheses work.
- **Unknown names:** a licence missing from the table is an engine-data error.
- **A library is allowed in a build** when its own licence and that of everything it `needs` (all the way down)
  allow the build's license, and FFmpeg's own class (`ffmpeg-license`) does too.
- **This reproduces today's builds with no TLS-specific code:**
  - OpenSSL, mbedTLS, Vulkan, shaderc and AMR (Apache-2.0) are out of v2 builds.
  - GnuTLS is out of lgplv2, through GMP and nettle (LGPL-3.0-or-later OR GPL-2.0-or-later), but in gplv2.
  - x264 and x265 (GPL) are out of the LGPL builds.
- **Messages name the cause and the fix**, e.g.:
  - "openssl is Apache-2.0, which gplv2 doesn't allow. Limit this entry with `license: [lgplv3, gplv3, nonfree]`."
  - "gnutls needs gmp (LGPL-3.0-or-later OR GPL-2.0-or-later), which lgplv2 doesn't allow."
- **Patch sets:** `patches/<set>/about.yml` declares `license:`. `proprietary` requires `nonfree`; an SPDX licence
  follows the table. `check` reads it and reports a mismatch, as the mockup's `check.txt` shows. Applying patches
  during `build` is a later step.

## Optional pieces: `uses:`

- **The new recipe key:** `needs-one-of:` becomes `uses: [<recipe>, ...]`. Each one is built into a build when that
  build's license and platform allow it, and left out otherwise. There is no ordering and no choosing between
  alternatives.
- **What changes in the recipes:**
  - srt and librist: `uses: [mbedtls]`. mbedTLS is `Apache-2.0 OR GPL-2.0-or-later`, so they are encrypted
    everywhere but lgplv2. (Upstream also left gplv2 unencrypted; the GPL-2.0 side of mbedTLS's licence allows it.)
  - whisper.cpp: `uses: [vulkan-loader]`. It uses the Vulkan backend when the loader is in the build, and the CPU
    backend otherwise. Its `build.sh` decides by what is in `DEPS_DIR`, as srt's already does.
- **Reporting:** `check` reports what was left out, e.g. "srt: built without encryption on lgplv2, gplv2 (mbedtls is
  Apache-2.0)".
- **Cache keys:** the cache key includes the keys of the `uses` members that are in the build.

## Shipped profiles

`profiles/all.yml` reproduces today's devenvy/ffmpeg builds, every platform × license cell, with explicit entries and
conditions:

- **TLS:**
  - `schannel` on win-*
  - `securetransport` on osx-* and ios-*
  - `openssl` on linux-*, android-* and maccatalyst-* for lgplv3, gplv3 and nonfree
  - `gnutls` there for gplv2 only
  - lgplv2 lists none, which matches today.
- **License-limited entries:** x264 and x265 (GPL); vulkan, placebo, opencore-amr and vo-amrwbenc (v3 and nonfree);
  kvazaar (LGPL builds only; upstream drops it from GPL builds as redundant).
- **The lean iOS-simulator slice:** upstream's drops become `without:` entries limited to `ios-sim-arm64`.

It is the one place that encodes what may go where. Users don't copy it and work out the matrix themselves:
`profile init` narrows it to the licenses and platforms they ask for (below). Shipping more starting points later
(e.g. a lean set) is just adding profiles.

## Profile helpers

| Command | Does |
|---|---|
| `profile init [file] [--license ...] [--platforms ...] [--ffmpeg ...] [--from <shipped>] [--empty]` | writes a new profile (default `ffmpeg.yml`, `name:` from the file name) from a shipped one (default `all`), narrowed to the given licenses, platforms and FFmpeg majors: entries usable nowhere in that selection are dropped, and conditions that no longer narrow anything are removed (`openssl: { platforms: [linux-*] }` becomes `openssl` for `--platforms linux-x64`). `--empty` writes only the header, to build up with `add` |
| `profile add <name...> [--platforms ...] [--license ...] [--ffmpeg ...] [--profile file]` | adds entries: with flags, using those conditions; without flags, using the conditions the shipped `all` profile gives that name (or none if it doesn't have it) |
| `profile add-missing [--profile file]` | adds every option of the profile's FFmpeg majors that isn't listed, each as `add` would |
| `profile missing [--profile file]` | lists them, without changing anything; exits 1 when there are any, so a workflow can decide whether to open a PR |
| `profile remove <name...> [--profile file]` | removes every `with:` entry for those names |

- **Editing:** all edits keep comments and layout (yaml's document editing) and run `check` afterwards.
- **Which file:** `--profile` defaults to the only profile in the folder.
- **Made for workflows too:** no command prompts, and edits are small diffs, so a scheduled workflow can run
  `update` (and, if the consumer wants, `profile add-missing`) and commit the lock and profile back as a PR. Opt-in
  stays explicit because a person merges it. The example workflows ship with step 6.
- **Syntax:** the exact CLI syntax may still change.

## Reporting what's new

When `update` moves to a new FFmpeg minor, the PR's callout lists what that minor adds and marks which entries the
profile doesn't list, e.g. "whep (not in your profile: `ffmpeg-build profile add whep`)". `outdated` does the same.
Nothing is added automatically.

## Not in this step

- **Platforms other than linux-x64:** `all.yml` states the intent for every platform, but only linux-x64 has
  recipes, so its parity is what the tests assert. Those platforms' Vulkan providers (Windows shim, NDK loader,
  MoltenVK), libass without fontconfig, whisper's Metal/Windows/Android builds and `linux-armhf` (built upstream,
  not yet in the platform list) arrive with their recipes.

- Applying patches during `build`; the removal guard (it needs the published manifest); recipes for other platforms.
- **The mockup's profiles:** `docs/design/mockup` is the historical spec and is left as written. Its profiles use
  `start:`. The smoke tests switch to the shipped `profiles/all.yml` and to a dvr-style explicit profile.
