# Educational Resources

## Table of Contents
- [Major MOOC Platforms](#major-mooc-platforms)
- [Specialized Learning](#specialized-learning)
- [Chinese Platforms](#chinese-platforms)
- [Bilibili Education](#bilibili-education)
- [Downloadable Course Materials](#downloadable-course-materials)
- [Tips](#tips)

---

## Major MOOC Platforms

| Name | URL | Cost | What | Notes |
|------|-----|------|------|-------|
| **MIT OpenCourseWare** | ocw.mit.edu | Free | Thousands of MIT courses: syllabi, lecture notes, videos, exams | Gold standard. No login required. Full video lectures. Truly free. |
| **Khan Academy** | khanacademy.org | Free | K-12 through college. Math, science, computing, arts, economics | 100% free. No ads. Interactive exercises. Self-paced. |
| **Coursera** | coursera.org | Audit free | University courses from top institutions | Free to audit (videos + readings). Certificate costs $49-99. Financial aid available. |
| **edX** | edx.org | Audit free | MIT, Harvard, etc. Similar to Coursera | Free audit access to most courses. Now owned by 2U. |
| **freeCodeCamp** | freecodecamp.org | Free | Full-stack web dev, data science, ML | Project-based. Free certifications. Active community. **Best free coding education.** |
| **Open Yale Courses** | oyc.yale.edu | Free | Yale course lectures and materials | Smaller catalog but high quality. |
| **Stanford Online** | online.stanford.edu | Varies | Stanford courses, some free | Check for free options. |
| **The Odin Project** | theodinproject.com | Free | Full-stack web development curriculum | Project-based. Ruby/JS paths. Community-driven. |

## Specialized Learning

| Name | URL | Focus | Notes |
|------|-----|-------|-------|
| **Codecademy** | codecademy.com | Coding | Interactive. Free tier available. Pro for more content. |
| **LeetCode** | leetcode.com | Algorithm practice | Free tier with most problems. Good for interview prep. |
| **3Blue1Brown** | 3blue1brown.com / YouTube | Math visualization | Beautiful math explainers. Free on YouTube. |
| **Crash Course** | YouTube: CrashCourse | Multi-subject | Short, engaging video courses on dozens of subjects. |
| **OpenStax** | openstax.org | Free textbooks | Peer-reviewed textbooks. PDF/web. College-level. Rice University. |
| **LibreTexts** | libretexts.org | Free textbooks | Open textbooks for STEM. Collaborative editing. |

## Chinese Platforms

| Name | URL | What | Notes |
|------|-----|------|-------|
| **学堂在线** | xuetangx.com | Chinese MOOC by Tsinghua University | Leading Chinese MOOC platform. Thousands of courses. Free to audit. |
| **中国大学MOOC** | icourse163.org | NetEase + Ministry of Education | Largest Chinese MOOC. Free certificates for some courses. |
| **网易公开课** | open.163.com | Translated international courses + originals | TED talks, Yale/MIT courses with Chinese subtitles. Free. |
| **慕课网 (imooc)** | imooc.com | Programming / IT courses | Free + paid tiers. Practical, project-oriented. |

## Bilibili Education

Bilibili (bilibili.com) is not a course platform, but its education ecosystem is massive and free.

**How to find courses:**
- Search `[topic] 教程` (tutorial) or `[topic] 课程` (course)
- Many university professors upload full course series
- Community quality control via danmaku (bullet comments) and ratings

**Popular education categories on Bilibili:**
- Programming / CS: `Python教程`, `前端开发`, `机器学习`
- Math: `高等数学`, `线性代数`, `概率论`
- Language: `英语学习`, `日语入门`
- Science: `物理`, `化学`, `生物`
- Design: `PS教程`, `UI设计`, `视频剪辑`

**Download Bilibili courses:**
```bash
# yt-dlp supports Bilibili
yt-dlp "https://www.bilibili.com/video/BV..."

# For members-only content, use cookies
yt-dlp --cookies-from-browser chrome "URL"

# Download entire multi-part video (合集)
yt-dlp --yes-playlist "URL"

# List all parts first
yt-dlp --flat-playlist "URL"
```

## Downloadable Course Materials

Many platforms allow downloading materials for offline use:

| Platform | Downloadable Content | How |
|----------|---------------------|-----|
| **MIT OCW** | Lecture notes, problem sets, exams (PDF). Some video. | Direct download from course page. |
| **Khan Academy** | Videos (via yt-dlp) | `yt-dlp "khanacademy.org/..."` |
| **Coursera** | Videos, slides (enrolled courses) | Use `coursera-dl` (`pip install coursera-dl`) or yt-dlp with cookies. |
| **edX** | Videos, transcripts (enrolled) | `edx-dl` tool or yt-dlp. |
| **freeCodeCamp** | All curriculum is web-based | Use `wget --mirror` for offline copy. |
| **OpenStax** | Full textbooks as PDF | Direct download from site. |

## Tips

- **Audit vs Enroll:** On Coursera/edX, "audit" = free (videos + readings, no cert). "Enroll" = paid (cert + graded assignments). Always audit first.
- **Coursera financial aid** is available and fairly easy to get -- just write a short paragraph explaining why.
- **For Chinese learners:** Bilibili is often better than formal MOOC platforms for practical skills. More engaging, more community feedback.
- **Offline viewing:** yt-dlp works on Coursera, edX, Khan Academy, Bilibili, YouTube -- all major education platforms.
- **Cloud drive resources:** Many Chinese users share complete course packages on Alibaba Cloud Drive. Search on 猫狸盘搜 or 优聚搜 (see `cloud-search.md`).
