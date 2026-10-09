# devenvy-ffmpeg

Our OSS FFmpeg builds. What this repo becomes once the engine moves out: no scripts, no recipes.

```
devenvy-ffmpeg/
├── ffmpeg.yml            # everything we publish
├── ffmpeg.lock           # exact versions; written only by `ffmpeg-build update`
└── .github/workflows/
    ├── release.yml       # daily release train
    └── update.yml        # daily lock update -> PR -> merges itself when CI is green
```

One profile covers all of today's lines and variants: lists for `ffmpeg` and `license` expand into
variants (2 majors x 4 licenses, every platform). Asset names are exactly today's:
`ffmpeg-9.0.2-linux-x64-gplv3.tar.gz`, `...-dev.tar.gz`; tags `9.0.2.7`.
