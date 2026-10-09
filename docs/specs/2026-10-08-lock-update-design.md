# `lock`, `outdated`, `update`: design

Handoff step 2. Builds on the `check` / `plan` skeleton (handoff step 1).
Spec sources: `docs/design/handoff.md` §2 "Versions and updates", `docs/design/mockup/examples/update-rules.md`,
`outdated.txt`, `update-pr.md`, and the mockup's `ffmpeg.lock` files.

## Decisions taken with the owner

- **FFmpeg versions come from FFmpeg upstream**, read from its git tags exactly like a library. The engine's
  `ffmpeg/<major>.yml` only says which options a major offers. If upstream ships a release the nightly data
  doesn't list yet, `check` judges it with the data it has. The only effect is that options new in that
  release aren't offered until the next nightly run.
- **The CLI never opens PRs.** `update` rewrites `ffmpeg.lock` and, with `--summary <file>`, writes the PR text.
  The reusable `update.yml` workflow (handoff step 6) opens the PR. The CLI needs no GitHub credentials.
- **Conditional pins are recorded in the lock with the same condition as the profile entry** (see "Lock file").
- **Pins use npm's range syntax**, matched by our own code because library versions are not semver:
  nv-codec has four parts, x265 two.

## 1. Where versions come from

A recipe's `versions:` key holds exactly one of:

| Key | Meaning | Example |
|---|---|---|
| `git-tags: '<regex>'` | tags of the recipe's `source.git` repo; group 1 of the regex is the version | `'^openssl-(3\.5\.\d+)$'` |
| `repo: <git url>` | with `git-tags` / `git-branch`: where to read them when `source` is a download, not a git repo | mbedtls |
| `listing: <url>` + `files: '<regex>'` | a release page; group 1 of `files` matched against every link target on the page | GNU, SourceForge |
| `git-branch: <name>` | no releases: the version is the branch's head commit | x264 `stable`, Vulkan shim `master` |

- Tags are read with `git ls-remote --tags <url>`, and branches with `git ls-remote --heads <url> <name>`. This
  works for GitHub, GitLab, googlesource and any other git host, with no API and no tokens. Peeled tag lines
  (`^{}`) are ignored.
- A listing page is fetched with Node's `fetch`. Every `href="..."` value is taken, reduced to its last path
  segment (a trailing `/` is dropped, so SourceForge folder listings work), and matched with `files`.
- A version must be dotted numbers (`1.5.4`, `13.0.19.1`, `4.3`) after the regex. Anything else is skipped,
  so a recipe's regex is where pre-releases are kept out. A branch head's version is the full commit hash.
- FFmpeg itself: `ffmpeg/source.yml` (engine data) holds `git:` and `versions: { git-tags: '^n(\d+\.\d+(?:\.\d+)?)$' }`.
  Being data, tests point it at a local repo.
- The recipe schema changes from "any keys" to exactly these shapes, checked when engine data loads.

## 2. Pin syntax (npm's, our own matching)

