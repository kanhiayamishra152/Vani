## Vani AI v1.5.0 — native streaming and model-memory hardening

**Install in place — no uninstall.** v1.5.0 (`versionCode 6`) is signed with the same persisted `vani-v1.jks` keystore as earlier releases, preserving chats, settings and downloaded models.

### Critical fixes

- Repairs llama.cpp streaming when a chat template supplies an empty stop string; empty stops no longer suppress the first token.
- Buffers split UTF-8 code points safely and makes stop-string handling cursor-safe across token boundaries, including partial stop prefixes.
- Reports context-full, decode, and genuine no-text failures explicitly instead of silently leaving an empty response.
- Preserves formatted multi-turn prompts and validated KV-prefix reuse; unsafe cache state is invalidated after native decode failures.

### Strict model memory controls

- Separates **On disk** from **In RAM** throughout Model Hub and adds a Model memory section in Settings.
- Adds explicit **Unload** actions for the Main LLM, standalone TTS and standalone ASR. Unload releases native resources without deleting downloaded files.
- Allows one Main LLM, one standalone TTS and one standalone ASR; replacing a model releases its predecessor first.
- Loading **LFM3-Omni-2B** releases every other speech model before allocation, uses bounded mobile context/batch settings, and blocks competing model loads until Omni is unloaded.

### Voice runtime alignment

- Adds real native TTS/ASR residency reporting and explicit ASR model loading independent of microphone capture.
- Keeps an offline ASR model loaded when dictation stops; only Unload or Omni isolation releases it.
- Reuses a resident TTS model for speaker/rate changes and preserves cancellable **Preview Voice** playback.
- Aligns offline microphone startup with the native AudioRecord bridge and reports capture failures instead of falsely falling back to a successful session.
- Uses 700 ms VAD silence finalization and five-second offline speech segments for bounded dictation chunks.

### Verification

The CI run attached to this release builds the web bundle, runs unit, synthetic-rig and interactive browser checks, compiles native/Android components, signs with the existing v1 key, and verifies the resulting APK. Source-level and emulated checks do not constitute physical-device throughput or visual measurements.

Download `vani-ai-1.5.0-release.apk` and sideload it over the previous version. Install a GGUF model and, for standalone offline voice, an ASR pack plus Phonon Ultra-Light from Model Hub.
