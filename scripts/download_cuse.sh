#!/usr/bin/env bash
# Fetch the latest cuse (computer-use MCP) binary from Cloudflare R2 and
# install it under src-tauri/binaries/ using Tauri's externalBin naming
# convention (binary-<target-triple>).
#
# cuse ships a single macOS universal archive containing one universal
# Mach-O binary. We copy that binary twice (aarch64 + x86_64 target triples)
# so both Tauri build targets pick it up without per-arch duplication.
#
# Source of truth for cuse releases is GitHub
# (https://github.com/J0hnFFFF/ZhiShi-Cuse), but that repo is PRIVATE.
# The cuse maintainer mirrors each release onto R2 (see
# ZhiShi-Cuse/publish_r2.sh) so this script can pull artifacts over plain
# HTTPS without any auth — fork / contributor / public CI all work.
#
# Usage:
#   ./scripts/download_cuse.sh                 # Latest version (reads R2 latest.json)
#   ./scripts/download_cuse.sh --version v0.2.0  # Pin a specific version
#   ./scripts/download_cuse.sh --force         # Re-download even if up-to-date
#   ./scripts/download_cuse.sh --clean         # Remove existing binaries first
#
# Requirements:
#   - curl, tar, shasum (all macOS-default)
#   - No `gh` / no auth — public CDN

set -euo pipefail

DOWNLOAD_BASE_URL="https://download.zhishi.help"
LATEST_URL="${DOWNLOAD_BASE_URL}/cuse/latest.json"
RELEASES_BASE_URL="${DOWNLOAD_BASE_URL}/cuse/releases"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARIES_DIR="${PROJECT_DIR}/src-tauri/binaries"
VERSION_MARKER="${BINARIES_DIR}/.cuse-version"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[cuse]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[cuse]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[cuse]${NC} $1"; }
log_error() { echo -e "${RED}[cuse]${NC} $1"; }

# ── Parse args ────────────────────────────────────────────────────────────

VERSION=""
FORCE=false
CLEAN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --force)   FORCE=true; shift ;;
        --clean)   CLEAN=true; shift ;;
        --help|-h)
            sed -n '2,25p' "$0"
            exit 0
            ;;
        *) log_error "Unknown option: $1"; exit 1 ;;
    esac
done

# ── Preflight ─────────────────────────────────────────────────────────────

for cmd in curl tar shasum; do
    if ! command -v "$cmd" &>/dev/null; then
        log_error "Required tool not found: $cmd"
        exit 1
    fi
done

mkdir -p "$BINARIES_DIR"

# Sweep stale `.tmp.<pid>` orphans from prior runs killed mid-install. They
# are inert (Tauri externalBin matches exact filenames, not glob), but they
# accumulate if --clean isn't run regularly and clutter `ls`.
rm -f "${BINARIES_DIR}"/cuse-*.tmp.* 2>/dev/null || true

if [[ "$CLEAN" == true ]]; then
    log_info "Cleaning existing cuse binaries..."
    rm -f "${BINARIES_DIR}"/cuse-*-apple-darwin
    rm -f "$VERSION_MARKER"
fi

# ── Resolve version ───────────────────────────────────────────────────────

if [[ -z "$VERSION" ]]; then
    log_info "Querying latest cuse version from ${LATEST_URL}..."
    LATEST_JSON=$(curl -fsSL --retry 3 --retry-delay 2 --max-time 30 "$LATEST_URL" 2>/dev/null || true)
    if [[ -z "$LATEST_JSON" ]]; then
        log_error "Failed to fetch ${LATEST_URL}. Check network or pin --version."
        exit 1
    fi
    # Parse "version" without jq (jq not guaranteed on contributor machines).
    # `|| true` keeps `set -o pipefail` from silently killing the script when
    # latest.json is malformed (CDN-cached HTML 404, half-published stub,
    # schema drift). The empty-VERSION check below then surfaces a useful
    # diagnostic instead of a bare `exit 1`.
    VERSION=$(echo "$LATEST_JSON" | grep -m1 '"version"' | sed 's/.*"version" *: *"\([^"]*\)".*/\1/' || true)
    if [[ -z "$VERSION" ]]; then
        log_error "Could not parse 'version' from latest.json. Response was:"
        log_error "  $(echo "$LATEST_JSON" | head -c 200)"
        exit 1
    fi
fi

# Defensive: reject unusual tag shapes before they flow into filenames and
# shell strings. Normal cuse tags are `vMAJOR.MINOR.PATCH[-PRERELEASE]`.
if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
    log_error "Refusing unsafe version string: $VERSION"
    exit 1
fi

# Normalize to v-prefixed form for URL composition.
[[ "$VERSION" =~ ^v ]] || VERSION="v$VERSION"

log_info "Target version: $VERSION"

ARM64_BIN="${BINARIES_DIR}/cuse-aarch64-apple-darwin"
X86_BIN="${BINARIES_DIR}/cuse-x86_64-apple-darwin"

