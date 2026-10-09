#!/usr/bin/env bash
# Headers only: install them where FFmpeg's configure finds them.
set -euo pipefail
make -C "${SRC_DIR}" PREFIX="${DEPS_DIR}" install
