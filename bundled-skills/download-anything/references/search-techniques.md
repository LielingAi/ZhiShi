# Search Techniques & Direct Link Extraction

## Table of Contents
- [Google Dorks](#google-dorks)
- [Combining Operators](#combining-operators)
- [Direct Download Link Extraction](#direct-download-link-extraction)
- [General Search Strategies](#general-search-strategies)
- [URL Verification](#url-verification)

---

## Google Dorks

### Core Operators

| Operator | Purpose | Example |
|----------|---------|---------|
| `filetype:` | Find specific file formats | `filetype:pdf "machine learning"` |
| `intitle:` | Words in page title | `intitle:"index of" mp4` |
| `inurl:` | Words in URL | `inurl:download "filename"` |
| `site:` | Restrict to domain | `site:github.com "project"` |
| `"exact phrase"` | Exact string match | `"introduction to algorithms"` |
| `-word` | Exclude term | `python tutorial -snake -youtube` |
| `OR` | Either term | `filetype:epub OR filetype:pdf "book title"` |
| `before:YYYY-MM-DD` | Before date | `site:arxiv.org "LLM" after:2025-01-01` |
| `after:YYYY-MM-DD` | After date | Same as above |
| `intext:` | Words in page body | `intext:"download link" "software name"` |

### Finding Specific File Types

```
# Ebooks
"book title" filetype:epub OR filetype:pdf OR filetype:mobi

# Academic papers
"paper title" filetype:pdf site:arxiv.org OR site:researchgate.net

# Spreadsheets
"dataset name" filetype:xlsx OR filetype:csv

# Presentations
"topic" filetype:pptx OR filetype:pdf "slides"

# Subtitles
"movie name" filetype:srt OR filetype:ass

# Source code / configs
"project" filetype:yml OR filetype:json site:github.com

# Software
"app name" filetype:dmg OR filetype:exe OR filetype:zip "download"
```

### Finding Open Directories

Open directories are web servers with directory listing enabled -- essentially exposed file servers.

```
# Generic open directory
intitle:"index of" "parent directory" "filename"

# Music
intitle:"index of" "mp3" "artist name"
intitle:"index of" "flac" "album name"

# Video
intitle:"index of" "mkv" OR "mp4" "movie name"

# Books
intitle:"index of" "pdf" OR "epub" "book title"

# FTP servers
intitle:"index of" inurl:ftp "keyword"

# Size-sorted directories (often more useful)
intitle:"index of" "last modified" "size" "description" "keyword"
```

### Finding Resources on Specific Sites

```
# GitHub repos/releases
site:github.com "releases" "filename.zip"

# Archive.org
site:archive.org "title" filetype:pdf

# Reddit discussions about downloads
site:reddit.com "download" "resource name"

# Academic sources
site:arxiv.org OR site:scholar.google.com "topic"

# Specific wiki/doc pages
site:docs.google.com OR site:notion.so "topic"
```

## Combining Operators

The real power is in combining operators for precision targeting.

### Patterns for Common Needs

```
# Find a specific textbook PDF
"textbook title" "author" filetype:pdf -site:amazon.com -site:scribd.com

# Find course materials
"course name" "syllabus" OR "slides" OR "notes" filetype:pdf site:.edu

# Find datasets
"dataset name" filetype:csv OR filetype:json OR filetype:parquet site:github.com OR site:kaggle.com

# Find software documentation
"software name" "documentation" OR "manual" filetype:pdf

# Find presentation slides from conferences
"conference name 2025" "presentation" OR "slides" filetype:pdf OR filetype:pptx

# Find open-access paper versions
"paper title" filetype:pdf -site:sciencedirect.com -site:springer.com -site:wiley.com

# Find Chinese resources
"资源名" filetype:pdf site:pan.baidu.com OR site:aliyundrive.com
```

### Date-Scoped Searches

```
# Recent results only
"topic" after:2025-06-01

# Specific year range
"annual report" after:2024-01-01 before:2025-01-01 filetype:pdf
```

## Direct Download Link Extraction

### Cloud Storage Services

| Service | Share URL Pattern | Direct Download URL |
|---------|------------------|-------------------|
| **Google Drive** | `drive.google.com/file/d/FILE_ID/view` | `https://drive.google.com/uc?export=download&id=FILE_ID` |
| **Dropbox** | `dropbox.com/s/HASH/file?dl=0` | Change `?dl=0` to `?dl=1`, or replace `www.dropbox.com` with `dl.dropboxusercontent.com` |
| **GitHub Releases** | `github.com/user/repo/releases` | `https://github.com/user/repo/releases/download/TAG/filename` |
| **GitHub Raw** | `github.com/user/repo/blob/...` | `https://raw.githubusercontent.com/user/repo/branch/path/to/file` |
| **OneDrive** | `onedrive.live.com/...` | Append `&download=1` to embed URL |
| **MEGA** | `mega.nz/file/...` | Use `megadl "URL"` (install: `brew install megatools`) |

### Extracting URLs from Tools

```bash
# Get direct video/audio stream URL
yt-dlp -g "URL"

# Get direct image URLs from gallery
gallery-dl -g "URL"

# Follow redirects to find final URL
curl -Ls -o /dev/null -w '%{url_effective}' "SHORT-URL"

# Get headers (check content-type, file size)
curl -I "URL"

# Resolve shortened URL
curl -sI "https://bit.ly/xxx" | grep -i location
```

### Google Drive Large File Workaround

For files >100MB, Google Drive shows a virus scan warning. Bypass:

```bash
# Method: use cookies from confirmation page
FILE_ID="YOUR_FILE_ID"
curl -c /tmp/gdrive-cookies "https://drive.google.com/uc?export=download&id=${FILE_ID}" | \
  grep -oP 'confirm=\K[^&]+' | \
  xargs -I{} curl -b /tmp/gdrive-cookies -L -o output \
  "https://drive.google.com/uc?export=download&confirm={}&id=${FILE_ID}"

# Or use gdown (Python)
pip install gdown
gdown "https://drive.google.com/uc?id=FILE_ID"
```

## General Search Strategies

### Strategy 1: Escalating Search

Start specific, broaden if needed:

1. **Exact name search:** `"exact filename or title"` + `filetype:` extension
2. **Add source sites:** `site:github.com OR site:archive.org`
3. **Open directory search:** `intitle:"index of"` + filename
4. **Chinese cloud drives:** Search on 猫狸盘搜 or 优聚搜 (see `cloud-search.md`)
5. **Reddit/forum search:** `site:reddit.com "resource name" download`

### Strategy 2: Alternative Names

Resources often exist under different names:
- Try original language title AND translated title
- Try abbreviated names / common nicknames
- Try ISBN for books, DOI for papers, IMDB ID for movies
- For Chinese content, try both simplified and traditional Chinese

### Strategy 3: Source-Specific Approaches

| Resource Type | Best Search Approach |
|--------------|---------------------|
| Ebooks | Anna's Archive → Z-Library → Google `filetype:epub/pdf` → cloud drive search |
| Academic papers | DOI on Sci-Hub → Google Scholar → CORE → arXiv |
| Software | Package manager → GitHub releases → official site |
| Videos | yt-dlp (if URL known) → torrent search → cloud drive search |
| Music | spotDL (Spotify URL) → yt-dlp (YouTube) → Bandcamp/FMA |
| Images | gallery-dl (gallery URL) → stock sites → Google Images |
| Chinese anything | Cloud drive search (猫狸盘搜/优聚搜) → Bilibili → Baidu |

### Strategy 4: When You Can't Find It

1. **Check if it exists legally free:** Many resources are officially free but hard to find. Check official sites first.
2. **Check Internet Archive:** `site:archive.org "title"` -- surprisingly rich collection.
3. **Check Reddit:** `site:reddit.com "title" download OR link` -- communities often share sources.
4. **Use Chinese search for Chinese content:** Baidu > Google for Chinese resources. Use 网盘搜索 engines.
5. **Ask in communities:** r/Piracy wiki, r/opendirectories, relevant Discord servers.

## URL Verification

Before downloading, always verify:

```bash
# Check if URL is alive and get file info
curl -I "URL"
# Look for: HTTP 200, Content-Length, Content-Type

# Check if URL supports resume
curl -I "URL" | grep -i accept-ranges
# "Accept-Ranges: bytes" = supports resume

# Verify file size matches expected
curl -sI "URL" | grep -i content-length

# Test download speed (download first 1MB)
curl -o /dev/null -w "Speed: %{speed_download} bytes/sec\n" -r 0-1048576 "URL"

# Validate a webpage exists (no download)
wget --spider "URL"
```
