#!/usr/bin/env bash
# Install all download tools. Safe to re-run (skips already installed).
set -e

echo "=== Download Anything — Toolkit Installer ==="

# Detect OS
if [[ "$(uname)" == "Darwin" ]]; then
    PKG="brew"
    if ! command -v brew &>/dev/null; then
        echo "Error: Homebrew not found. Install from https://brew.sh" && exit 1
    fi
elif command -v apt-get &>/dev/null; then
    PKG="apt"
elif command -v dnf &>/dev/null; then
    PKG="dnf"
else
    echo "Error: No supported package manager found (brew/apt/dnf)" && exit 1
fi

install_brew() {
    for pkg in "$@"; do
        if brew list "$pkg" &>/dev/null; then
            echo "✓ $pkg (already installed)"
        else
            echo "→ Installing $pkg..."
            brew install "$pkg"
        fi
    done
}

install_pip() {
    for pkg in "$@"; do
        if pip3 show "$pkg" &>/dev/null; then
            echo "✓ $pkg (already installed)"
        else
            echo "→ Installing $pkg..."
            pip3 install "$pkg"
        fi
    done
}

install_npm() {
    for pkg in "$@"; do
        local npm_prefix="${ZHISHI_NPM_GLOBAL_PREFIX:-$HOME/.zhishi/npm-global}"
        if npm_config_prefix="$npm_prefix" npm list -g "$pkg" &>/dev/null 2>&1; then
            echo "✓ $pkg (already installed)"
        else
            echo "→ Installing $pkg..."
            npm_config_prefix="$npm_prefix" npm install -g "$pkg"
        fi
    done
}

if [[ "$PKG" == "brew" ]]; then
    install_brew yt-dlp aria2 wget ffmpeg jq
    install_pip gallery-dl spotdl
else
    echo "→ Linux detected, using pip for most tools"
    install_pip yt-dlp gallery-dl spotdl
    if [[ "$PKG" == "apt" ]]; then
        sudo apt-get install -y aria2 wget ffmpeg jq 2>/dev/null || true
    elif [[ "$PKG" == "dnf" ]]; then
        sudo dnf install -y aria2 wget ffmpeg jq 2>/dev/null || true
    fi
fi

# Optional: webtorrent-cli (requires Node.js)
if command -v npm &>/dev/null; then
    install_npm webtorrent-cli
else
    echo "⊘ npm not found, skipping webtorrent-cli (optional)"
fi

echo ""
echo "=== Installed Tools ==="
for cmd in yt-dlp aria2c gallery-dl spotdl wget curl ffmpeg jq; do
    if command -v "$cmd" &>/dev/null; then
        echo "  ✓ $cmd"
    else
        echo "  ✗ $cmd (not found)"
    fi
done
echo "=== Done ==="
