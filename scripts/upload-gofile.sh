#!/usr/bin/env bash
# Vani AI — best-effort gofile.io mirror upload (APK + source zip).
# Prints direct download links on success; never fails the build.
set -uo pipefail
cd "$(dirname "$0")/.."
for f in dist/vani-ai-1.0.0-release.apk dist/vani-ai-1.0.0-source.zip; do
  [[ -f "$f" ]] || { echo "[gofile] skip (missing): $f"; continue; }
  echo "[gofile] uploading $f ..."
  SERVER=$(curl -s -m 20 "https://api.gofile.io/servers" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['servers'][0]['name'])" 2>/dev/null) || SERVER=""
  if [[ -z "$SERVER" ]]; then echo "[gofile] WARNING: could not reach api.gofile.io (network restricted?) — skipping mirror."; continue; fi
  RESP=$(curl -s -m 900 -F "file=@$f" "https://${SERVER}.gofile.io/uploadFile" 2>/dev/null) || RESP=""
  LINK=$(printf '%s' "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['downloadPage'])" 2>/dev/null) || LINK=""
  if [[ -n "$LINK" ]]; then echo "[gofile] OK: $f -> $LINK"; else echo "[gofile] WARNING: upload failed for $f"; fi
done
