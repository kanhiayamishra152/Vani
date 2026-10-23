#!/usr/bin/env bash
#
# Build Vani's APKs.
#
# Wraps the three things that are easy to get wrong: the Gradle wrapper, the native
# submodules, and the release keystore.
#
set -euo pipefail

cd "$(dirname "$0")/.."

VARIANT="${1:-both}"          # debug | release | both
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

# --- 1. Gradle wrapper ------------------------------------------------------
if [ ! -x ./gradlew ]; then
  if command -v gradle >/dev/null 2>&1; then
    echo ">>> Generating Gradle wrapper"
    gradle wrapper --gradle-version 8.10.2
  else
    echo "ERROR: ./gradlew is missing and no system 'gradle' was found."
    echo "Install a JDK 17 and either run 'gradle wrapper' once, or add the wrapper jar."
    exit 1
  fi
fi

# --- 2. Native submodules ---------------------------------------------------
if [ ! -d app/src/main/cpp/third_party/llama.cpp ] || \
   [ ! -d app/src/main/cpp/third_party/sherpa-onnx ]; then
  echo ">>> Fetching native submodules (llama.cpp, sherpa-onnx)"
  git submodule update --init --recursive --depth 1
fi

# --- 3. Release signing -----------------------------------------------------
if [ "$VARIANT" = "release" ] || [ "$VARIANT" = "both" ]; then
  if [ ! -f keystore.properties ]; then
    cat >&2 <<'EOF'

WARNING: keystore.properties not found - building the release APK UNSIGNED.

Create it next to build.gradle.kts with:

  storeFile=release.jks
  storePassword=<password>
  keyAlias=vani
  keyPassword=<password>

The debug APK is not affected and can be built without a keystore.

EOF
  fi
fi

# --- 4. Build --------------------------------------------------------------
echo ">>> Building (variant: $VARIANT, jobs: $JOBS)"
if [ "$VARIANT" = "debug" ]; then
  ./gradlew :app:assembleDebug --no-daemon -Pkotlin.daemon.jvmargs=-Xmx2g
elif [ "$VARIANT" = "release" ]; then
  ./gradlew :app:assembleRelease --no-daemon -Pkotlin.daemon.jvmargs=-Xmx2g
else
  ./gradlew :app:assembleDebug :app:assembleRelease --no-daemon -Pkotlin.daemon.jvmargs=-Xmx2g
fi

# --- 5. Report -------------------------------------------------------------
echo
echo ">>> Built artefacts:"
ls -lh app/build/outputs/apk/*/ 2>/dev/null | grep -E '\.apk' || echo "  (none)"
echo
echo ">>> Done. Install with:"
echo "    adb install -r app/build/outputs/apk/debug/app-debug.apk"
