## Vani AI v1.0.0

Standalone on-device AI companion for Android (arm64-v8a, minSdk 26). Target: Poco M6 Plus 5G (Snapdragon 4 Gen 2, Adreno 613, 8 GB RAM, HyperOS).

**Install:** download `vani-ai-1.0.0-release.apk`, enable "Install unknown apps", and sideload. First launch: open Model Hub, download a model (e.g. Qwen3.5-0.8B Q4_K_M), tap Load Model, then chat or start Live Talk.

- **Chat** — local GGUF inference (llama.cpp v0.8.0), vision via mmproj, offline KaTeX math, code copy cards, threaded history, System Prompt Studio
- **Live Talk** — OC-Lily VRM avatar, hands-free VAD + Hold-to-Talk, sub-50 ms native barge-in, viseme lip-sync, 12 /anime gestures
- **Model Hub** — curated catalog with exact sizes, resumable native downloads (HTTP Range) + notifications, add-by-URL / local import
- **Settings** — live RAM/GPU telemetry, context + thread pickers, sampling controls, Battery Saver
- Pure monochrome design, zero cloud dependencies, zero emojis. Speech via sherpa-onnx 2.0.1 (Whisper ASR + neural TTS).
