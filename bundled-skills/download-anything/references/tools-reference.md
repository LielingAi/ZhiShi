# CLI Tools Reference

## Table of Contents
- [yt-dlp](#yt-dlp)
- [gallery-dl](#gallery-dl)
- [aria2](#aria2)
- [curl](#curl)
- [wget](#wget)
- [cobalt API](#cobalt-api)
- [Companion Tools](#companion-tools)
- [Tool Selection Guide](#tool-selection-guide)
- [Quick Install](#quick-install)

---

## yt-dlp

Video/audio downloader supporting 1800+ sites. **The most important tool in the stack.**

| | |
|---|---|
| Install | `brew install yt-dlp` (also needs `brew install ffmpeg`) |
| Config | `~/.config/yt-dlp/config` |

### Essential Commands

```bash
# List formats (ALWAYS do this first for quality control)
yt-dlp -F "URL"

# Best 1080p
yt-dlp -f "bv[height<=1080]+ba/b[height<=1080]" "URL"

# Specific format by ID (from -F output)
yt-dlp -f 137+140 "URL"

# Audio only → MP3
yt-dlp -x --audio-format mp3 --audio-quality 0 "URL"

# Audio only → keep original format (best quality)
yt-dlp -x "URL"

# With subtitles
yt-dlp --write-subs --sub-lang en,zh --embed-subs "URL"

# All subtitles
yt-dlp --write-subs --all-subs "URL"

# Embed metadata + thumbnail
yt-dlp --embed-metadata --embed-thumbnail "URL"

# Download thumbnail only
yt-dlp --write-thumbnail --skip-download "URL"
```

### Playlist & Batch

```bash
# Full playlist
yt-dlp --yes-playlist "PLAYLIST_URL"

# Playlist range
yt-dlp --playlist-items 1,3,5-7 "PLAYLIST_URL"

# Entire channel
yt-dlp "https://www.youtube.com/@CHANNEL"

# Batch from file
yt-dlp -a urls.txt

# Skip already downloaded
yt-dlp --download-archive archive.txt "URL"
```

### Auth & Network

```bash
# Cookies from browser (easiest auth)
yt-dlp --cookies-from-browser chrome "URL"
yt-dlp --cookies-from-browser firefox "URL"

# Cookies file
yt-dlp --cookies cookies.txt "URL"

# Proxy
yt-dlp --proxy socks5://127.0.0.1:1080 "URL"

# Geo-bypass
yt-dlp --geo-bypass-country US "URL"

# Rate limit
yt-dlp --limit-rate 5M "URL"

# Resume
yt-dlp --no-overwrites -c "URL"
```

### Agent Automation Flags

```bash
# Get metadata as JSON (no download) -- CRITICAL for agent use
yt-dlp -j --no-download "URL"

# Get direct download URL only (pipe to aria2/curl)
yt-dlp -g "URL"

# Output template
yt-dlp -o "%(title)s.%(ext)s" "URL"
yt-dlp -o "%(uploader)s/%(title)s.%(ext)s" "URL"
yt-dlp -o "%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s" "URL"
```

### Config File (`~/.config/yt-dlp/config`)

```
-f bestvideo[height<=1080]+bestaudio/best[height<=1080]
-o %(title)s.%(ext)s
--embed-metadata
--embed-thumbnail
--download-archive ~/.config/yt-dlp/archive.txt
```

---

## gallery-dl

Image gallery downloader. 170+ sites (Pixiv, Twitter/X, Reddit, Instagram, Danbooru, ArtStation, Flickr, etc.).

| | |
|---|---|
| Install | `brew install gallery-dl` or `pip install gallery-dl` |
| Config | `~/.config/gallery-dl/config.json` |

### Essential Commands

```bash
# Basic download
gallery-dl "URL"

# To specific directory
gallery-dl -d ./downloads "URL"

# Custom filename
gallery-dl -f "{category}_{id}_{num}.{extension}" "URL"

# With authentication
gallery-dl --cookies-from-browser firefox "URL"

# Download range
gallery-dl --range 1-50 "URL"

# Filter by dimensions
gallery-dl --filter "width >= 1920 and height >= 1080" "URL"

# Filter by engagement
gallery-dl --filter "likes >= 100" "URL"

# Filter by date
gallery-dl --filter "date >= datetime(2024,1,1)" "URL"

# Proxy
gallery-dl --proxy socks5://127.0.0.1:1080 "URL"

# Batch from file
gallery-dl -i urls.txt
```

### Agent Automation Flags

```bash
# Get URLs only (no download) -- pipe to aria2
gallery-dl -g "URL"

# Dump JSON metadata (no download)
gallery-dl -j "URL"

# List supported extractors
gallery-dl --list-modules
```

### OAuth Setup (one-time)

```bash
gallery-dl oauth:reddit
gallery-dl oauth:deviantart
gallery-dl oauth:flickr
gallery-dl oauth:tumblr
```

### Config File (`~/.config/gallery-dl/config.json`)

```json
{
    "extractor": {
        "base-directory": "~/Downloads/gallery-dl/",
        "twitter": {
            "cookies-from-browser": ["firefox"],
            "text-tweets": false,
            "retweets": false
        },
        "reddit": {
            "comments": 0,
            "morecomments": false
        }
    },
    "downloader": {
        "rate": "2M",
        "retries": 3
    }
}
```

---

## aria2

Multi-connection download accelerator. Handles HTTP, FTP, BitTorrent, Metalink. **Best for large files and torrents.**

| | |
|---|---|
| Install | `brew install aria2` |

### Essential Commands

```bash
# Fast download (16 connections)
aria2c -x 16 -s 16 "URL"

# To specific directory
aria2c -d ~/Downloads "URL"

# Custom filename
aria2c -o output.zip "URL"

# Resume
aria2c -c "URL"

# Multiple mirrors
aria2c "https://mirror1.com/file.iso" "https://mirror2.com/file.iso"

# Custom headers
aria2c --header="Authorization: Bearer TOKEN" "URL"
aria2c --header="Referer: https://source.com" "URL"

# Batch from file
aria2c -i urls.txt

# Speed limit
aria2c --max-download-limit=5M "URL"

# Proxy
aria2c --all-proxy=socks5://127.0.0.1:1080 "URL"

# macOS: skip pre-allocation for speed
aria2c --file-allocation=none "URL"
```

### BitTorrent

```bash
# Magnet link
aria2c "magnet:?xt=urn:btih:HASH"

# Torrent file
aria2c file.torrent

# No seeding after complete
aria2c --seed-ratio=0.0 "magnet:?xt=..."

# Select specific files
aria2c --select-file=1,3,5 file.torrent

# Limit upload
aria2c --max-upload-limit=1M "magnet:?xt=..."
```

### JSON-RPC Daemon (Agent Automation)

```bash
# Start daemon
aria2c --daemon --enable-rpc --rpc-listen-port=6800

# Full daemon with options
aria2c --enable-rpc --rpc-listen-all=true --rpc-allow-origin-all=true

# Add download via RPC
curl -s http://localhost:6800/jsonrpc \
  -d '{"jsonrpc":"2.0","id":"1","method":"aria2.addUri","params":[["URL"],{"dir":"/tmp/downloads"}]}'

# Check active downloads
curl -s http://localhost:6800/jsonrpc \
  -d '{"jsonrpc":"2.0","id":"2","method":"aria2.tellActive","params":[]}'

# Pause
curl -s http://localhost:6800/jsonrpc \
  -d '{"jsonrpc":"2.0","id":"3","method":"aria2.pause","params":["GID"]}'

# Remove
curl -s http://localhost:6800/jsonrpc \
  -d '{"jsonrpc":"2.0","id":"4","method":"aria2.remove","params":["GID"]}'
```

Python library: `pip install aria2p`

---

## curl

Swiss-army knife for HTTP. Pre-installed on macOS.

### Essential Commands

```bash
# Download (save with remote filename)
curl -O "URL"

# Custom filename
curl -o output.zip "URL"

# Follow redirects (essential!)
curl -L -O "URL"

# Resume
curl -C - -O "URL"

# Custom headers
curl -H "Authorization: Bearer TOKEN" -O "URL"
curl -H "Referer: https://source.com" -O "URL"

# Cookies
curl -b cookies.txt -O "URL"
curl -b "session=abc123" -O "URL"

# Show headers only (check file size/type before download)
curl -I "URL"

# Silent mode
curl -s -O "URL"

# POST JSON (API downloads)
curl -X POST -H "Content-Type: application/json" \
     -d '{"url":"..."}' "https://api.example.com/download"

# Follow redirect and get final URL
curl -Ls -o /dev/null -w '%{url_effective}' "SHORT-URL"

# Proxy
curl -x socks5://127.0.0.1:1080 -O "URL"

# Parse JSON response
curl -s "API_URL" | jq '.items[].url'
```

---

## wget

Best for recursive downloads and site mirroring.

### Essential Commands

```bash
# Basic download
wget "URL"

# To specific directory
wget -P ~/Downloads "URL"

# Custom filename
wget -O output.zip "URL"

# Resume
wget -c "URL"

# Custom headers
wget --header="Authorization: Bearer TOKEN" "URL"

# Batch from file
wget -i urls.txt

# Spider (check URL, no download)
wget --spider "URL"
```

### Recursive Download

```bash
# Mirror entire website
wget --mirror --convert-links --adjust-extension --page-requisites --no-parent "URL"

# Download all PDFs from a page
wget -r -l 1 -A "*.pdf" "URL"

# Download all images
wget -r -l 1 -A "*.jpg,*.png,*.gif,*.webp" "URL"

# Recursive with depth limit
wget -r -l 3 --no-parent "URL"

# Polite crawling (wait between requests)
wget --wait=2 --random-wait -r "URL"
```

---

## cobalt API

Clean social media downloader. YouTube, TikTok, Instagram, Twitter, Reddit, SoundCloud, 30+ sites.

| | |
|---|---|
| Web | cobalt.tools |
| Self-host | Docker (`docker-compose up -d`) |
| Note | Public API has bot protection. Self-host for agent use. |

### API Calls (POST to instance root)

```bash
# Video
curl -X POST "https://YOUR-INSTANCE/" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"url": "VIDEO_URL"}'

# Audio only
curl -X POST "https://YOUR-INSTANCE/" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"url": "URL", "downloadMode": "audio", "audioFormat": "mp3", "audioBitrate": "320"}'

# Specific quality
curl -X POST "https://YOUR-INSTANCE/" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"url": "URL", "videoQuality": "1080"}'
```

### Parameters

| Param | Values | Default |
|-------|--------|---------|
| `url` | string (required) | -- |
| `downloadMode` | `auto` / `audio` / `mute` | `auto` |
| `videoQuality` | `max`/`4320`/`2160`/`1080`/`720`/`480`/`360`/`144` | `1080` |
| `audioFormat` | `best`/`mp3`/`ogg`/`wav`/`opus` | `mp3` |
| `audioBitrate` | `320`/`256`/`128`/`96`/`64`/`8` | `128` |
| `filenameStyle` | `classic`/`pretty`/`basic`/`nerdy` | `basic` |

### Response Types

| Type | Action |
|------|--------|
| `tunnel` | Download from returned `url` |
| `redirect` | Follow redirect URL |
| `picker` | Multiple items -- agent picks |
| `error` | Check error code |

---

## Companion Tools

| Tool | Install | Purpose |
|------|---------|---------|
| **ffmpeg** | `brew install ffmpeg` | Video/audio conversion, merging, extraction |
| **jq** | `brew install jq` | Parse JSON from yt-dlp, curl, APIs |
| **megatools** | `brew install megatools` | Download from MEGA.nz (`megadl "URL"`) |
| **rclone** | `brew install rclone` | Sync Google Drive, OneDrive, S3, etc. |
| **you-get** | `pip install you-get` | Chinese video sites (Youku, iQiyi, Bilibili alt) |
| **streamlink** | `pip install streamlink` | Live stream recording |
| **mediainfo** | `brew install media-info` | Inspect media file metadata |
| **transmission-cli** | `brew install transmission-cli` | Torrent daemon + remote control |
| **webtorrent-cli** | `npm_config_prefix="${ZHISHI_NPM_GLOBAL_PREFIX:-$HOME/.zhishi/npm-global}" npm install -g webtorrent-cli` | Quick torrent download, stream to VLC |
| **spotdl** | `pip install spotdl` | Spotify playlist download |

## Tool Selection Guide

| Scenario | Tool |
|----------|------|
| Video/audio from streaming/social sites | **yt-dlp** |
| Quick social media grab (no setup) | **cobalt** |
| Batch images from galleries | **gallery-dl** |
| Large file (>100MB) | **aria2c** `-x 16 -s 16` |
| Torrent / magnet link | **aria2c** |
| Mirror a website | **wget** `--mirror` |
| Download all PDFs from a page | **wget** `-r -A "*.pdf"` |
| API interaction | **curl** |
| Check URL / file info | **curl** `-I` or **wget** `--spider` |
| Spotify playlists | **spotdl** |
| Google Drive / OneDrive sync | **rclone** |
| MEGA downloads | **megatools** (`megadl`) |

## Quick Install

```bash
# Essential toolkit (macOS)
brew install yt-dlp ffmpeg gallery-dl aria2 wget jq

# Optional
npm_config_prefix="${ZHISHI_NPM_GLOBAL_PREFIX:-$HOME/.zhishi/npm-global}" npm install -g webtorrent-cli
pip install spotdl aria2p you-get streamlink

# Verify
yt-dlp --version && gallery-dl --version && aria2c --version
```
