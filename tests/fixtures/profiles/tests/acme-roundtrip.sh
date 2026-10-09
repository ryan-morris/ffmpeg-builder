#!/usr/bin/env bash
# the dvr fixture's test: ffmpeg-build test runs it with FFMPEG set to the build's ffmpeg
set -euo pipefail
"${FFMPEG}" -hide_banner -version >/dev/null
