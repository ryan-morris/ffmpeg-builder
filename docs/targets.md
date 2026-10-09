# Targets: ffmpeg-build.yml

A folder's `ffmpeg-build.yml` lists its builds. Each **target** is one build: one platform, one license, one FFmpeg
series, and the complete list of what it gets. **Bases** hold what several targets share; a target takes its bases
left to right, then its own lists. Nothing is added by itself, not by an engine release and not by a new FFmpeg
version, so a tight target (a DVR's five libraries) stays tight.

```yaml
pin:                                     # npm-style ranges, for every target that builds the library
  dav1d: "~1.5.4"
bases:
  dvr: { with: [dav1d, opus, srt, openssl] }
targets:
  linux-x64:                             # the name is also the build's: ffmpeg-<version>-linux-x64
    platform: linux-x64
    license: lgplv3                      # lgplv2, lgplv3, gplv2, gplv3 or nonfree
    ffmpeg: 9                            # 9, 9.0 or latest
    base: [dvr]
    with: [vaapi]                        # by FFmpeg's own names
  linux-arm64:
    platform: linux-arm64
    license: lgplv3
    ffmpeg: 9
    base: [dvr]
    without: [opus]                      # turn down what a base gives; never suggested again
```

The editor schema is [`schema/ffmpeg-build.schema.json`](../schema/ffmpeg-build.schema.json).

## Starting and editing

- **Start from the shipped targets.** You don't need to work out what each license allows on each platform yourself.
  [`profiles/devenvy.yml`](../profiles/devenvy.yml) is everything devenvy/ffmpeg publishes, one target per platform,
  license and FFmpeg series. `ffmpeg-build init --license <list> --platforms <list> [--ffmpeg <list>]` takes the
  targets you select and factors what they share into bases. `--empty` gives bare targets.
- **Edit with the helpers, or by hand.** Each helper keeps your comments and checks every target the edit reaches:

      ffmpeg-build profile add x265 srt --to gpl           # a base: every target using it
      ffmpeg-build profile add vaapi --to linux-x64        # one target
      ffmpeg-build profile remove opus --from linux-arm64  # a target turns down what its base gives it
      ffmpeg-build profile missing                         # what targets could add but don't list (exit 1 if any)

- **Look before you build.** `check` says whether every target is possible, `plan` what each builds,
  `show <target>` what one target gets and which base gave it, and `show --has <name>` which targets get something
  and why the others don't.

## Rules

- **Saying no is explicit.** `without:` turns something down for good: `profile missing` and the update PR text stop
  suggesting it.
- **Licenses are checked, never guessed.** An option whose library a target's license doesn't allow is an error that
  says which licenses would allow it. Which licenses each library may go into is in
  [`licenses.yml`](../licenses.yml): an SPDX table, applied to the library and everything it needs. Optional pieces
  are built in only where their license allows, and `check` says where they are left out (SRT's encryption uses
  mbedTLS, which lgplv2 builds can't take).
- **One version per library.** `ffmpeg.lock` holds one FFmpeg release per series and one version per library for the
  whole folder. Pins (`pin:` at the top for every target, or on a target) are constraints the chosen version must
  meet, all of them. Pins use npm's range syntax: `"4.3"`, `"~1.5.4"`, `"^1.5.4"`, `">=3.6 <4"`; a library that
  follows a branch is pinned to a full commit hash.
- **New FFmpeg versions.** When `update` moves to a new FFmpeg minor, the PR text lists what it adds and which
  targets don't list it. When a new major is out, it says so once (`notify: { new-ffmpeg: false }` turns that off).
  You decide; nothing is opted in.
- **Versions come from upstream.** `lock`, `outdated` and `update` read upstream git tags, branches and release
  pages (they need `git` on PATH, and no API tokens).

## Old matrix profiles

Before targets, a profile was one file with `platforms:` and `license:` lists and conditional entries.
`ffmpeg-build migrate` turns a folder of them, and its lock, into `ffmpeg-build.yml` and one lock that build exactly
the same, with the same asset names. The old files are kept as `*.old`. Every other command in such a folder says to
run `migrate`.
