#!/usr/bin/env bash
# Vani AI — local build pipeline.
# Builds the web bundle, prepares native deps + avatar + icons, signs a fresh
# v1 keystore, assembles the release APK (when an Android SDK is present),
# packages a source ZIP, and optionally uploads both to gofile.io.
#
# Usage:  ./android/build-apk.sh [--skip-native] [--skip-vrm] [--no-upload]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DIST="$ROOT/dist"
mkdir -p "$DIST"
SKIP_NATIVE=0; SKIP_VRM=0; NO_UPLOAD=0
for a in "$@"; do
  case "$a" in
    --skip-native) SKIP_NATIVE=1 ;;
    --skip-vrm) SKIP_VRM=1 ;;
    --no-upload) NO_UPLOAD=1 ;;
  esac
done

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "1/8 Toolchain"
have node || { echo "Node.js 18+ is required"; exit 1; }
node --version
[ -d node_modules ] || npm ci --no-audit --no-fund

say "2/8 Native runtime sources (llama.cpp + sherpa-onnx + silero VAD)"
if [ "$SKIP_NATIVE" = 0 ]; then
  node scripts/fetch-native-deps.mjs || echo "WARN: native dep fetch had issues (see above)"
else
  echo "skipped (--skip-native)"
fi

say "3/8 Avatar (OC-Lily VRM)"
if [ "$SKIP_VRM" = 0 ]; then
  if node scripts/fetch-vrm.mjs; then
    node scripts/prepare-vrm-safe.mjs
    node scripts/prepare-vrm-safe.mjs --check
  else
    echo "WARN: VRM fetch failed (network/Drive). Live Talk avatar will be absent until CI fetches it."
  fi
else
  echo "skipped (--skip-vrm)"
fi

say "4/8 Launcher + splash icons"
node scripts/gen-icons.mjs

say "5/8 Web bundle (esbuild -> android assets/www)"
node scripts/build-web.mjs

say "6/8 Signing key (fresh v1)"
if [ ! -f android/vani-v1.jks ]; then
  bash scripts/gen-keystore.sh
else
  echo "android/vani-v1.jks already present"
fi
if [ ! -f android/keystore.properties ] && [ -f android/vani-v1.jks ]; then
  cat > android/keystore.properties <<EOF
storeFile=vani-v1.jks
storePassword=${VANI_STORE_PASSWORD:-vani-v1-release}
keyAlias=${VANI_KEY_ALIAS:-vani-v1}
keyPassword=${VANI_KEY_PASSWORD:-vani-v1-release}
EOF
fi

say "7/8 Release APK"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ] && [ -f android/local.properties ]; then
  SDK=$(grep -m1 '^sdk.dir=' android/local.properties | cut -d= -f2-)
fi
GRADLE=""
if have gradle; then GRADLE="gradle"; elif [ -x android/gradlew ]; then GRADLE="./gradlew"; fi

APK_OUT=""
if [ -n "$SDK" ] && [ -n "$GRADLE" ]; then
  BT=$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)
  ( cd android && $GRADLE --no-daemon assembleRelease )
  RAW=$(find android/app/build/outputs/apk/release -name '*.apk' | head -1)
  if [ -n "$RAW" ]; then
    if [ -n "$BT" ]; then
      OUT="$DIST/vani-ai-1.5.1-release.apk"
      ALIGNED="$DIST/.vani-ai-1.5.1-aligned.apk"
      "$BT/zipalign" -f -p 4 "$RAW" "$ALIGNED"
      SP=$(grep '^storePassword=' android/keystore.properties | cut -d= -f2-)
      KP=$(grep '^keyPassword=' android/keystore.properties | cut -d= -f2-)
      AL=$(grep '^keyAlias=' android/keystore.properties | cut -d= -f2-)
      "$BT/apksigner" sign --ks android/vani-v1.jks --ks-key-alias "$AL" \
        --ks-pass "pass:$SP" --key-pass "pass:$KP" \
        --v1-signing-enabled true --v2-signing-enabled true \
        --v3-signing-enabled false --v4-signing-enabled false \
        --out "$OUT" "$ALIGNED"
      rm -f "$ALIGNED"
      "$BT/zipalign" -c -p 4 "$OUT"
      "$BT/apksigner" verify --verbose --min-sdk-version 23 --print-certs "$OUT"
      echo "APK aligned; v1 + v2 signatures verified"
    else
      cp "$RAW" "$DIST/vani-ai-1.5.1-release.apk"
      echo "WARN: Android build-tools not found; copied the AGP-signed APK"
    fi
    APK_OUT="$DIST/vani-ai-1.5.1-release.apk"
  fi
else
  echo "Android SDK or Gradle not found locally."
  echo "The GitHub Actions workflow (.github/workflows/build-apk.yml) performs the full APK build."
  echo "Continuing with source ZIP so the repo is fully reproducible."
fi

say "8/8 Source ZIP"
bash scripts/make-source-zip.sh
SRC_ZIP="$DIST/vani-ai-1.5.1-source.zip"

if [ "$NO_UPLOAD" = 0 ] && { [ -n "$APK_OUT" ] || [ -f "$SRC_ZIP" ]; }; then
  if have curl && curl -sf --max-time 8 https://api.gofile.io/servers >/dev/null 2>&1; then
    bash scripts/upload-gofile.sh ${APK_OUT:+"$APK_OUT"} "$SRC_ZIP" || echo "WARN: gofile upload failed"
  else
    echo "gofile.io unreachable from this environment; skipping upload (CI will publish artifacts)."
  fi
fi

say "Build summary"
[ -n "$APK_OUT" ] && { echo "APK:    $APK_OUT"; sha256sum "$APK_OUT"; }
[ -f "$SRC_ZIP" ] && { echo "Source: $SRC_ZIP"; sha256sum "$SRC_ZIP"; }
echo "Done."
