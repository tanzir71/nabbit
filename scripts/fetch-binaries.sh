#!/usr/bin/env sh
set -eu

TARGET="${1:-x86_64-unknown-linux-gnu}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
mkdir -p "$BIN"

fetch() {
  url="$1"
  name="$2"
  echo "Downloading $name"
  if command -v curl >/dev/null 2>&1; then
    curl -L "$url" -o "$BIN/$name"
  else
    wget -O "$BIN/$name" "$url"
  fi
  chmod +x "$BIN/$name" || true
}

case "$TARGET" in
  *apple-darwin*)
    fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" "yt-dlp-$TARGET"
    echo "Download a signed ffmpeg build and place it at src-tauri/binaries/ffmpeg-$TARGET."
    ;;
  *linux*)
    fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "yt-dlp-$TARGET"
    echo "Install/copy ffmpeg to src-tauri/binaries/ffmpeg-$TARGET or ensure ffmpeg is on PATH."
    ;;
  *)
    echo "Use scripts/fetch-binaries.ps1 for Windows targets."
    ;;
esac
