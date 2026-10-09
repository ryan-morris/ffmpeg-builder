# ffmpeg-build

Build FFmpeg your way - which version, which platforms, which license, which libraries, plus your
own patches - from one short profile, reproducibly, with the source bundle that licensing needs.

```
ffmpeg-build/
├── cli/                          # the CLI (Node/TypeScript; npm: ffmpeg-build)
│   └── src/commands/
│       ├── check.ts              #   is the profile possible? (offline)
│       ├── plan.ts               #   what would be built, per FFmpeg version x platform
│       ├── lock.ts               #   resolve the profile into ffmpeg.lock
│       ├── outdated.ts           #   what is newer upstream (read-only)
│       ├── update.ts             #   move the lock forward, following the update rules
│       ├── build.ts              #   build one platform (used locally and by CI)
│       ├── dev.ts                #   one-platform workspace for developing patches
│       ├── test.ts               #   smoke tests + the profile's own tests
│       ├── bundle.ts             #   source bundle + manifest + release notes
│       ├── patches.ts            #   `patches export`: dev workspace commits -> patch files
│       └── fetch.ts              #   download a published build (products); --update bumps a pin
├── recipes/                      # one folder per library: recipe.yml (facts) + build.sh (how)
│   ├── x265/  nv-codec/  srt/
│   ├── openssl/  gnutls/  mbedtls/   # TLS backends are ordinary recipes (group: tls)
│   └── ... (moved from today's scripts/deps/)
├── ffmpeg/                       # GENERATED nightly from every FFmpeg release's configure
│   ├── 8.yml
│   └── 9.yml                     #   incl. built-ins like schannel / securetransport
├── platforms/                    # per-platform toolchain setup (today's scripts/platform/)
├── images/                       # Dockerfiles: linux, linux-musl, mingw, android toolchain images
├── schema/profile.schema.yml     # profile validation + editor autocomplete
├── templates/recipe/             # scaffolds for a new library (cmake / meson / autotools)
└── .github/workflows/
    ├── ffmpeg-support.yml        # nightly: regenerate ffmpeg/*.yml; PR if anything differs
    ├── ci.yml                    # engine tests + one small reference build per platform family
    ├── release.yml               # CLI release (semver) + toolchain images
    ├── build.yml                 # REUSABLE: what consumers call to build + publish a profile
    ├── update.yml                # REUSABLE: what consumers call to keep ffmpeg.lock current
    └── fetch-update.yml          # REUSABLE: what products call to bump their pinned build
```

## What the engine owns, and what it doesn't

| Owns | Does not own |
|---|---|
| how to build each library (recipes) | which version anyone uses (each repo's `ffmpeg.lock`) |
| where each library's versions come from (`versions:` in the recipe) | watching library releases (each repo's `update` asks upstream) |
| what each FFmpeg version offers (generated `ffmpeg/*.yml`) | anyone's published binaries |
| facts about each library: license, platforms, group, preference | anyone's patches |

There is no special mechanism for anything. TLS, for example: OpenSSL, GnuTLS and mbedTLS are
recipes; SChannel and Apple's TLS are FFmpeg built-ins. They share `group: tls` (FFmpeg uses one
per build), and `prefer` decides which `start: everything` picks per platform. License facts
do the rest: OpenSSL is Apache-2.0, so v2 builds get GnuTLS on Linux/Android. A profile changes
it with the usual `with` / `without` and a `platforms:` condition.

## Maintenance

- **FFmpeg releases:** automatic. `ffmpeg-support.yml` regenerates `ffmpeg/*.yml` from scratch every
  night for every release of the majors we handle. No difference: nothing happens. Differences that
  are pure data merge themselves; a new external library opens a PR with a recipe scaffold.
- **Library releases:** nothing to do. Consumers pick them up; a recipe needs a fix only when a new
  version fails to build somewhere (the consumer pins the old version meanwhile).
- **Hosts:** see [`../examples/hosts.md`](../examples/hosts.md).
