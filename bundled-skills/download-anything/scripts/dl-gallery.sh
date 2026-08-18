#!/usr/bin/env bash
# Batch download images/media from a gallery URL.
# Usage: dl-gallery.sh URL [OUTPUT_DIR] [EXTRA_ARGS...]
#   Supports 170+ sites: Pixiv, Twitter, Reddit, Instagram, DeviantArt, Danbooru, etc.
#   Extra args are passed through to gallery-dl (e.g. --range 1-5, --filter, --write-metadata)
set -e

URL="${1:?Usage: dl-gallery.sh URL [OUTPUT_DIR] [EXTRA_ARGS...]}"
OUTPUT_DIR="${2:-./gallery-dl}"
shift 2 2>/dev/null || shift $#

mkdir -p "$OUTPUT_DIR"

gallery-dl \
    -d "$OUTPUT_DIR" \
    "$@" \
    "$URL"