# Short-circuit if already up-to-date AND both installed binaries pass a
# Mach-O universal smoke check. A bare version-marker match is insufficient:
# a prior run killed mid-install can leave the marker from an earlier
# success next to a truncated binary. Verifying both files are actually
# universal Mach-O closes that trap without a full hash recompute.
if [[ "$FORCE" != true ]] && [[ -f "$VERSION_MARKER" ]]; then
    CURRENT=$(cat "$VERSION_MARKER" 2>/dev/null || echo "")
    if [[ "$CURRENT" == "$VERSION" ]]; then
        if [[ -f "$ARM64_BIN" && -f "$X86_BIN" ]] \
            && file "$ARM64_BIN" | grep -q "Mach-O universal binary" \
            && file "$X86_BIN" | grep -q "Mach-O universal binary"; then
            log_ok "cuse $VERSION already present, skipping download (use --force to re-download)"
            exit 0
        fi
        log_warn "Marker says $VERSION but binaries are missing/corrupt — re-downloading"
    fi
fi

# ── Download ──────────────────────────────────────────────────────────────

ARCHIVE_NAME="cuse-${VERSION}-macos-universal.tar.gz"
ARCHIVE_URL="${RELEASES_BASE_URL}/${VERSION}/${ARCHIVE_NAME}"
SHA_URL="${ARCHIVE_URL}.sha256"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

log_info "Downloading ${ARCHIVE_NAME} + .sha256..."
if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 300 \
        -o "${TMP_DIR}/${ARCHIVE_NAME}" "$ARCHIVE_URL"; then
    log_error "Archive download failed: $ARCHIVE_URL"
    log_error "  (Maintainer may have forgotten to run publish_r2.sh after the GH Release.)"
    exit 1
fi
if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 30 \
        -o "${TMP_DIR}/${ARCHIVE_NAME}.sha256" "$SHA_URL"; then
    log_error "SHA-256 sidecar download failed: $SHA_URL"
    exit 1
fi

# ── Verify checksum ───────────────────────────────────────────────────────

log_info "Verifying SHA-256..."
EXPECTED_HASH=$(awk '{print $1}' "${TMP_DIR}/${ARCHIVE_NAME}.sha256")
# Defensive: a corrupt/empty .sha256 file (truncated download, BSD-style
# format, etc) silently turns into a "mismatch" with a useless first
# token. Fail with a clear diagnostic instead.
if [[ ! "$EXPECTED_HASH" =~ ^[a-fA-F0-9]{64}$ ]]; then
    log_error "Malformed .sha256 sidecar (expected 64 hex chars, got: '${EXPECTED_HASH:0:80}')"
    exit 1
fi
ACTUAL_HASH=$(shasum -a 256 "${TMP_DIR}/${ARCHIVE_NAME}" | awk '{print $1}')

if [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]]; then
    log_error "SHA-256 mismatch!"
    log_error "  expected: $EXPECTED_HASH"
    log_error "  actual:   $ACTUAL_HASH"
    exit 1
fi
log_ok "SHA-256 verified"

# ── Extract and install ───────────────────────────────────────────────────

log_info "Extracting..."
tar -xzf "${TMP_DIR}/${ARCHIVE_NAME}" -C "$TMP_DIR"

SRC_BIN="${TMP_DIR}/cuse"
if [[ ! -f "$SRC_BIN" ]]; then
    log_error "Archive does not contain expected 'cuse' binary"
    exit 1
fi

# Sanity check: must be a Mach-O universal binary. This MUST fail loudly,
# not warn — the up-to-date short-circuit above explicitly re-downloads when
# this check fails on a previously-installed binary, so accepting a thin
# binary on first install would create an infinite re-download loop on
# subsequent build runs.
if ! file "$SRC_BIN" | grep -q "Mach-O universal binary"; then
    log_error "Downloaded binary is not a Mach-O universal binary:"
    log_error "  $(file "$SRC_BIN")"
    log_error "Archive may have been built with the wrong build.sh flags. Aborting."
    exit 1
fi

# Install atomically: write to per-PID tmp files alongside the targets on
# the same filesystem, then `mv -f` into place. A SIGKILL between `cp` and
# `mv` leaves the old binary intact; a SIGKILL after `mv` but before the
# version marker write leaves a fresh binary with a stale/absent marker
# (next run will re-verify file-type and either skip correctly or
# re-download — both safe). ARM64 and x86_64 are written as siblings by
# renaming two separate tmp files, so we never ship half an upgrade.
ARM64_TMP="${ARM64_BIN}.tmp.$$"
X86_TMP="${X86_BIN}.tmp.$$"
cp "$SRC_BIN" "$ARM64_TMP"
cp "$SRC_BIN" "$X86_TMP"
chmod +x "$ARM64_TMP" "$X86_TMP"
mv -f "$ARM64_TMP" "$ARM64_BIN"
mv -f "$X86_TMP" "$X86_BIN"

# Clear any quarantine attribute inherited from the download (mirrors the
# treatment ./scripts/build/build_macos.sh gives to bundled bun).
xattr -d com.apple.quarantine "$ARM64_BIN" 2>/dev/null || true
xattr -d com.apple.quarantine "$X86_BIN" 2>/dev/null || true

# Marker must be written LAST, after both renames commit — so interrupted
# runs never report a false "already up to date" on the next invocation.
echo "$VERSION" > "$VERSION_MARKER"

log_ok "cuse $VERSION installed:"
log_ok "  $ARM64_BIN"
log_ok "  $X86_BIN"
