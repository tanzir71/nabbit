#!/usr/bin/env sh
set -eu

TARGET="${1:-x86_64-unknown-linux-gnu}"
BUNDLES="${2:-}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEFAULT_KEY="$HOME/.tauri/nabbit-updater.key"

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  if [ -f "$DEFAULT_KEY" ]; then
    export TAURI_SIGNING_PRIVATE_KEY_PATH="$DEFAULT_KEY"
    export TAURI_SIGNING_PRIVATE_KEY="$DEFAULT_KEY"
  else
    echo "Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH before building updater artifacts." >&2
    exit 1
  fi
fi

"$ROOT/scripts/fetch-binaries.sh" "$TARGET"
cd "$ROOT"
if [ -n "$BUNDLES" ]; then
  npm run tauri -- build --config src-tauri/tauri.release.conf.json --target "$TARGET" --ci --bundles "$BUNDLES"
else
  npm run tauri -- build --config src-tauri/tauri.release.conf.json --target "$TARGET" --ci
fi
