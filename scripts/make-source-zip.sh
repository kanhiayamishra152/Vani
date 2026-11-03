#!/usr/bin/env bash
# Vani AI — deterministic source archive from the committed tree.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
OUT="dist/vani-ai-1.5.1-source.zip"
if git rev-parse --verify HEAD >/dev/null 2>&1 && [ -n "$(git ls-files)" ]; then
  git archive --format=zip --prefix=vani-ai-1.5.1/ -o "$OUT" HEAD
else
  zip -qr "$OUT" . -x "node_modules/*" "third_party/*" "dist/*" ".git/*"
fi
echo "[source-zip] $OUT ($(du -h "$OUT" | cut -f1))"
sha256sum "$OUT"
