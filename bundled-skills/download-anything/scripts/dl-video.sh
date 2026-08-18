#!/usr/bin/env bash
# Download video from URL.
# Usage: dl-video.sh URL [QUALITY] [OUTPUT_DIR]
#   QUALITY: best (default), 2160, 1080, 720, 480
#   OUTPUT_DIR: directory to save to (default: current dir)
#   Output: MP4 (H.264/H.265 + AAC) for maximum compatibility
#   Auto-detects Bilibili and uses browser cookies when needed.
set -e

URL="${1:?Usage: dl-video.sh URL [QUALITY] [OUTPUT_DIR]}"
QUALITY="${2:-best}"
OUTPUT_DIR="${3:-.}"

mkdir -p "$OUTPUT_DIR"

# Prefer H.264/H.265 video + AAC audio for universal playback (QuickTime, iOS, browsers).
# AV1/VP9/Opus won't play on macOS QuickTime. Fallback to any format if preferred codecs unavailable.
case "$QUALITY" in
    best)   FORMAT="bv[vcodec~='^(avc|hev)'][ext=mp4]+ba[acodec~='^(mp4a)'][ext=m4a]/bv[ext=mp4]+ba[ext=m4a]/bv*+ba/b" ;;
    2160)   FORMAT="bv[height<=2160][vcodec~='^(avc|hev)'][ext=mp4]+ba[acodec~='^(mp4a)'][ext=m4a]/bv[height<=2160][ext=mp4]+ba[ext=m4a]/bv[height<=2160]+ba/b" ;;
    1080)   FORMAT="bv[height<=1080][vcodec~='^(avc|hev)'][ext=mp4]+ba[acodec~='^(mp4a)'][ext=m4a]/bv[height<=1080][ext=mp4]+ba[ext=m4a]/bv[height<=1080]+ba/b" ;;
    720)    FORMAT="bv[height<=720][vcodec~='^(avc|hev)'][ext=mp4]+ba[acodec~='^(mp4a)'][ext=m4a]/bv[height<=720][ext=mp4]+ba[ext=m4a]/bv[height<=720]+ba/b" ;;
    480)    FORMAT="bv[height<=480][vcodec~='^(avc|hev)'][ext=mp4]+ba[acodec~='^(mp4a)'][ext=m4a]/bv[height<=480][ext=mp4]+ba[ext=m4a]/bv[height<=480]+ba/b" ;;
    *)      FORMAT="$QUALITY" ;;  # allow raw format string
esac

EXTRA_ARGS=()

# Auto-detect sites that require browser cookies
if [[ "$URL" =~ bilibili\.com|b23\.tv ]]; then
    # Bilibili returns HTTP 412 without cookies. Try Chrome first, then Firefox.
    for browser in chrome firefox edge; do
        if yt-dlp --cookies-from-browser "$browser" -j "$URL" &>/dev/null; then
            EXTRA_ARGS+=(--cookies-from-browser "$browser")
            break
        fi
    done
    if [[ ${#EXTRA_ARGS[@]} -eq 0 ]]; then
        echo "⚠ Bilibili requires login cookies. Log in via Chrome/Firefox first." >&2
        echo "  Or export cookies: yt-dlp --cookies cookies.txt ..." >&2
    fi
fi

yt-dlp \
    -f "$FORMAT" \
    --merge-output-format mp4 \
    --embed-metadata \
    --embed-thumbnail \
    --write-subs --sub-langs "en,zh" \
    "${EXTRA_ARGS[@]}" \
    -o "$OUTPUT_DIR/%(title)s.%(ext)s" \
    "$URL"
