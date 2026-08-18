#!/usr/bin/env bash
# Fast multi-thread file download via aria2.
# Usage: dl-file.sh URL [OUTPUT_PATH]
#   OUTPUT_PATH: full path or directory (default: current dir, auto-detect filename)
set -e

URL="${1:?Usage: dl-file.sh URL [OUTPUT_PATH]}"
OUTPUT="${2:-}"

ARGS=(
    -x16        # 16 connections per server
    -s16        # 16 splits
    -k1M        # 1MB minimum split size
    --max-tries=3
    --retry-wait=3
    --continue=true
    --auto-file-renaming=false
    --console-log-level=notice
)

if [[ -n "$OUTPUT" ]]; then
    if [[ -d "$OUTPUT" ]]; then
        ARGS+=(-d "$OUTPUT")
    else
        ARGS+=(-d "$(dirname "$OUTPUT")" -o "$(basename "$OUTPUT")")
    fi
fi

aria2c "${ARGS[@]}" "$URL"
