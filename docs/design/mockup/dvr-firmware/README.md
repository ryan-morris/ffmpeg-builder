# dvr-firmware (a product)

Uses a **published** FFmpeg build; never builds FFmpeg, so its CI never waits on one.

```
dvr-firmware/
├── ffmpeg.version                    # one line: the release this product uses
└── .github/workflows/
    ├── ci.yml                        # fetches that build (seconds), then builds + tests the product
    └── ffmpeg-update.yml             # nightly: newer dvr-* release? -> PR bumping ffmpeg.version
```

When `company-ffmpeg` publishes `dvr-9.0.3.0`, `ffmpeg-update.yml` opens a PR here; this
product's own tests decide whether it merges. Each product moves on its own schedule.
