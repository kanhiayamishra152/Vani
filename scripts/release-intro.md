## Vani AI v1.5.2-test-b3b36de — physical-device test build

**Temporary test build; not a production release.** Install in place without uninstalling. `versionCode 8` distinguishes this APK from the earlier `versionCode 7` test package. It remains signed with the established `android/vani-v1.jks` identity so chats, settings and downloaded models can be preserved by an in-place update.

### Changes under test

- Lifecycle-safe microphone, ASR/VAD, decoding, system TTS, LLM and Live Talk cleanup.
- Native Java/Kotlin/C++ exception and ownership hardening.
- Bounded resumable downloads and atomic model registry persistence.
- Frame-rate-aware avatar rendering and robust Live WebGL reopen behavior.
- Responsive two-tier chat composer with the existing model, speech and Live features retained.

### Package verification

- The final APK must report package `ai.vani.app`, `versionCode 8`, versionName `1.5.2-test-b3b36de`, minimum Android 8.0 (API 26), target API 34 and native `arm64-v8a` support through Android `aapt`.
- CI checks ZIP integrity, 4-byte alignment, extractable native libraries, the original uncompressed VRM, both v1/v2 signatures and the established signing certificate before publication.
- Unit, synthetic-rig and interactive browser checks must pass before the APK is attached.

### Installation

Download `vani-ai-1.5.2-test-b3b36de.apk` directly from this release. Do not rename or partially download the file; compare its SHA-256 below before installing. The APK supports 64-bit ARM devices running Android 8.0 or later. Google Play Protect is a separate on-device service and its scan result is not claimed by CI.
