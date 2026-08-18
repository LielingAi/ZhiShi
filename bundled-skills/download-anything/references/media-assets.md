# Media Assets: Images, Video, Audio & Fonts

## Table of Contents
- [Stock Images](#stock-images)
- [Stock Video](#stock-video)
- [Stock Audio & Sound Effects](#stock-audio--sound-effects)
- [English Fonts](#english-fonts)
- [Chinese Fonts](#chinese-fonts)
- [Download Tips](#download-tips)

---

## Stock Images

All free for commercial and personal use. No attribution required (but appreciated).

| Name | URL | Scale | Notes |
|------|-----|-------|-------|
| **Unsplash** | unsplash.com | 1M+ photos | Natural, lifestyle aesthetic. Doesn't feel "stocky." API available. |
| **Pexels** | pexels.com | Large | Good search filters. Also has video. API available. |
| **Pixabay** | pixabay.com | Massive | Photos, illustrations, vectors, videos, music, SFX. One-stop shop. |
| **Kaboompics** | kaboompics.com | Thousands | Lifestyle/interior focus. Color palette provided with each photo. |
| **Shopify Stock Photos** | shopify.com/stock-photos | Thousands | By Shopify. E-commerce friendly. (Formerly Burst.) |
| **StockSnap** | stocksnap.io | Thousands | Hundreds added weekly. CC0 license. |

**Programmatic access:**
```bash
# Unsplash API (free, 50 req/hr)
curl "https://api.unsplash.com/search/photos?query=mountain&per_page=10" \
  -H "Authorization: Client-ID YOUR_ACCESS_KEY"

# Pexels API (free, 200 req/hr)
curl "https://api.pexels.com/v1/search?query=nature&per_page=10" \
  -H "Authorization: YOUR_API_KEY"

# Pixabay API (free, 100 req/min)
curl "https://pixabay.com/api/?key=YOUR_KEY&q=forest&image_type=photo"
```

## Stock Video

| Name | URL | Quality | Notes |
|------|-----|---------|-------|
| **Pexels Videos** | pexels.com/videos | HD/4K | Same license as Pexels photos. No attribution required. |
| **Pixabay Videos** | pixabay.com/videos | Various | Part of Pixabay ecosystem. |
| **Mixkit** | mixkit.co | HD/4K | Curated. By Envato. Trendy aesthetic. Also has music + SFX. |
| **Coverr** | coverr.co | HD | Good for website backgrounds. 7 new videos weekly. |

## Stock Audio & Sound Effects

| Name | URL | Scale | License | Notes |
|------|-----|-------|---------|-------|
| **Freesound** | freesound.org | 400,000+ | CC (varies per clip) | Collaborative database. 8M+ users. Search by tags/duration/format. |
| **Zapsplat** | zapsplat.com | 150,000+ | Free (attribution) | Professional quality. MP3 & WAV. Free account required. Updated daily. |
| **YouTube Audio Library** | youtube.com/audiolibrary | Thousands | Free for YouTube | No copyright claims. Genre/mood/instrument filters. Requires Google account. |
| **Mixkit SFX** | mixkit.co/free-sound-effects | Curated | Free | No account needed. High quality. |
| **Pixabay Audio** | pixabay.com/sound-effects | 120,000+ | Free, no attribution | Part of Pixabay. |
| **Uppbeat** | uppbeat.io | Curated | Free (3/month) | High quality. Limited free tier. |
| **ccMixter** | ccmixter.org | Thousands | CC | Remixes and instrumentals. Free for commercial use with credit. |

## English Fonts

| Name | URL | Scale | License | Notes |
|------|-----|-------|---------|-------|
| **Google Fonts** | fonts.google.com | 1,800+ families | Open source (SIL OFL / Apache) | De facto standard for web fonts. All free for personal + commercial. API for embedding. |
| **Font Squirrel** | fontsquirrel.com | Thousands | All commercial-use | Every font vetted. Excellent webfont generator tool. |
| **DaFont** | dafont.com | Huge | **Check each font** | Many decorative/display fonts. Many are free for personal use ONLY. |
| **Fontshare** | fontshare.com | Curated | Free personal + commercial | By Indian Type Foundry. High quality, professional. Modern selection. |
| **1001 Fonts** | 1001fonts.com | 30,000+ | Filter by license | Good license filtering. Clean interface. |
| **Uncut.wtf** | uncut.wtf | Small, curated | Free | Very high quality. Contemporary design focus. |
| **Bunny Fonts** | fonts.bunny.net | 1,510+ | Same as Google Fonts | GDPR-compliant Google Fonts drop-in replacement. EU CDN. No tracking. |

## Chinese Fonts

### Free for Commercial Use

| Name | URL | Style | Notes |
|------|-----|-------|-------|
| **思源黑体 (Source Han Sans / Noto Sans CJK)** | github.com/adobe-fonts/source-han-sans | Sans-serif, 7 weights | Adobe + Google. **The** go-to free CJK font. Covers SC/TC/JP/KR. |
| **思源宋体 (Source Han Serif / Noto Serif CJK)** | github.com/adobe-fonts/source-han-serif | Serif, 7 weights | Beautiful for body text. Same coverage as Sans. |
| **阿里巴巴普惠体** | fonts.alibabagroup.com | Modern sans, multiple weights | Alibaba official. Clean, professional. Free for all use. |
| **站酷字体系列** | zcool.com.cn/special/zcoolfonts/ | 7 display fonts | Community-created. Each has unique personality (高端黑, 庆科黄油体, etc.). |
| **霞鹜文楷** | github.com/lxgw/LxgwWenKai | Handwriting/楷书 | Open source. Beautiful for literary/elegant use. Active development. |

### Font Discovery & Aggregation

| Name | URL | What | Notes |
|------|-----|------|-------|
| **猫啃网** | maoken.com/all-fonts | Chinese free font directory | **Best single source** for finding free Chinese fonts. Clear license info. Regularly updated. |
| **100font** | 100font.com | Free commercial-use fonts | Clean interface. License verified for each font. |
| **字由** | hellofont.cn | Font management app | Desktop app for previewing/managing fonts. Some free, some paid. |

## Download Tips

- **Image search tip:** Most stock sites have APIs. For batch downloads, use the API instead of scraping.
- **gallery-dl** works on many image sites for batch download: `gallery-dl "URL"`
- **Font format priority:** OTF > TTF > WOFF2 (web only). OTF has better curves and features.
- **Chinese font file sizes:** CJK fonts are large (10-30MB per weight) due to glyph count. Source Han Sans full set is ~200MB.
- **License check:** DaFont and similar sites mix licenses. Always verify before commercial use. Google Fonts and 猫啃网 fonts are safe.
- **Bulk stock downloads:** Use `wget -i urls.txt` or `aria2c -i urls.txt` with a list of direct image URLs from API results.
