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

## Changes that need more than tests

- **A recipe or platform change** should be built for real (`ffmpeg-build build --target ...`) and, where a published
  counterpart exists, compared with it (`scripts/compare-published*.sh`). Say in the pull request what you built and
  paste the comparison's last lines. A difference you mean to keep goes in the matching `*.expected` file, with its
  reason.
- **A new library** needs its recipe's `license-files:` (the licence texts in its source, which `THIRD-PARTY-NOTICES.txt` carries) and its
  SPDX licence in `recipe.yml`; `check` and the licence table do the rest.
- **The `ffmpeg-build.yml` format** is a public interface: describe the change in an issue first, and give it a
  `migrate` path if existing folders would break.

## Style

Match the code around you: plain names, comments that say why, messages that tell the user what to do next. Commit
messages say what changed and why in the first line.
