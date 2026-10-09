#!/usr/bin/env bash
# Run by `ffmpeg-build test` with $FFMPEG pointing at the build under test.
set -euo pipefail
"$FFMPEG" -f lavfi -i testsrc=duration=2 -c:v mpeg4 -f acme out.acme
"$FFMPEG" -i out.acme -f null -
