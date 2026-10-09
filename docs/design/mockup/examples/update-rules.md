# The rules `ffmpeg-build update` follows

`update` asks upstream directly (each recipe says where its versions come from), rewrites
**only the lock**, and leaves the decision to CI: the update PR builds; green merges (or a person
does). The profile is never edited by the tool.

## FFmpeg

| Profile says | `update` does |
|---|---|
| `ffmpeg: 9` | Any 9.x: point releases (9.0.3) and new minors (9.1.0). A new minor is called out at the top of the PR with what it adds. |
| `ffmpeg: 9.0` | 9.0.x point releases only. |
| `ffmpeg: [8, 9]` | Each line moves within its own series. A new 10 is reported, never added. |
| `ffmpeg: latest` | Moves to a new major **only when** the engine knows that major, every `with:` that was available still is, every patch set has a folder for it, and the license still allows everything. Otherwise stays and says what blocks it. |

Background: FFmpeg's **x.y** releases (9.0, 9.1) are cut from development and add features; x.0
also breaks ABI. **x.y.z** releases are backported fixes. The engine regenerates its knowledge of
every release nightly, so options gained in a minor are available the moment you move to it.

## Libraries

| Profile says | `update` does |
|---|---|
| nothing | newest upstream release, majors included; CI is the check |
| `pin: { x265: "4.3" }` | 4.3.x only |
| `pin: { x265: "4.3.1" }` | exactly that |
| `without: [x265]` | never included |

- Not taken: a version **below FFmpeg's minimum** for your FFmpeg version; a version whose
  **license** your profile doesn't allow. Both are explained in the PR.
- If a new version **breaks the build**, the PR is red: `pin` the previous version until the
  engine's recipe is fixed.

## Never silently

Anything present in the **last published build** that would be missing from the next one (an
option FFmpeg removed, a library that dropped a platform) stops `update` and `build` until it is
removed from the profile or the removal is approved in the PR.

## The engine

`engine` in the lock moves within the same major (1.x). 2.0 is reported with what changed in the
profile format; never applied automatically.