| Pin | Means |
|---|---|
| `"4.3.1"` | exactly 4.3.1 (the parts written must match, so for a four-part library it means 4.3.1.x) |
| `"4.3"` | any 4.3.x (npm's x-range) |
| `"13"` | any 13.x |
| `"~1.5.4"` | ≥ 1.5.4, same 1.5 |
| `"^1.5.4"` | ≥ 1.5.4, same first non-zero part (npm's rule: `^0.17.2` stays on 0.17) |
| `">=3.6 <4"`, `">1.2"`, `"<=2"` | comparisons; space-separated parts all apply (AND) |
| `"4.3 \|\| 4.5"` | either side (OR) |

- Versions compare as dotted numbers of any length; missing parts count as 0 (`13.0` = `13.0.0.0`).
- An x-range compares only the parts given: `"13.0"` matches `13.0.19.1`.
- A pin on a `git-branch` library is a full 40-character commit hash and matches only that commit
  (`git ls-remote` can't expand a short one).
- `check` rejects a pin that isn't valid range syntax (replacing today's "is a version" check), with a message
  listing the forms above.

## 3. Choosing versions

For each profile, independently:

**FFmpeg**, per entry in `ffmpeg:`:
- `9` → newest upstream 9.x; `9.0` → newest 9.0.x.
- `latest` → newest upstream release of the newest major the engine has `ffmpeg/<major>.yml` for. It moves to a
  newer major only when every `with:` entry that is available on the current major (judged on the builds its own
  condition covers) is still available on the new one; otherwise it stays and the reason is reported. The
  update rules' patch-folder and license conditions arrive with patches and licenses (handoff step 4).
- A new minor is called out with the options it adds (those whose `since` falls in it).
- A newer major than the profile allows is reported, never applied.

**Libraries**: the set is every recipe any build of the profile uses, dependencies included (the union of
`plan`'s library lists). For each library:
- candidates = upstream versions, minus those below FFmpeg's `min:` for an option that uses this library in a
  build of a series where that `min:` applies;
- the version under `libraries:` is the newest candidate that satisfies the profile's unconditional pin, if any;
- each conditional pin entry that wins in at least one build gets its own newest matching candidate, recorded
  under `pinned:` with the entry's condition;
- no candidate at all is an error naming the library, the pin and the newest upstream version.

The newest version that is not taken is reported with the reason: outside the pin, or a newer FFmpeg major
than the profile allows (one line per library or FFmpeg series, as in the mockup's `outdated.txt`). Each line carries the recipe's `notes` for that version line (e.g. "needs NVIDIA driver 610+").
The `notes` key is matched as an x-range (`"13.1"` matches `13.1.15.0`).

## 4. Commands

- **`outdated [profiles...]`**: read-only. Per profile, one row per FFmpeg series and library: locked version →
  newest allowed ("up to date" when equal), plus the "exists but not taken" lines. The shape follows
  `docs/design/mockup/examples/outdated.txt`. Without a lock, "locked" shows `-`. Exit 0.
- **`update [profiles...] [--summary <file>]`**: moves every FFmpeg series and library to the newest allowed
  version and rewrites `ffmpeg.lock`. Profiles not named keep their lock entries. `--summary` writes the PR text in
  the shape of `docs/design/mockup/examples/update-pr.md`: the new-minor callout, a from/to table per profile, and
  "Not applied". The "Nothing removed" section waits for the removal guard (later step). Exit 0 whether or not
  anything changed; the workflow checks the diff.
- **`lock [profiles...]`**: keeps every locked version that is still allowed. It resolves only what's missing
  (new profile, new library) or no longer allowed (pin changed), and drops entries no build uses. No network
  access when nothing needs resolving.
- **`check` / `plan`** read `ffmpeg.lock` when it is next to the profiles:
  - `check` reports `✗ ffmpeg.lock doesn't match this profile; run ffmpeg-build lock` when the lock lacks
    something a build uses or holds a version the profile no longer allows.
  - `plan` shows `name version` in its libraries line and the exact FFmpeg version in its header.
  - With no lock, both behave as today.
- `outdated`, `update` and `lock` run `check` first and stop on any problem, as `plan` does.

## 5. Lock file

```yaml
# ffmpeg.lock - written only by `ffmpeg-build update` / `ffmpeg-build lock`. Do not edit.
engine: 0.2.0
profiles:
  playback:
    ffmpeg: { "8": 8.1.3, "9": 9.0.2 }
    libraries:
      dav1d: 1.5.4
      libplacebo: 7.360.1
      nv-codec: 13.0.19.1
    pinned:
      - libplacebo: { version: 7.349.0, platforms: [win-arm64] }
```

- One `ffmpeg.lock` per folder; profiles keyed by `name`.
- `lock`/`update` with profile arguments touch only those profiles' entries. Run with no arguments (the whole
  folder), they also drop entries whose profile no longer exists (renamed or deleted).
- `ffmpeg:` is keyed by the series as written in the profile (`"9"`, `"9.0"`, `"latest"`).
- `libraries:` is sorted by name. `pinned:` keeps the profile's pin order.
- `engine:` is the version of the CLI that wrote the file.
- The file is read with the strings-only YAML loader and validated like every other file. A hand-edited, broken
  lock gives a plain error naming the line.
- Written with a fixed layout so diffs only show real changes.
- Toolchain image digests (`images:`) and patch hashes come with `build` and patches (later steps).

## 6. Failures

- Each upstream request is retried twice with a short backoff (DNS and TLS blips were a real problem upstream).
- If any upstream still fails, nothing is written. The message names the library, the URL and the error. Exit 2.
- `git` not installed: "ffmpeg-build needs git to read upstream versions", exit 2.
- Upstream requests run up to 8 at a time.
- A regex that matches nothing upstream is an error naming the recipe ("no versions found at <url> matching
  <regex>"), because it almost always means upstream renamed its tags.

## 7. Testing

Offline and real, with no mocks of git or HTTP:
- tests create bare git repos with tags and branches in a temp folder and point fixture recipes at them with
  `file://` URLs;
- a local `node:http` server serves listing pages (GNU style and SourceForge folder style);
- pure parts (range matching, choosing versions, lock read/write) have table tests.

## Not in this step

- `images:` digests (step 3, `build`), patch hashes, the "Nothing removed" guard (needs the published manifest).
- Detecting a library changing its license between versions.
- The engine checking npm for a newer CLI. The workflow runs `npx ffmpeg-build@<major>`, so the lock's `engine:`
  simply records what wrote it.
