# company-ffmpeg (private)

Internal FFmpeg builds: one profile per product, plus proprietary patches, internal-use license.
Uses the same public engine as our OSS builds, so there is no build logic here to keep in sync -
moving to a new engine release is one line in the lock, done by `ffmpeg-build update`.

Products never build FFmpeg; they pin a release published from here.

```
company-ffmpeg/
├── dvr.yml                       # DVR recorder
├── playback.yml                  # playback app
├── patches/
│   └── acme-muxer/               # proprietary muxer + demuxer
│       ├── about.yml
│       └── 9/
│           ├── 0001-avformat-add-ACME-muxer.patch
│           └── 0002-avformat-add-ACME-demuxer.patch
├── tests/
│   └── acme-roundtrip.sh         # mux -> demux -> compare; run by `ffmpeg-build test`
├── ffmpeg.lock                   # exact versions for both profiles; written only by the CLI
└── .github/workflows/
    ├── release.yml               # build + publish a profile when its lock or patches change
    └── update.yml                # nightly `ffmpeg-build update` -> PR; a person merges
```

Releases are per profile: `dvr-9.0.2.3`, `playback-9.0.2.3`, each with its assets
(`ffmpeg-9.0.2-linux-arm64-dvr.tar.gz`), `SHA256SUMS`, `manifest.yml` and the source bundle
(`ffmpeg-9.0.2-dvr-sources.tar.gz`) owed to anyone the binaries are given to.
