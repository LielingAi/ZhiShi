# Music & Audio Downloads

## Table of Contents
- [Free & Legal Music](#free--legal-music)
- [Download Tools](#download-tools)
- [Chinese Music Resources](#chinese-music-resources)
- [Podcasts](#podcasts)
- [Download Tips](#download-tips)

---

## Free & Legal Music

| Name | URL | Scale | License | Notes |
|------|-----|-------|---------|-------|
| **Bandcamp** | bandcamp.com | Millions of tracks | Varies (many "name your price") | Enter $0 for free. FLAC/WAV available. Best for indie music discovery. |
| **Free Music Archive** | freemusicarchive.org | 200K+ tracks | CC licenses | Direct MP3 download. Great for content creators needing licensed music. |
| **Jamendo** | jamendo.com | 240,000+ tracks | CC / royalty-free | Free for personal listening. Commercial license separate. Multi-format. |
| **Musopen** | musopen.org | Thousands | Public domain | Classical music recordings + sheet music. Professional quality. |
| **SoundCloud** | soundcloud.com | Massive | Varies | Many artists enable free downloads. Look for "Free Download" button. |
| **ccMixter** | ccmixter.org | Thousands | CC | Remixes and instrumentals. Free for commercial use with credit. |
| **YouTube Audio Library** | youtube.com/audiolibrary | Thousands | Free (YouTube creators) | No copyright claims. Sorted by genre/mood. Requires Google account. |
| **Internet Archive Audio** | archive.org/details/audio | Millions | Varies | Live concerts (Grateful Dead, Phish), old radio, public domain. |

## Download Tools

### spotDL -- Spotify Playlist Downloader

```bash
# Install
pip install spotdl

# Download a track
spotdl "https://open.spotify.com/track/TRACK_ID"

# Download entire playlist
spotdl "https://open.spotify.com/playlist/PLAYLIST_ID"

# Download album
spotdl "https://open.spotify.com/album/ALBUM_ID"

# Search and download
spotdl "artist - song name"

# Specify output format
spotdl --output "{artist} - {title}.{output-ext}" "URL"

# Specify audio format
spotdl --format mp3 "URL"    # or flac, ogg, opus, m4a
```

Matches Spotify tracks to YouTube, downloads with metadata + album art embedded.

### yt-dlp -- Audio Extraction

```bash
# Extract audio as MP3 (best quality)
yt-dlp -x --audio-format mp3 --audio-quality 0 "URL"

# Keep original format (usually opus/m4a -- best quality)
yt-dlp -x "URL"

# Extract audio from playlist
yt-dlp -x --audio-format mp3 --yes-playlist "PLAYLIST_URL"

# Download with metadata
yt-dlp -x --audio-format mp3 --embed-metadata --embed-thumbnail "URL"

# Batch download from file
yt-dlp -x --audio-format mp3 -a urls.txt
```

### Cobalt -- Quick Audio Grab

```bash
curl -X POST "https://YOUR-INSTANCE/" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "VIDEO_OR_AUDIO_URL",
    "downloadMode": "audio",
    "audioFormat": "mp3",
    "audioBitrate": "320"
  }'
```

Supports YouTube, SoundCloud, TikTok audio, Twitter video audio.

## Chinese Music Resources

### Aggregator Players (Open Source)

| Name | URL | Platforms | What | Notes |
|------|-----|-----------|------|-------|
| **Listen 1** | listen1.github.io/listen1/ | Desktop, browser ext, mobile | Aggregates QQ Music, NetEase, KuGou, KuWo, Bilibili, Migu | Streams only, no download. Best all-in-one player. |
| **洛雪音乐助手 (LX Music)** | github.com/lyswhut/lx-music-desktop | Desktop + mobile | Multi-source music player | Supports custom sources. High-quality audio. Very popular. |
| **YesPlayMusic** | github.com/qier222/YesPlayMusic | Desktop | NetEase Cloud Music third-party client | Beautiful UI. Open source. |

### Download Sites

| Name | URL | What | Notes |
|------|-----|------|-------|
| **无损控 (Wusunk)** | wusunk.com | Lossless music downloads | FLAC, WAV, APE, MP3. Chinese interface. |
| **MyFreeMP3** | (domain changes frequently) | MP3 search & download | No registration. Search "MyFreeMP3 最新地址" for current domain. |

### Major Chinese Streaming Platforms (reference)

| Platform | URL | Free Tier |
|----------|-----|-----------|
| QQ Music | y.qq.com | Yes (with ads) |
| NetEase Cloud Music | music.163.com | Yes (with ads) |
| KuGou | kugou.com | Yes |
| KuWo | kuwo.cn | Yes |
| Migu Music | music.migu.cn | Yes |

For downloading from these platforms, LX Music or Listen 1 with custom sources is the most practical approach.

## Video Game & Soundtrack Music (VGM/OST)

| Name | URL | What | Notes |
|------|-----|------|-------|
| **KHInsider** | downloads.khinsider.com | Game soundtracks (MP3 + FLAC) | Massive catalog. Free download (may require free account). Covers retro through modern. |
| **VGMdb** | vgmdb.net | Soundtrack database (metadata, not downloads) | The IMDb of game/anime music. Album info, tracklists, scans. Use to identify, then download elsewhere. |
| **Zophar's Domain** | zophar.net | Retro game music (original formats) | NSF, SPC, VGM formats. For chiptune / retro. Needs a player (VGMPlay, foobar2000 + plugins). |
| **SquidBoard** | squid-board.org | VGM community + sharing | Forum-based. Good for rare/obscure soundtracks. Registration required. |
| **Internet Archive** | archive.org | Game OSTs + live recordings | Search "game name OST" — many uploaded as collections. Free. |

**VGM download tip:** Search YouTube for `"game name" OST full` → use `yt-dlp -x --audio-format mp3` to extract. Many complete OSTs are uploaded as single videos or playlists.

## Podcasts

| Name | URL | Platform | Notes |
|------|-----|----------|-------|
| **gPodder** | gpodder.github.io | Desktop (Win/Mac/Linux) | Best for batch downloading. Python-based. Syncs with gpodder.net. |
| **AntennaPod** | antennapod.org | Android | Best FOSS podcast app. Available on F-Droid. No tracking. |
| **PodcastToMP3** | podcasttomp3.com | Web | Search podcast name, download episodes as MP3. No install needed. |
| **yt-dlp** | github.com/yt-dlp/yt-dlp | CLI | Downloads podcasts from YouTube, Spotify, many platforms. |
| **Podcast Addict** | Google Play | Android | Most popular Android podcast app. Auto-download. Free with ads. |

**Podcast download via yt-dlp:**
```bash
# YouTube podcast
yt-dlp -x --audio-format mp3 "https://www.youtube.com/playlist?list=PODCAST_PLAYLIST"

# Any podcast RSS feed (use curl)
curl -s "RSS_FEED_URL" | grep -oP 'url="[^"]*\.mp3' | sed 's/url="//' > episodes.txt
aria2c -i episodes.txt -d ./podcast/
```

## Download Tips

- **Audio quality:** FLAC/WAV = lossless. MP3 320kbps = best lossy. MP3 128kbps = acceptable for speech. Opus is more efficient than MP3 at same bitrate.
- **For Spotify playlists:** spotDL is the most reliable CLI tool. It matches tracks on YouTube and downloads with full metadata. **Note:** spotDL can hit Spotify API rate limits (24h cooldown). If rate-limited, use `yt-dlp -x` to download from YouTube directly as a fallback.
- **yt-dlp `--audio-quality 0`** means best quality VBR (~245kbps for MP3). Use `--audio-quality 5` for ~130kbps if size matters.
- **Metadata embedding:** Both spotDL and yt-dlp can embed album art, artist, title via `--embed-metadata --embed-thumbnail`.
- **Chinese music tip:** Many songs restricted on one platform are available on another. LX Music's multi-source approach exploits this.
