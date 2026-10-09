# Targets and bases: design (profile shape, replaces the step-4 matrix)

Status: implemented on 2026-10-08 (branch `targets`, merged to main). Matrix profiles are gone: every command reads
`ffmpeg-build.yml`, and `ffmpeg-build migrate` converts an old folder. Two calls made while building it:
- migrate refuses pins one lock can't meet rather than guessing a version;
- artifact names stay as today's (`ffmpeg-<version>-<platform>-<variant>`), with a target's `-ffmpeg<series>`
  suffix dropped since the version already says it.
`profiles/devenvy.yml` is the shipped source now; the old `all.yml` is kept only as the migrate test's fixture.
Still to come (this spec, later sections): slim builds (`only:`), and optional pieces under target control.

Decided 2026-10-08: the owner delegated the choice to Claude and Codex ("you and codex decide") and approved the
result ("single profile file is nice"). This records the
outcome of the critique, and supersedes the step-4 profile format (`2026-10-08-explicit-profiles-design.md`). Its
licence checks, `uses:`, `licenses.yml` and the "nothing is added by itself" rule all stay.

## The problem

A profile is a matrix: FFmpeg series × platforms × licenses, with conditions on each entry. Working out what one
build gets means evaluating every condition in your head. "Which builds get Vulkan?" is hard to answer by reading.

## The rule

**A target is exactly one build: one platform, one license, one FFmpeg series.** Shared lists live in bases. There
are no per-entry conditions and no matrix. What a target lists, after its bases, is what that build gets.

## The file

One file per folder, `ffmpeg-build.yml`:

```yaml
bases:
  common:  { with: [dav1d, opus, srt] }
  windows: { with: [schannel, d3d11va, dxva2, mediafoundation] }
  v3:      { with: [vulkan, placebo] }
  gpl:     { with: [x264, x265], without: [kvazaar] }
pin:
  dav1d: "~1.5"                       # folder-wide constraint
targets:
  win-x64-gplv3:
    platform: win-x64
    license: gplv3
    ffmpeg: 9
    base: [common, windows, v3, gpl]
  dvr:
    platform: linux-arm64
    license: nonfree
    ffmpeg: 9
    with: [nvenc, srt]
    pin: { nvenc: "13.0" }            # this target's constraint
```

- **Bases** hold only `with`, `without` and `pin`. Bases don't nest.
- **A target** has `platform` (one), `license` (one) and `ffmpeg` (one series: `9`, `9.0` or `latest`), plus
  optional `base`, `with`, `without`, `pin`, `patches` and `tests`.
