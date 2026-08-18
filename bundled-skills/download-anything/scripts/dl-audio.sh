#!/usr/bin/env bash
# Extract audio from a URL.
# Usage: dl-audio.sh URL [FORMAT] [OUTPUT_DIR]
#   FORMAT: mp3 (default), opus, flac, wav, best
#   OUTPUT_DIR: directory to save to (default: current dir)
set -e

URL="${1:?Usage: dl-audio.sh URL [FORMAT] [OUTPUT_DIR]}"
FORMAT="${2:-mp3}"
OUTPUT_DIR="${3:-.}"

mkdir -p "$OUTPUT_DIR"

yt-dlp \
    -x \
    --audio-format "$FORMAT" \
    --audio-quality 0 \
    --embed-metadata \
    --embed-thumbnail \
    -o "$OUTPUT_DIR/%(title)s.%(ext)s" \
    "$URL"
