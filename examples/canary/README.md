# Canary

The engine's own check against upstream: the shipped lgplv3, gplv3 and gplv2 targets for linux-x64 and win-x64,
which between them build every recipe the engine has. (Platform-specific pieces, Android's and Apple's setup and
packaging, are covered by the test-builds targets.)

- `.github/workflows/recipes.yml` builds a changed recipe (and what it builds against, not FFmpeg) on each canary
  target that uses it, at this lock's versions.
- `.github/workflows/canary.yml` moves this lock to the newest upstream versions every week, in the run only, and
  builds every target in full.