- **Building several FFmpeg series** means one target each (`win-x64-lgplv3-ffmpeg8`).
- **Names** are lowercase and unique in the folder. The target name is the build's identity: its artifacts are named
  `ffmpeg-<exact version>-<target>` (`ffmpeg-9.0.2-win-x64-gplv3`, today's devenvy names).

## Merging

Ordered set operations:
1. Start empty.
2. Apply the bases left to right: each `with` adds, then each `without` removes.
3. Apply the target's own `with`, then its `without`.

Listing the same name under both `with` and `without` in one layer is an error.

**`without:` is also a deliberate "no".** Anything a target ends up excluding through a `without` (its own or a
base's) is never suggested by `profile missing` / `add-missing`, nor listed as "not in your target" in update notes.

## Checks (unchanged in spirit, simpler in form)

- **Availability.** An entry that can't be built for the target (FFmpeg doesn't offer it there, no recipe builds
  there, or the license doesn't allow it) is an error. The message names the cause and the fix: remove it, or move it
  to a base this target doesn't use.
- **Optional pieces** (`uses:`) are reported where they are left out, as now.
- **Group conflicts** (two TLS libraries) are errors.

## Versions and the lock

- **One version per library per folder.** All targets share it, so an update PR moves each library once.
- **Pins are constraints.** The folder-wide pin and each target's pin for a library are intersected. When no version
  satisfies all of them, that is an error naming the pins.
- **FFmpeg versions** are locked per series (as now): targets building the same series share the exact release.
- **`ffmpeg.lock`** keeps `ffmpeg: { "9": 9.0.2, ... }` and `libraries: { dav1d: 1.5.4, ... }` once per folder.

## FFmpeg versions: what gets mentioned

- **Older series are never mentioned.** Building FFmpeg 9 says nothing about 4 through 8 existing.
- **A target's own series moves forward as written:** `latest` follows new majors in update PRs (called out; a listed
  option the new major drops is an error in that PR), `9` follows 9.x, `"9.0"` stays on 9.0.x.
- **A newer major is a note, not a warning:** when FFmpeg N+1 appears and no target in the folder builds it,
  `outdated` and the update PR say so once per run ("FFmpeg 10 is out; your targets build 9: add targets for 10, or
  use `ffmpeg: latest`"). Never in `check`, never a failure, only above the newest series the folder builds.
  Folder-level `notify: { new-ffmpeg: false }` turns it off.
- New options within a series are listed in update notes; `without:` silences the unwanted ones.

## Commands

- **`show <target>`:** the flattened build (options, libraries and versions), and for each entry which layer added it.
- **`show --has <name>`:** which targets get it and why the rest don't.
- **`targets [--json]`:** the targets, for CI matrices.
- **`check` / `plan` / `build --target <name>`:** per target. `build` takes a target, not a platform/license
  selection.
- **`profile add/remove <names> --to <base|target>`**, `missing [--target]`: grouped across targets when there is no
  `--target` ("whisper could be added to 14 targets").
- **`update`:** the PR groups findings by identical target sets.
- **`init`:** writes `ffmpeg-build.yml` from the shipped bases for the platforms and licenses asked for. A
  distribution like devenvy's gets its targets generated; a single build gets one target.

## Migration

`ffmpeg-build migrate` turns today's profiles and lock into the new file deterministically:
1. Expands each profile's matrix into targets named as today's assets are.
2. Factors shared lists into bases. The shipped profile becomes shipped bases.
3. Keeps lock versions where every target agrees on a version.
4. Refuses, naming them, where targets' locked versions or pins can't be consolidated.

## What stays

`licenses.yml` and licence closure, `uses:`, recipe and option data, platform data, the build driver, the library
cache, patch sets and their checks, the `--json` outputs and the agent guide (updated).

## Optional pieces (`uses:`) under a target's control (possible later)

Optional pieces are built in wherever license and platform allow (whisper's Vulkan shim on Windows, mbedTLS for SRT).
If a target ever needs one out, `without:` may name the piece (`without: [vulkan-shim]`: whisper on CPU only), shown
by `show`. Not built until someone asks.

## Not decided here

Whether bases may live in separate files shared between folders. Wait for a real need.

## Slim builds (second phase)

FFmpeg builds every internal component unless told otherwise: decoders, encoders, muxers, demuxers, parsers,
bitstream filters, filters, protocols, devices, the libavdevice/libavfilter libraries, network support and the
programs. (`--disable-autodetect` already keeps undeclared system libraries out.)

- **Default:** everything FFmpeg builds, plus what the target lists (today's behaviour, today's devenvy builds).
- **`only:`** (on a base or a target) lists FFmpeg components by kind: `decoders`, `encoders`, `demuxers`, `muxers`,
  `parsers`, `bsfs`, `protocols`, `filters`, `indevs`, `outdevs`, `hwaccels`. With it, configure gets
  `--disable-everything` plus `--enable-<kind>=<name>` for each. Every `with:` library adds its own components (dav1d
  → decoder libdav1d); `show` names which entry added each.
- **`without:`** also takes FFmpeg's own parts: `avdevice`, `avfilter`, `network`, `programs`, `ffprobe`.
- **Validation:** component names are checked against per-major lists from FFmpeg's `configure --list-*`, kept in
  engine data (generated by a script now; refreshed by the nightly `ffmpeg-support.yml` of step 8).
- **Updates:** a slim target never gains new components on its own; the update notes still list what a new minor adds,
  and `without:` silences those it doesn't want.
