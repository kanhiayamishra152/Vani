## Vani AI v1.4.0 — reliable local conversations and voice

**Install in place — no uninstall.** v1.4.0 (`versionCode 5`) is signed with the same persisted `vani-v1.jks` keystore as earlier releases, preserving chats, settings and downloaded models.

### Local inference and honest telemetry
- GGUF inference remains on-device through llama.cpp. Multi-turn prompts include the persistent conversation history within the selected context budget, with native prefix/KV reuse where the prompt prefix matches.
- Completed replies report measured decode tok/s, ms/tok, request-to-first-token TTFT and generated token counts. Values are shown only when supplied by the runtime; no device throughput is promised.
- Per-model Think control, inline composer status and native Stop remain available.

### Chat and voice
- Message footer provides Play/Stop, Copy and Regenerate. Regeneration starts a new branch from the preceding user turn.
- Optional Auto-TTS speaks completed clauses while the response streams. Message audio uses the selected installed voice and reports configuration/playback errors.
- Dictation is one-shot and cancellable, preserves existing composer text, and reports listening/errors inline instead of using transient toasts.

### Live, downloads and lifecycle
- Live keeps the answer reader, history and keyboard above the avatar, with a subtle response typography layer behind it. No reply is invented when no model is loaded.
- Model and projector downloads share a cancellation group. Cancellation disconnects active transfers, removes partial files and prevents cancelled entries from being registered.
- Original `OC-Lily.vrm` bytes and the existing signing key are preserved. Background speech/capture cleanup and event-driven memory handling replace perpetual polling.

### Verification and install
CI runs unit, avatar-rig and headless-Chromium checks, native dependency/VRM audits, the genuine Ultra-Light TTS rehearsal, Android assembly, APK alignment and signature verification before publishing. Physical-device speed and rendering still depend on the phone and selected models.

Download `vani-ai-1.4.0-release.apk` and sideload it over the previous version. Install a GGUF model and, for offline voice, an ASR pack plus Phonon Ultra-Light from Model Hub.
