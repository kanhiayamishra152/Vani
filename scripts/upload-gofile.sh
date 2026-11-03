#!/usr/bin/env bash
# Vani AI — best-effort gofile.io mirror upload (APK + source zip).
# Prints direct download links, saves them to dist/gofile-links.txt, and
# never fails the build.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
: > dist/gofile-links.txt
for f in dist/vani-ai-1.0.0-release.apk dist/vani-ai-1.0.0-source.zip; do
  [[ -f "$f" ]] || { echo "[gofile] skip (missing): $f"; continue; }
  echo "[gofile] uploading $f ..."
  SERVER=$(curl -s -m 20 "https://api.gofile.io/servers" | python3 -c "import json,sys; d=json.load(sys.stdin); s=d['data']['servers']; print(s[0]['name'] if isinstance(s,list) else list(s)[0])" 2>/dev/null) || SERVER=""
  if [[ -z "$SERVER" ]]; then echo "[gofile] WARNING: could not reach api.gofile.io (network restricted?) — skipping mirror."; continue; fi
  RESP=""
  for EP in "contents/uploadfile" "uploadFile"; do
    RESP=$(curl -s -m 900 -F "file=@$f" "https://${SERVER}.gofile.io/${EP}" 2>/dev/null) || RESP=""
    LINK=$(printf '%s' "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['downloadPage'])" 2>/dev/null) || LINK=""
    [[ -n "$LINK" ]] && break
  done
  if [[ -n "${LINK:-}" ]]; then
    echo "[gofile] OK: $f -> $LINK"
    echo "- $(basename "$f"): $LINK" >> dist/gofile-links.txt
  else
    echo "[gofile] WARNING: upload failed for $f"
  fi
done
if [[ -s dist/gofile-links.txt ]]; then cat dist/gofile-links.txt; else echo "[gofile] no mirrors uploaded"; fi
