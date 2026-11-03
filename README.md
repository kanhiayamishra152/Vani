# Vani AI

**A standalone, on-device AI companion for Android.** Chat with local GGUF
models, talk to an expressive VRM avatar, and download everything straight to
your phone — no cloud, no accounts, no telemetry.

- **Package:** `ai.vani.app` · **Version:** 1.0.1 (versionCode 2)
- **Target device:** Poco M6 Plus 5G (Snapdragon 4 Gen 2, Adreno 613, 8 GB RAM, HyperOS)
- **ABI:** `arm64-v8a` · **minSdk:** 26 (Android 8.0) · **targetSdk:** 34

---

## What's inside

| Module | Highlights |
| --- | --- |
| **Chat** | Local llama.cpp inference, vision (mmproj), offline KaTeX math, code cards with copy, threaded history, System Prompt Studio, image/camera attach, `/anime` commands |
| **Live Talk** | OC-Lily VRM avatar with cinematic walk-in, hands-free VAD + Hold-to-Talk, sub-50 ms barge-in, viseme lip-sync, 12 `/anime` gestures, floating code/math overlay |
| **Model Hub** | Curated GGUF + voice catalog, exact file sizes, quant pickers, resumable native downloads (HTTP `Range`) with notifications, add-by-URL / local import |
| **Settings** | Live RAM/GPU telemetry, context + thread pickers, flash attention, sampling controls, VAD sensitivity, Battery Saver / FPS target |

The entire UI is a pure-monochrome WebView (`#000000` canvas, white CTAs,
`#EF4444` reserved for destructive actions). WebGL runs **only** during Live
Talk and is fully suspended on close or background.

## Architecture

```
WebView (https://appassets.androidplatform.net/assets/www/)
  ├─ web/js/*            vanilla ES modules, esbuild → single IIFE
  ├─ three.js + @pixiv/three-vrm   avatar (Live Talk only)
  └─ KaTeX               offline math
        │  window.VaniNative  (JSON bridge)
        ▼
Android (Java/Kotlin)
  ├─ MainActivity / Bridge         WebView + asset loader + permissions
  ├─ LlmEngine  ──JNI──►  vani_llama.cpp ──► llama.cpp + mtmd (vision)
  ├─ SpeechEngine (Kotlin) ──► sherpa-onnx (silero VAD + Whisper + neural TTS)
  └─ DownloadService               foreground, resumable, notifications
```

Native inference is CPU-only (GGML) and tuned for the Snapdragon 4 Gen 2.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and
[`docs/EXTERNAL_SOURCES.md`](docs/EXTERNAL_SOURCES.md) for pinned model sizes.

## Build

### GitHub Actions (primary)

Pushing to `main` (or running **Build Vani AI APK** manually) executes
[`.github/workflows/build-apk.yml`](.github/workflows/build-apk.yml):

1. Fetch pinned native runtimes (llama.cpp `v0.8.0`, sherpa-onnx `2.0.1`, silero VAD)
2. Fetch + texture-optimize the OC-Lily VRM from Drive
3. Generate icons, bundle the web app, sign with a fresh `vani-v1.jks`
4. `assembleRelease` → `zipalign` → `apksigner verify`
5. Upload the APK + source ZIP as artifacts and publish **Release v1.0.1**

To reuse a fixed signing key across builds, add repository secrets
`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD`, `KEY_ALIAS`.
Without them, CI generates a fresh v1 keystore each run.

### Local

```bash
npm ci
./android/build-apk.sh
```

This builds the web bundle, prepares native deps + avatar + icons, signs a
fresh keystore, and (when an Android SDK + Gradle are present) assembles,
aligns, and verifies `dist/vani-ai-1.0.1-release.apk`, then packages
`dist/vani-ai-1.0.1-source.zip`. Without an SDK it still produces the source
ZIP and reports that the APK step runs in CI. Flags: `--skip-native`,
`--skip-vrm`, `--no-upload`.

> The VRM avatar and model weights are fetched at build time and are **not**
> committed to the repository. The APK ships the avatar (stored uncompressed);
> GGUF / voice models download on-device from the Model Hub.

## First run

1. Install the APK (allow "Install unknown apps").
2. Open **Model Hub**, pick a model (e.g. **Qwen3.5-0.8B Q4_K_M**, ~508 MB),
   tap **Download**, then **Load Model**.
3. Chat. For voice, install a TTS + Whisper from the **Supplementary** tab.
4. Open **Live Talk** — OC-Lily walks in, waves, and listens.

No model loaded? Chat shows an empty state with **Browse Model Hub** — Vani
never fabricates replies.

## License

MIT — see [`LICENSE`](LICENSE). Third-party components retain their own
licenses (llama.cpp MIT, sherpa-onnx Apache-2.0, three.js MIT, KaTeX MIT,
Piper/Kokoro/Whisper model licenses as published by their authors).
