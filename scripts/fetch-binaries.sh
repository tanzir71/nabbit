#!/usr/bin/env sh
set -eu
TARGET="${1:-x86_64-unknown-linux-gnu}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ "${FORCE:-0}" = "1" ]; then
  exec node "$ROOT/scripts/fetch-engines.mjs" "$TARGET" --force
fi
exec node "$ROOT/scripts/fetch-engines.mjs" "$TARGET"
