# Contributing

Thanks for helping. Issues and pull requests are welcome; for anything large (a new platform, a change to the
`ffmpeg-build.yml` format), open an issue first so the design can be agreed before the work.

## Setup

    npm ci
    npm test                                                        # vitest; the Docker test is skipped by default
    npx tsc -p tsconfig.json --noUnusedLocals --noUnusedParameters  # must be clean
    npm run dev -- <command>                                        # the CLI from source (Node 24 runs the .ts directly)

`FFMPEG_BUILD_DOCKER_TESTS=1 npx vitest run tests/build-docker.test.ts` runs a real linux-x64 build (slow; needs
Docker and network). `npm run schema` regenerates `schema/ffmpeg-build.schema.json` after a schema change (a test
fails when it is stale).

## How the engine is laid out

| Path | What it is |
|---|---|
| `src/` | the CLI (TypeScript, run directly by Node 24; `npm run build` compiles it to `dist/` for npm) |
| `ffmpeg/<major>.yml` | what each FFmpeg major offers: options, the library each needs, its license class, platforms |
| `recipes/<name>/` | how to build one library: `recipe.yml` (source, versions, licence, `license-files:`, deps) and `build.sh` |
| `platforms.yml`, `platforms/` | each platform's image, setup script, configure flags and CI runner; `driver.sh` runs a build |
| `images/` | the toolchain Dockerfiles (base images pinned by digest, downloads by sha256) |
| `licenses.yml` | which build licenses each SPDX licence may go into |
| `profiles/devenvy.yml` | the shipped targets that `init` starts from |
| `scripts/compare-published*.sh` | compare a build with a published devenvy/ffmpeg archive |
| `docs/` | the user documentation (targets, building, releases) |

## What CI checks

- **Every push and pull request** (`ci.yml`): types, the test suite, shellcheck over every recipe and platform script,
  and actionlint over the workflows.
- **A change to a recipe** (`recipes.yml`): that library, and what it builds against (not FFmpeg), is built on every
  target in `examples/canary` that uses it, at the canary lock's versions (`ffmpeg-build build --target T --only R`).
  The canary's targets between them build every recipe.
- **A change to a toolchain** (platform scripts, images): the small targets in `examples/test-builds` build in full,
  on every kind of runner.
- **Every week** (`canary.yml`): the canary lock moves to the newest upstream versions, in the run only, and every
  canary target builds in full. A failure there is a new upstream release that broke a recipe, found before any
  consumer's update PR meets it.
- **Every night** (`ffmpeg-support.yml`): `scripts/ffmpeg-support.ts` keeps `ffmpeg/<major>.yml`'s releases equal to
  FFmpeg's tags and reports what a new release's configure adds, drops or reclassifies. When `ffmpeg/` changed it
  opens or refreshes one pull request on `ffmpeg-build/ffmpeg-support`. Its CI starts without any token: a push made
  with `GITHUB_TOKEN` starts no workflows, so the workflow then dispatches `ci.yml` on the branch (`actions: write`;
  `ci.yml` has `workflow_dispatch:`). A `SUPPORT_TOKEN` secret is optional (a fine-grained token with contents and
  pull-requests write): it is used instead, and its push starts CI by itself. `test-update.yml` and
  `test-fetch-update.yml` dispatch `ci.yml` the same way.

## Changes that need more than tests

- **A recipe or platform change** should be built for real (`ffmpeg-build build --target ...`) and, where a published
  counterpart exists, compared with it (`scripts/compare-published*.sh`). Say in the pull request what you built and
  paste the comparison's last lines. A difference you mean to keep goes in the matching `*.expected` file, with its
  reason.
- **A new library** needs its recipe's `license-files:` (the licence texts in its source, which `THIRD-PARTY-NOTICES.txt` carries) and its
  SPDX licence in `recipe.yml`; `check` and the licence table do the rest.
- **An image** (a Dockerfile's `FROM`, a container a workflow runs) is pinned by digest and never pulled from Docker
  Hub directly: CI runners share addresses and hit its anonymous pull limit. Use Docker Hub images through
  `mirror.gcr.io` (`mirror.gcr.io/library/alpine:...@sha256:...`); `tests/image-registry.test.ts` checks.
- **The `ffmpeg-build.yml` format** is a public interface: describe the change in an issue first, and give it a
  `migrate` path if existing folders would break.

## Style

Match the code around you: plain names, comments that say why, messages that tell the user what to do next. Commit
messages say what changed and why in the first line.
