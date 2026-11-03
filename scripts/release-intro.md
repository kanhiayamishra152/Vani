## Vani AI v1.3.0 — anti-freeze overhaul, faster replies, per-model thinking

**Install in place — no uninstall.** v1.3.0 (`versionCode 4`) is signed with the same persisted `vani-v1.jks` keystore as earlier releases, so it updates directly over v1.2.0 while preserving chats, settings and downloaded models.

### Stability and avatar
- Native CrashGuard samples memory and the WebView heartbeat every second. It releases heavy native/GPU resources under pressure and cleanly exits before a sustained critical freeze can lock up the phone.
- Original OC-Lily is preserved byte-for-byte: no texture downscaling, re-encoding or geometry-changing optimization. Rendering uses capped DPR, no MSAA and asynchronous loading/shader compilation.
- World-space axis calibration and arm IK fix forward bow, backward knee flexion, namaste palm contact and wave gestures across VRM axis conventions.

### Faster, controllable chat
- Batched native token delivery, 512-token batches, flash attention and quantized KV cache reduce streaming overhead. Completed replies show tok/s and TTFT when supplied by the runtime.
- **Per-model thinking:** tap the **Think triangle** in the composer. Every loaded model remembers its own ON/OFF preference. OFF sends `enableThinking=false` plus a direct-answer instruction; reasoning display remains a separate setting.
- **Send becomes Stop** during generation. Stop calls native cancellation and returns to Send when the turn ends.
- Reasoning traces use an explicit rotating triangle in a collapsible Thinking card.

### Live Talk and voice
- Floating live answer card, tap-to-expand Markdown/KaTeX reader with Copy / Copy Code, slide-over Chat History, and an in-Live keyboard dock for text and `/anime` commands.
- Unified native 16 kHz microphone capture with runtime permission handling and a single mic consumer; Android SpeechRecognizer remains the fallback.
- **Phonon Ultra-Light 8M:** a genuine Paradee-8M v1.2 INT8 pack with four learned voices — Aria/Vani, Meera/Nova, Aarav/Orion and Kabir/Echo. The archive is hard-gated below 9 MiB and includes Preview Voice on the card and in Settings. The larger Phonon Studio pack remains optional. [Download the verified TTS pack](https://github.com/kanhiayamishra152/Vani/releases/download/phonon-ultralight-v1/phonon-ultralight-8m-int8.tar.bz2).
- On-demand vision projector attach/detach returns memory after multimodal turns.

### Security and verification
- Asset-origin-only native bridge, HTTPS/host-checked downloads with redirect validation, canonical path containment, safe archive extraction and strict Markdown/KaTeX handling.
- CI runs unit tests, synthetic world-space animation assertions, headless-Chromium interaction tests, read-only original-VRM audits, and an ONNX + sherpa-onnx smoke test for all four Ultra-Light voices before assembling the APK.

### Install
Download `vani-ai-1.3.0-release.apk` and sideload it over v1.2.0. Open Model Hub, install and load a GGUF model, then chat or start Live Talk. Install **Phonon Ultra-Light 8M** and an ASR model from Supplementary for the offline voice loop.
