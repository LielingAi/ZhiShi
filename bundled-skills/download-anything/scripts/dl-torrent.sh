#!/usr/bin/env bash
# Download from a torrent file or magnet link via aria2.
# Usage: dl-torrent.sh MAGNET_OR_TORRENT [OUTPUT_DIR]
set -e

INPUT="${1:?Usage: dl-torrent.sh MAGNET_OR_TORRENT [OUTPUT_DIR]}"
OUTPUT_DIR="${2:-.}"

mkdir -p "$OUTPUT_DIR"

aria2c \
    -d "$OUTPUT_DIR" \
    --seed-time=0 \
    --max-connection-per-server=16 \
    --split=16 \
    --bt-max-peers=100 \
    --bt-tracker-connect-timeout=10 \
    --bt-tracker-timeout=10 \
    --console-log-level=notice \
    "$INPUT"
