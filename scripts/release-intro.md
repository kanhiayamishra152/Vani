## Vani AI v1.5.2 — stability and lifecycle update

**Install in place — no uninstall required.** v1.5.2 (`versionCode 8`) is signed with the established `android/vani-v1.jks` identity. Downloaded models, chats and settings are preserved by an in-place update.

### Stability and performance

- Lifecycle-safe microphone, ASR/VAD, decoding, system TTS, LLM and Live Talk cleanup.
- Native Java/Kotlin/C++ exception containment and projector/multimodal ownership fixes.
- Bounded resumable downloads with strict Range/EOF validation and atomic model registry persistence.
- Frame-rate-aware avatar rendering, lower allocation churn and reliable Live WebGL reopen behavior.
- Responsive two-tier chat composer while retaining existing model, speech and Live features.

### Package verification

- Android `aapt` verifies package `ai.vani.app`, `versionCode 8`, versionName `1.5.2`, minimum Android 8.0 (API 26), target API 34 and native `arm64-v8a` support in the final APK.
- CI checks ZIP integrity, 4-byte alignment, extractable native libraries, the original uncompressed VRM, both v1/v2 signatures and the established signing certificate before publication.
- Unit, synthetic-rig and interactive browser checks must pass before the release is created.

### Installation

Download `vani-ai-1.5.2-release.apk` directly from this release. Avoid renaming or partially downloading the file, and compare its SHA-256 below before installing. The APK supports 64-bit ARM devices running Android 8.0 or later. Google Play Protect is a separate on-device service; its proprietary scan result is not claimed by CI.
