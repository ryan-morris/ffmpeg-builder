# Using ffmpeg-build

A guide for anyone driving ffmpeg-build for someone else, such as an AI agent or a script: how to turn "I need
FFmpeg with X on Y" into targets that build. `ffmpeg-build guide` prints it.

## What you are editing

A folder's **`ffmpeg-build.yml`** lists its builds. Each **target** is one build: one platform, one license, one
FFmpeg series. **Bases** hold what several targets share; a target takes its bases left to right, then its own lists.
Nothing is ever added by itself.

```yaml
pin:                                     # npm-style ranges, per library, for every target that builds it
  dav1d: "~1.5.4"
notify: { new-ffmpeg: true }             # say when an FFmpeg major newer than every target's series is out
bases:
  common: { with: [dav1d, opus, srt] }
  gpl:    { with: [x264, x265] }
targets:
  linux-x64-gplv3:                       # the name is also the build's name: ffmpeg-<version>-linux-x64-gplv3
    platform: linux-x64
    license: gplv3                       # lgplv2, lgplv3, gplv2, gplv3 or nonfree
    ffmpeg: 9                            # 9, 9.0 or latest
    base: [common, gpl]
    with: [vaapi]                        # by FFmpeg's own names
    without: [opus]                      # turn down what a base gives; it is never suggested again
    pin: { x265: "4.1" }                 # this target's own pins
    patches: [patches/acme-muxer]
    tests: [./tests/roundtrip.sh]
```

`with:` and `without:` hold plain names: a target is one build, so there are no conditions. The editor schema is
`schema/ffmpeg-build.schema.json` in the package.

## The commands, in the order you'd use them

1. `ffmpeg-build options --json`: every name a target can list, with its library, SPDX licence, the licenses that
   allow it and the platforms it builds on. Read this instead of guessing what a license allows.
2. `ffmpeg-build init --license <list> --platforms <list> [--ffmpeg <list>] [--empty]`: write `ffmpeg-build.yml` from
   the shipped devenvy targets, narrowed to that selection (the newest FFmpeg unless `--ffmpeg` says otherwise). With
   `--empty`, bare targets only.
3. `ffmpeg-build profile add <names...> --to <base or target>`: a base reaches every target using it; a target, just
   itself. `ffmpeg-build profile remove <names...> --from <base or target>`: from a target, it also turns down what a
   base still gives it.
4. `ffmpeg-build check --json`: is every target possible? `profile missing --json [--target T]` lists what targets
   could add but neither list nor turn down.
5. `ffmpeg-build show <target>` says what a target gets and which base gave it; `show --has <name>` says which
   targets get something and why the others don't. `ffmpeg-build targets --json` lists them (for CI matrices).
6. `ffmpeg-build lock`: write `ffmpeg.lock`, one version per library for the whole folder (asks upstream; needs git).
   `ffmpeg-build update` moves it to the newest versions allowed; `outdated` shows what update would do.
   `ffmpeg-build plan --json` shows each target's options, libraries and versions.
7. `ffmpeg-build releases --json` lists the releases (targets released together: same `release-group:` and FFmpeg
   version), each with its next tag, whether it is due and why, and each target's CI runner. A component a target
   had in its last release and would now lose stops `update` and the release; `allow-removal: [<name>]` allows it.
8. `ffmpeg-build build --target <name>`: build it (Docker for Linux, Windows and Android; Xcode on a Mac for Apple).

A product that uses FFmpeg without building it pins a release instead: `ffmpeg.version` holds `owner/repo@tag`, and
`ffmpeg-build fetch ffmpeg.version --target <name> [--dev] --out <dir>` downloads, checks and unpacks it.
`fetch --update ffmpeg.version --target <name>` moves the pin within the same FFmpeg major.

A folder that still has old matrix profiles (`*.yml` with `name:`, `platforms:` and so on) gets one answer from every
command: run `ffmpeg-build migrate`. It writes `ffmpeg-build.yml` and one lock that build exactly what the old files
did, and keeps those as `*.old`.

Every command is non-interactive. Edits keep the file's comments and are checked before they are written.

## Reading check

- `✓` is there; `-` is reported, not an error (e.g. not available on that platform); `✗` is a problem.
- Each `✗` comes with its fix, e.g. "Remove it from this target (it needs license: lgplv3, gplv3 or nonfree)":
  `profile remove <name> --from <target>`.
- Two TLS libraries in one build are a conflict: keep one, and turn the other down with `without:`.

## Exit codes

0: fine. 1: a target has problems (or `profile missing` found something). 2: usage, data, network or tool problem;
the message says which.
