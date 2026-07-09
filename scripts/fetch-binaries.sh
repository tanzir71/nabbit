#!/usr/bin/env sh
set -eu

TARGET="${1:-x86_64-unknown-linux-gnu}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
mkdir -p "$BIN"

fetch() {
  url="$1"
  name="$2"
  if [ -f "$BIN/$name" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "Using existing $name"
    return
  fi
  echo "Downloading $name"
  if command -v curl >/dev/null 2>&1; then
    curl -L "$url" -o "$BIN/$name"
  else
    wget -O "$BIN/$name" "$url"
  fi
  chmod +x "$BIN/$name" || true
}

copy_ffmpeg_from_path() {
  target="$1"
  if command -v ffmpeg >/dev/null 2>&1; then
    cp "$(command -v ffmpeg)" "$BIN/ffmpeg-$target"
    chmod +x "$BIN/ffmpeg-$target" || true
    echo "Copied ffmpeg from PATH to ffmpeg-$target"
  else
    echo "Install/copy ffmpeg to src-tauri/binaries/ffmpeg-$target or ensure ffmpeg is on PATH."
  fi
}

case "$TARGET" in
  *apple-darwin*)
    fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" "yt-dlp-$TARGET"
    copy_ffmpeg_from_path "$TARGET"
    ;;
  *linux*)
    fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "yt-dlp-$TARGET"
    copy_ffmpeg_from_path "$TARGET"
    ;;
  *)
    echo "Use scripts/fetch-binaries.ps1 for Windows targets."
    ;;
esac
