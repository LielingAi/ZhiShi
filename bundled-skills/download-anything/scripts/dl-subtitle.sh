#!/usr/bin/env bash
# Download subtitles for a video.
# Usage: dl-subtitle.sh VIDEO_URL_OR_QUERY [LANG] [OUTPUT_DIR]
#   LANG: en (default), zh, ja, ko, etc. Use comma-separated for multiple: "en,zh"
#   For URLs: downloads embedded subtitles via yt-dlp
#   For search queries: searches OpenSubtitles/SubDL (requires manual step)
set -e

INPUT="${1:?Usage: dl-subtitle.sh VIDEO_URL_OR_QUERY [LANG] [OUTPUT_DIR]}"
LANG="${2:-en}"
OUTPUT_DIR="${3:-.}"

mkdir -p "$OUTPUT_DIR"

# If input looks like a URL, use yt-dlp
if [[ "$INPUT" =~ ^https?:// ]]; then
    echo "→ Downloading subtitles from URL via yt-dlp..."
    yt-dlp \
        --write-subs \
        --write-auto-subs \
        --sub-langs "$LANG" \
        --sub-format "srt/ass/vtt" \
        --skip-download \
        -o "$OUTPUT_DIR/%(title)s.%(ext)s" \
        "$INPUT"
    echo "✓ Subtitles saved to $OUTPUT_DIR"
else
    # For search queries, provide guidance
    echo "→ Search for subtitles manually:"
    echo "  SubDL:          https://subdl.com/search?query=$(echo "$INPUT" | sed 's/ /+/g')"
    echo "  OpenSubtitles:  https://www.opensubtitles.com/en/search-all/q-$(echo "$INPUT" | sed 's/ /-/g')"
    echo "  射手网(中文):    https://assrt.net/sub/?searchword=$(echo "$INPUT" | sed 's/ /+/g')"
    echo "  字幕库:          https://zimuku.org/search?q=$(echo "$INPUT" | sed 's/ /+/g')"
fi
