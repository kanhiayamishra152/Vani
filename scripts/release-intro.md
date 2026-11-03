## Vani AI v1.5.1 — installer compatibility hotfix

**Install in place — no uninstall required.** v1.5.1 (`versionCode 7`) contains every v1.5.0 feature and is signed with the exact tracked `android/vani-v1.jks` identity. Downloaded models, chats and settings are not removed by the update.

### Install/package fixes

- Uses conservative extractable JNI-library packaging for Android and MIUI package installers; `extractNativeLibs=true` is verified in the final binary manifest.
- Uses both JAR/v1 and APK Signature Scheme v2 signatures with the established certificate. CI rejects any certificate mismatch instead of publishing an incompatible update.
- Validates the final APK with Android `aapt`: package `ai.vani.app`, versionCode 7, versionName 1.5.1, minimum Android 8.0 (API 26), target API 34 and native `arm64-v8a` support.
- Checks ZIP CRCs, 4-byte alignment, native-library compression, v1/v2 signatures and original-VRM storage before release publication.
- Keeps the original `OC-Lily.vrm` uncompressed and preserves all inference, model-memory, Omni, TTS/ASR, Live Talk and avatar behavior from v1.5.0.

### v1.5.0 fixes retained

- Empty stop strings no longer suppress the first token; split UTF-8 output and stop prefixes are buffered safely.
- Explicit file-preserving LLM/TTS/ASR unload controls and real On disk versus In RAM state.
- One Main LLM plus one standalone TTS and ASR, with full Omni isolation before allocation.
- Reliable native microphone startup, cancellable Preview Voice and clause-by-clause streaming speech.
- Existing battery-saver FPS controls, background audio teardown and native lifecycle protections remain enabled.

### Verification and installation

CI compiles the native/Android app, runs unit, synthetic-rig and 110 interactive checks, parses the final APK with Android tooling, verifies its signature against the tracked key, and publishes only after all gates pass. Google Play Protect is a separate on-device service; its proprietary scan cannot be run or guaranteed by this repository's CI.

Download `vani-ai-1.5.1-release.apk` directly from this release. Avoid renaming or partially downloading the file, and compare its SHA-256 below before installing. The APK supports 64-bit ARM devices running Android 8.0 or later.
