# External sources & pinned artifacts

All model filenames and byte sizes below were verified against the upstream
file trees (Hugging Face API / GitHub Releases API) on **2026-11-03** and are
encoded verbatim in `web/js/catalog.js`. Models are downloaded on-device; they
are not committed to this repository.

## Runtime pins

| Component | Version | Source |
| --- | --- | --- |
| llama.cpp | `v0.8.0` | `github.com/ggml-org/llama.cpp` (codeload tarball) |
| sherpa-onnx Android AAR | `2.0.1` | `github.com/k2-fsa/sherpa-onnx` releases |
| silero VAD | `silero_vad.onnx` (643,854 B) | sherpa-onnx `asr-models` release |
| three.js | `0.170.0` | npm |
| @pixiv/three-vrm | `^3.4.0` | npm |
| KaTeX | `^0.16.11` | npm (CSS + woff2 bundled offline) |
| AGP / Gradle / Kotlin | 8.5.2 / 8.7 / 1.9.24 | |
| Android SDK / NDK / CMake | 34 / 27.0.12077973 / 3.22.1 | |

## Main models (GGUF)

### LiquidAI/LFM3-Omni-2B-GGUF (omni)
| Quant | File | Bytes |
| --- | --- | --- |
| Q4_0 | LFM3-Omni-2B-Q4_0.gguf | 1,049,617,920 |
| Q4_K_M | LFM3-Omni-2B-Q4_K_M.gguf | 1,099,630,080 |
| Q8_0 | LFM3-Omni-2B-Q8_0.gguf | 1,846,240,768 |
| F16 | LFM3-Omni-2B-F16.gguf | 3,466,628,608 |
| mmproj Q8_0 | mmproj-LFM3-Omni-2B-Q8_0.gguf | 506,842,528 |

No Q5_K_M is published for this model. Standard Download button — no runtime
upgrade gate or confirmation popup.

### unsloth/Qwen3.5-4B-GGUF (vision)
Q4_K_M 2,740,937,888 · Q5_K_M 3,143,656,608 · Q8_0 4,482,403,488 · mmproj-F16 672,423,616

### unsloth/gemma-4-E4B-it-GGUF (vision)
Q4_K_M 4,977,171,584 · Q5_K_M 5,481,798,784 · Q8_0 8,192,953,472 · mmproj-F16 990,372,672

### unsloth/Qwen3.5-2B-GGUF (vision)
Q4_K_M 1,280,835,840 · Q5_K_M 1,435,238,656 · Q8_0 2,012,012,800 · mmproj-F16 668,227,264

### unsloth/gemma-4-E2B-it-GGUF (text)
Q4_K_M 3,106,738,272 · Q5_K_M 3,356,037,216 · Q8_0 5,048,352,864 · mmproj-F16 985,654,080

### unsloth/Qwen3.5-0.8B-GGUF (text)
Q4_K_M 532,517,120 · Q5_K_M 590,057,728 · Q8_0 811,843,840 · mmproj-F16 204,987,232

## Supplementary voices (sherpa-onnx packs, `.tar.bz2`)

### TTS (`tts-models` release)
| Engine | File | Bytes |
| --- | --- | --- |
| Pocket TTS INT8 | sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2 | 98,336,520 |
| Pocket TTS FP16 | sherpa-onnx-pocket-tts-2026-01-26.tar.bz2 | 168,148,625 |
| Piper Lessac medium FP32 | vits-piper-en_US-lessac-medium.tar.bz2 | 67,230,653 |
| Piper Lessac medium INT8 | vits-piper-en_US-lessac-medium-int8.tar.bz2 | 20,969,179 |
| Kokoro multi-lang INT8 | kokoro-int8-multi-lang-v1_0.tar.bz2 | 132,353,410 |
| Kokoro multi-lang FP32 | kokoro-multi-lang-v1_0.tar.bz2 | 349,886,476 |

Phonon ultra-light TTS is a built-in JS formant engine (0 MB download).

### ASR (`asr-models` release)
| Engine | File | Bytes |
| --- | --- | --- |
| Whisper Tiny (multilingual) | sherpa-onnx-whisper-tiny.tar.bz2 | 116,204,861 |
| Whisper Base (multilingual) | sherpa-onnx-whisper-base.tar.bz2 | 207,557,382 |
| silero VAD | silero_vad.onnx | 643,854 |

> The multilingual sherpa-onnx Whisper tarballs bundle encoder + decoder +
> tokens + espeak data, so their on-disk size is larger than the bare ONNX
> weights quoted elsewhere. The catalog shows the real download sizes.

## Avatar

OC-Lily.vrm — Google Drive file ID `1vyE1GP6k7cRSoHBW_n8YTmpMBNMajByw`,
fetched by `scripts/fetch-vrm.mjs` (handles the Drive virus-scan confirm
token). Only textures larger than 1024px are downscaled; all meshes, the beret,
sailor dress, blendshapes, spring bones and MToon materials are preserved. The
VRM is stored uncompressed in APK assets and served via `WebViewAssetLoader`.
