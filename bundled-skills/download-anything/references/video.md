# Video, Film & TV Downloads

## Table of Contents
- [Torrent Sites](#torrent-sites)
- [Torrent Search Engines](#torrent-search-engines)
- [Direct Download (DDL) Sites](#direct-download-ddl-sites)
- [Subtitle Sites](#subtitle-sites)
- [Chinese Video Resources](#chinese-video-resources)
- [Anime](#anime)
- [Online Video Downloaders](#online-video-downloaders)
- [Download Tips](#download-tips)

---

## Torrent Sites

RARBG closed in 2023. These are the current active alternatives.

| Name | URL | Focus | Notes |
|------|-----|-------|-------|
| **YTS** | yts.mx | Movies (small x265 files) | 720p/1080p/2160p. Compact encodes. Great for limited bandwidth. |
| **1337x** | 1337x.to | General (movies, TV, games, music) | Best all-around torrent site since RARBG's demise. Clean UI. |
| **TorrentGalaxy** | torrentgalaxy.to | General | Good RARBG replacement. Has IMDB ratings, screenshots. |
| **EZTV** | eztvx.to | TV shows | Dedicated TV tracker. Episode packs and singles. |
| **Nyaa** | nyaa.si | Anime, manga, Japanese media | The anime torrent site. Also manga and live-action Japanese content. |
| **RuTracker** | rutracker.org | General (Russian + international) | Massive catalog. Registration required. Russian interface but has English content. |

## Torrent Search Engines

Aggregate results across multiple torrent sites.

| Name | URL | Notes |
|------|-----|-------|
| **Snowfl** | snowfl.com | Real-time aggregation. Clean, fast. Shows health/seeds. |
| **BitSearch** | bitsearch.to | Indexes 46M+ torrents. DHT crawling. No tracking. (Formerly solidtorrents.to.) |
| **TorrentSeeker** | torrentseeker.com | Google Custom Search-based. Searches multiple trackers. |
| **BTDigg** | btdig.com | DHT search engine. Finds torrents by content, not trackers. |

## Direct Download (DDL) Sites

No torrent client needed. Files hosted on filehosters (1fichier, Rapidgator, etc.).

| Name | URL | Focus | Notes |
|------|-----|-------|-------|
| **Pahe** | pahe.ink | Movies & TV (x265 small encodes) | Excellent quality-to-size ratio. Multiple mirrors. |
| **DDLValley** | ddlvalley.me | Movies, TV, software | Multiple filehost mirrors. |
| **RleaseBB** | rlsbb.ru | Scene releases | Tracks scene releases with DDL links. |

**Tip:** DDL sites often use filehosters with download limits. A Real-Debrid or AllDebrid subscription (~$5/mo) unlocks premium speeds on most hosters and can also cache torrents.

## Subtitle Sites

| Name | URL | Languages | Notes |
|------|-----|-----------|-------|
| **SubDL** | subdl.com | 100+ languages | Modern UI. API available. Large collection. |
| **OpenSubtitles** | opensubtitles.com | 60+ languages | Largest subtitle database. API (requires account). |
| **射手网 (assrt.net)** | assrt.net | Chinese + English | Shooter subtitle replacement. Community uploads. |
| **字幕库** | zimuku.org | Chinese + bilingual | Large Chinese subtitle collection. Active community. |
| **ChineseSubFinder** | github.com/ChineseSubFinder | Chinese (automated) | CLI tool. Auto-matches Chinese subtitles to your media library. Integrates with Emby/Jellyfin/Plex. |

## Chinese Video Resources

| Name | URL | What | Notes |
|------|-----|------|-------|
| **BT之家1LOU站** | 1lou.me (check current) | General Chinese torrents | Active community. Movies, TV, anime. |
| **音范丝** | yinfans.me | 4K Blu-ray, Hi-Res audio | High-quality encodes. Remux and 4K HDR focus. |
| **人人影视** | (discontinued) | Was the biggest fan-sub group | Shut down. Legacy torrents still circulate. |
| **PT sites (private)** | Various | High-quality encodes | HDSKY, M-Team, CHDBits, TTG -- invite only. Best quality but hard to get in. |

## Anime

| Name | URL | What | Notes |
|------|-----|------|-------|
| **Nyaa** | nyaa.si | Anime torrents | Primary anime torrent source. Fansubs + official rips. |
| **SubsPlease** | subsplease.org | Simulcast rips | Rips from Crunchyroll/Funimation within hours of airing. Available on Nyaa too. |
| **AnimeTosho** | animetosho.org | Anime DDL + torrents | Mirrors Nyaa uploads with DDL links. NZB available. |
| **AniList** | anilist.co | Tracking (not download) | Track what you've watched. Community recommendations. |
| **Bilibili** | bilibili.com | Licensed anime streaming (CN) | Many anime legally available in China. Use yt-dlp to download. |

## Online Video Downloaders

### yt-dlp (primary tool -- supports 1800+ sites)

```bash
# Best 1080p video
yt-dlp -f "bv[height<=1080]+ba/b[height<=1080]" "URL"

# List formats first
yt-dlp -F "URL"

# Download with subtitles
yt-dlp --write-subs --sub-lang en,zh --embed-subs "URL"

# Audio only (MP3)
yt-dlp -x --audio-format mp3 "URL"

# Bilibili (need cookies for members-only)
yt-dlp --cookies-from-browser chrome "https://www.bilibili.com/video/BV..."

# Twitter/X video
yt-dlp "https://twitter.com/user/status/ID"

# TikTok (no watermark)
yt-dlp "https://www.tiktok.com/@user/video/ID"

# Download entire playlist
yt-dlp --yes-playlist "PLAYLIST_URL"

# Get metadata only (no download)
yt-dlp -j --no-download "URL"
```

### Cobalt

| | |
|---|---|
| **Web** | cobalt.tools |
| **API** | Self-host via Docker for agent use |
| **Supports** | YouTube, TikTok, Instagram, Twitter, Reddit, SoundCloud, 30+ sites |

```bash
# API call (self-hosted instance)
curl -X POST "https://YOUR-INSTANCE/" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"url": "VIDEO_URL", "videoQuality": "1080"}'
```

Clean, no-ads web UI for casual use. Self-host for automation.

## Download Tips

- **Quality tiers:** Remux (untouched Blu-ray) > Encode (x265/x264) > WEB-DL > WEBRip > CAM. For most people, x265 1080p is the sweet spot (good quality, small size).
- **Torrent client for agent use:** `aria2c "magnet:?xt=..."` -- handles HTTP + torrents in one tool. Use `--seed-ratio=0.0` to stop after download.
- **Verify before downloading:** `yt-dlp -F "URL"` shows all available formats with resolution, codec, and file size.
- **For Chinese dramas/shows:** Network search (网盘搜索) is often faster than torrents. See `cloud-search.md`.
- **Subtitle auto-matching:** ChineseSubFinder for Chinese subs; Bazarr for multi-language (integrates with Sonarr/Radarr).
