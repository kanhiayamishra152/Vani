#!/usr/bin/env bash
# Vani AI — fresh v1.0.0 release signing key.
# Priority: existing keystore.properties > CI secrets (base64) > brand-new key.
# Never commit the keystore or passwords; CI uploads a generated key as a
# protected artifact so it can be stored as secrets for future updates.
set -euo pipefail
cd "$(dirname "$0")/.."

ANDROID_DIR="$(pwd)/android"
PROPS="$ANDROID_DIR/keystore.properties"
JKS="$ANDROID_DIR/vani-v1.jks"

if [[ -f "$PROPS" && -f "$JKS" ]]; then
  echo "[keystore] reusing existing android/vani-v1.jks"
  exit 0
fi

if [[ -n "${VANI_KEYSTORE_BASE64:-}" ]]; then
  echo "[keystore] restoring signing key from VANI_KEYSTORE_BASE64 secret"
  printf '%s' "$VANI_KEYSTORE_BASE64" | base64 -d > "$JKS"
  STOREPASS="${VANI_KEYSTORE_PASSWORD:?VANI_KEYSTORE_PASSWORD must accompany VANI_KEYSTORE_BASE64}"
  KEYPASS="${VANI_KEY_PASSWORD:-$STOREPASS}"
  ALIAS="${VANI_KEY_ALIAS:-vani-v1}"
else
  echo "[keystore] generating BRAND-NEW v1.0.0 release key (vani-v1.jks)"
  STOREPASS="${VANI_KEYSTORE_PASSWORD:-$(openssl rand -hex 16)}"
  KEYPASS="${VANI_KEY_PASSWORD:-$STOREPASS}"
  ALIAS="vani-v1"
  KEYTOOL_BIN="${KEYTOOL:-keytool}"
  "$KEYTOOL_BIN" -genkeypair -v \
    -keystore "$JKS" -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$STOREPASS" -keypass "$KEYPASS" \
    -dname "CN=Vani AI, OU=Mobile, O=Vani, L=New Delhi, C=IN"
fi

cat > "$PROPS" <<EOF
storeFile=vani-v1.jks
storePassword=$STOREPASS
keyAlias=$ALIAS
keyPassword=$KEYPASS
EOF
chmod 600 "$PROPS" "$JKS"
echo "[keystore] wrote android/keystore.properties (git-ignored)"
