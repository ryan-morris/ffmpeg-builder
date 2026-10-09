# A product that uses a published build

`ffmpeg.version` pins a release, `owner/repo@tag`. A product's CI takes the build it needs:

    ffmpeg-build fetch ffmpeg.version --target linux-x64-lgplv3 --dev --out vendor/ffmpeg

and `ffmpeg-build fetch --update ffmpeg.version --target linux-x64-lgplv3` (or the fetch-update workflow) moves the pin
to the newest release of the same FFmpeg major. This one pins the engine's own test release.
