# Software Downloads

## Table of Contents
- [Open Source Repositories](#open-source-repositories)
- [Package Managers (CLI)](#package-managers-cli)
- [Software Archives](#software-archives)
- [Portable Software](#portable-software)
- [Chinese Software Sites](#chinese-software-sites)
- [Drivers](#drivers)
- [Download Tips](#download-tips)

---

## Open Source Repositories

| Name | URL | What | Notes |
|------|-----|------|-------|
| **GitHub Releases** | github.com | Official binaries for most OSS | Check project's "Releases" tab. Direct download links. |
| **F-Droid** | f-droid.org | FOSS Android apps (4,000+) | Built from source. No tracking/ads. Best Play Store alternative. |
| **SourceForge** | sourceforge.net | 500K+ projects | Cleaned up from 2015 adware era. Still hosts many active + legacy projects. |
| **FossHub** | fosshub.com | Curated FOSS | No adware, no bundles. Direct downloads. Malware-scanned. |
| **Flathub** | flathub.org | Linux Flatpak apps | Sandboxed. Works across distros. Best for Linux desktop. |
| **Codeberg** | codeberg.org | Git hosting (non-profit) | GitHub alternative. Germany-based. Growing. |

## Package Managers (CLI)

These are the most agent-friendly way to install software -- single command, no browser needed.

### macOS

```bash
# Homebrew (the standard)
brew install <package>           # CLI tools
brew install --cask <app>        # GUI apps
brew search <query>              # Find packages
brew info <package>              # Package details
brew update && brew upgrade      # Update all

# Examples
brew install ffmpeg yt-dlp aria2 wget jq
brew install --cask vlc firefox visual-studio-code
```

### Windows

```powershell
# winget (built into Windows 10/11)
winget install <package>
winget search <query>
winget upgrade --all

# Chocolatey
choco install <package>
choco search <query>
choco upgrade all

# Scoop (user-level, no admin needed)
scoop install <package>
scoop search <query>
scoop update *
```

| Manager | Platform | Strengths | Install |
|---------|----------|-----------|---------|
| **Homebrew** | macOS/Linux | De facto standard for macOS. Huge catalog. | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` |
| **winget** | Windows 10/11 | Built-in. Microsoft-verified. | Pre-installed on recent Windows. |
| **Chocolatey** | Windows | Largest Windows package catalog. Mature (since 2011). | `Set-ExecutionPolicy Bypass; iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))` |
| **Scoop** | Windows | Portable/dev tools. No admin needed. Lightweight. | `irm get.scoop.sh \| iex` |

## Software Archives

For finding specific versions or less common software.

| Name | URL | What | Notes |
|------|-----|------|-------|
| **Ninite** | ninite.com | Bulk Windows installer | Select apps, one installer does all. No toolbars. **Gold standard for fresh PC setup.** |
| **Softpedia** | softpedia.com | Huge software catalog | Win/Mac/Linux/Android. Virus-scanned. Includes older versions. |
| **MajorGeeks** | majorgeeks.com | Curated downloads | No bloatware. Loved by tech pros. Trusted since 2002. |
| **FileHippo** | filehippo.com | Software with version history | Good for finding specific older versions. |
| **PortableApps** | portableapps.com | 400+ portable Windows apps | Run from USB/cloud. No installation. App store-like launcher. |
| **MacUpdate** | macupdate.com | macOS software catalog | Curated. Both free and paid Mac apps. |

## Portable Software

No installation required. Run from USB, cloud drive, or any folder.

| Name | URL | Scale | Notes |
|------|-----|-------|-------|
| **PortableApps.com** | portableapps.com | 400+ apps | Platform with launcher. Open source SDK. |
| **Portable Freeware Collection** | portablefreeware.com | Large | Community-curated database. User-tested. |
| **Portapps** | portapps.io | Growing | Modern approach. Auto-update. GitHub-hosted. |

## Chinese Software Sites

| Name | URL | Focus | Trust Level | Notes |
|------|-----|-------|-------------|-------|
| **423Down** | 423down.com | Green/portable, ad-free versions | High | One of the most trusted. 10+ year track record. Clean, no-nonsense. |
| **果核剥壳 (Ghxi)** | ghxi.com | Green software, system ISOs | High | Very popular. Regular updates. Some content behind registration. |
| **异次元软件世界 (iPlaySoft)** | iplaysoft.com | Reviews + downloads | High | High-quality reviews. Focus on legitimate/OSS tools. Since 2006. |
| **小众软件 (Appinn)** | appinn.com | Niche/useful tools | High | Community-driven discovery. Active community. |
| **腾讯软件中心** | pc.qq.com | Mainstream software | Very High | Tencent official. Verified sources. No bundleware. Limited catalog. |
| **MacWk** | macwk.cn (check current) | macOS premium apps | Medium | Popular among Chinese Mac users. Domain may change. |

## Drivers

**Rule #1:** Always download from the **manufacturer's official site** first.

### Official Sources

| Manufacturer | URL | Notes |
|-------------|-----|-------|
| **NVIDIA** | nvidia.com/drivers | GeForce Experience for auto-detect. |
| **AMD** | amd.com/en/support | AMD Software: Adrenalin Edition. |
| **Intel** | intel.com/content/www/us/en/download-center/home.html | Driver & Support Assistant auto-detects hardware. |
| **Realtek** | realtek.com/downloads | Audio, Ethernet, WiFi. |

### Third-Party (when manufacturer site fails)

| Name | URL | Notes |
|------|-----|-------|
| **Station Drivers** | station-drivers.com | Community-maintained archive. Good for rare/older hardware. |
| **Snappy Driver Installer** | sdi-tool.org | Open source, offline driver installer. Downloads driver packs. Best for technicians. |
| **Driver Booster** | iobit.com/en/driver-booster.php | Automated updater. Free version available. Decline extra offers during install. |

## Download Tips

- **Agent priority:** Package manager > GitHub releases > official website > archive sites. Package managers are one command, no browser needed.
- **Verify downloads:** Check SHA256/MD5 hashes when provided. `shasum -a 256 file` on macOS.
- **Avoid bundleware:** Ninite and package managers are clean. For manual downloads, always choose "Custom/Advanced" install and uncheck extras.
- **GitHub releases direct link pattern:** `https://github.com/user/repo/releases/download/TAG/filename` -- predictable, scriptable.
- **For Windows on macOS VM:** Ninite + winget cover 90% of needs. No need to visit sketchy download sites.
