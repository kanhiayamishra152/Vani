# Vani AI — Architecture

## Process model

A single `MainActivity` hosts an Android `WebView` that loads the entire UI
from `https://appassets.androidplatform.net/assets/www/index.html` via
`androidx.webkit.WebViewAssetLoader`. Loading from a stable HTTPS origin (not
`file://`) gives the web app a secure context for `AudioWorklet`,
`getUserMedia`, and ES modules, while keeping every asset local and offline.

All native capability is exposed through **one** JavaScript interface,
`window.VaniNative.invoke(method, argsJson, callbackId)`. Calls are JSON in /
JSON out; results resolve a promise and asynchronous activity (tokens,
download progress, speech levels) is pushed back with
`window.__vaniEmit(event, payloadJson)`.

```
web/js/bridge.js  ── invoke ──►  Bridge.java (dispatch switch)
        ▲                              │
        └──── __vaniEmit ◄── MainActivity.emit / resolve
```

## Native engines

| Engine | Language | Backend | Responsibility |
| --- | --- | --- | --- |
| `LlmEngine` | Java + C++ JNI | llama.cpp `v0.8.0` + `mtmd` | GGUF load/unload, chat-template rendering, prefix KV-cache reuse, streaming generation, vision via mmproj bitmaps, instant stop |
| `SpeechEngine` | Kotlin | sherpa-onnx `2.0.1` | silero VAD, Whisper ASR, neural TTS (Pocket / Piper VITS / Kokoro), system speech fallbacks, native barge-in |
| `DownloadService` | Java | HttpURLConnection + commons-compress | Foreground resumable downloads (HTTP `Range`), notifications, `.tar.bz2` extraction, model registration |

### Inference (`vani_llama.cpp`)

- CPU-only GGML, `arm64-v8a`, `n_gpu_layers = 0`, `mmap` load mode.
- Chat prompts are rendered with llama.cpp's `common_chat_templates` (Jinja),
  so each model's native template + thinking control is honored.
- A **prefix KV cache** keeps the longest common token prefix between turns
  and only decodes the suffix (`llama_memory_seq_rm` + batched decode).
- Vision: image data URLs are base64-decoded into `mtmd` bitmaps; the prompt's
  image markers are replaced with `mtmd_default_marker()` and evaluated with
  `mtmd_helper_eval_chunks`.
- Token pieces are buffered and emitted only on complete UTF-8 boundaries so
  CJK / emoji never stream as broken bytes.
- `nativeStop` flips an atomic flag checked every token — this is what makes
  Live Talk barge-in feel instant.

### Speech (`SpeechEngine.kt`)

- **Barge-in is native:** the instant silero VAD reports speech, the playing
  `AudioTrack` is stopped on the VAD thread (well under 50 ms), before any JS
  round-trip. JS is then notified to halt generation.
- TTS streams float PCM from `generateWithCallback` into an `AudioTrack` and
  emits RMS levels for avatar visemes. The callback returns `0` to cancel.
- ASR: VAD segments are decoded by Whisper; Hold-to-Talk buffers PCM and
  decodes on release. Android `SpeechRecognizer` / `TextToSpeech` are fallbacks
  when no neural model is installed.
- Mic constraints are `echoCancellation: false, noiseSuppression: true` to
  avoid Android's "Recording call" banner.

## Web app

Vanilla ES modules bundled by esbuild into a single offline IIFE (`app.js`).
`three.js` + `@pixiv/three-vrm` render the OC-Lily avatar **only** while Live
Talk is open; the renderer, RAF loop and audio worklets are created on open and
fully disposed on close or app background. `setPixelRatio(min(dpr, 1.25))`,
`dt = min(clock.getDelta(), 0.05)`, 60 FPS active → 24–30 FPS idle, with a
Battery Saver toggle. KaTeX (CSS + woff2 bundled) renders math offline.

State lives in `localStorage` (`vani.v1.*`): threads, prompts, settings. No
network calls except explicit model downloads.

## Performance guardrails

- WebGL never runs on Chat / Models / Settings tabs.
- `app.background` (native or `visibilitychange`) suspends rendering + audio.
- Model downloads run in a foreground service with a partial wake lock and
  resume from the exact `.part` byte offset after any interruption.

## Build pipeline

`scripts/fetch-native-deps.mjs` pins llama.cpp + sherpa-onnx + silero VAD.
`scripts/fetch-vrm.mjs` + `prepare-vrm-safe.mjs` fetch the avatar from Drive and
validate the self-contained GLB without changing a single byte (textures,
meshes, morphs, spring bones and MToon materials remain original). Runtime
DPR/MSAA caps and the native memory watchdog handle device pressure without
lossy asset preprocessing. `scripts/build-web.mjs` bundles the web app into
Android assets. Gradle + CMake build the native libraries and APK; CI signs
with the persisted `vani-v1.jks`, aligns, verifies, and publishes Release v1.5.0.
