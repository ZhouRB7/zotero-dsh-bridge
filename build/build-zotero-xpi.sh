#!/usr/bin/env bash
# Build the Zotero-side plugin (.xpi) from zotero-plugin/.
# Output: zotero-dsh-bridge.xpi in the repository root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/zotero-plugin"
OUT="$ROOT/zotero-dsh-bridge.xpi"

cd "$SRC"
rm -f "$OUT"
zip -X "$OUT" manifest.json bootstrap.js icons/*
echo "Built: $OUT"
