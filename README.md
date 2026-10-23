# Vani AI

An on-device, fully-offline AI voice assistant for Android. No cloud API calls for
inference — the LLM, the speech recogniser and the text-to-speech engine all run on the
phone, in native code.

```
                 ┌─────────────────────────────────────────────┐
   microphone ─▶ │  VAD (Silero)  ─┐                            │
                 │                 ├─▶ LLM (llama.cpp) ─▶ TTS   │
   speaker    ◀─ │  STT (sherpa-onnx) ─┘  (ONNX Runtime)        │
                 └─────────────────────────────────────────────┘
```

---

## 1. What is in here

| Layer | Engine | Language |
|---|---|---|
| LLM inference | llama.cpp (LFM 2.5 350M, Qwen 3.5 0.8B) | C++ via JNI |
| Speech recognition | sherpa-onnx streaming ASR | C++ via JNI |
| Voice activity detection | sherpa-onnx / Silero VAD | C++ via JNI |
| Text to speech | sherpa-onnx offline TTS (ONNX Runtime, CPU) | C++ via JNI |
| App, UI, pipeline | Kotlin + Jetpack Compose | Kotlin |
| Model downloads | OkHttp | Kotlin |

Two native libraries only — `llama.cpp` and `sherpa-onnx` — both pulled in as pinned
git submodules (see `.gitmodules`). sherpa-onnx supplies all three audio engines, which
means one `.so` and one copy of ONNX Runtime rather than a separate ONNX Runtime JNI
layer.

---

## 2. Build

Prerequisites: JDK 17, Android SDK with `compileSdk 34` and NDK `26.3.11579264`,
CMake `3.22.1`.

```bash
# 1. Fetch the pinned native sources (llama.cpp + sherpa-onnx).
git submodule update --init --recursive

# 2. Build.
./gradlew :app:assembleDebug      # unsigned debug APK
./gradlew :app:assembleRelease    # signed release APK (needs keystore.properties)
```

For a release build, create `keystore.properties` (gitignored) next to `build.gradle.kts`:

```properties
storeFile=release.jks
storePassword=...
keyAlias=vani
keyPassword=...
```

There is also `scripts/build_apk.sh`, which wires the wrapper, the submodules and the
APK location together.

### Verified build targets

- `minSdk 29` (Android 10), `targetSdk 34`, **arm64-v8a only**
- Release builds are R8-minified with `proguard-rules.pro`

---

## 3. The self-test

**Settings → Run hardware self-test.**

This exists because the APK has to be validated on a real device by someone who did not
build it. Tapping it:

1. downloads the default 229 MB LLM (LFM 2.5 350M Q4_K_M),
2. loads it into memory through llama.cpp,
3. generates **exactly 8 tokens**,
4. prints `SELF-TEST PASSED` or `SELF-TEST FAILED: <stage> <reason>` on screen and in
   logcat (`adb logcat -s VaniSelfTest`).

It is deliberately end-to-end rather than mocked: it is the only way to prove that the NDK
build, the JNI bridge, the scoped-storage path and the model downloader all work on the
actual hardware, because those are exactly the things that fail silently otherwise.

---

## 4. Model Hub

Models are downloaded from Hugging Face into app-scoped storage
(`getExternalFilesDir`), so no storage permission is requested and uninstalling reclaims
the space.

The first screen **defaults to English only**: the default LLM, STT and TTS are all
English and render first. Multilingual and Hindi models are present but never
pre-selected.

Default stack:

| Role | Model |
|---|---|
| LLM | Liquid AI LFM 2.5 350M Q4_K_M |
| STT | Whisper Tiny (English) |
| TTS | Kitten TTS (English) |
| VAD | Silero |

Also available: Qwen 3.5 0.8B, Qwen 3 4B Multilingual, Parakeet TDNN, Whisper Large v3
Multilingual, Phonon 31M.

### ⚠️ Hugging Face URLs and hashes need confirming

Hugging Face was **not reachable** from the environment this project was authored in, so
the `repo`/`filename` values in `ModelCatalog` are the correct upstream locations as
written but have not been byte-verified end-to-end.

Every model carries a `sha256` field for exactly this reason. Set it to the digest printed
on the model's Hugging Face page and Vani will refuse to install a file whose hash does
not match. Left `null`, the downloader degrades to a strict size check rather than failing.

The downloader *does* verify SHA-256 whenever a digest is supplied, and the Settings
screen offers a "record hash" action for filling the value in from a verified download.

### Downloader correctness

The previous build failed to download GGUF models. Two causes, both fixed explicitly in
`ModelDownloader`:

1. **Redirects.** Hugging Face answers `resolve/main/<file>` with a `302` to a CDN host.
   The OkHttp client is configured with `followRedirects(true)` **and** `followSslRedirects(true)`,
   and the file body is fetched through an explicit redirect loop — because OkHttp drops
   some request headers when it rebuilds a redirect request, and a dropped `Range` header
   silently breaks resume. Driving the hops ourselves guarantees the `Range` header reaches
   the CDN.
2. **User-Agent.** The HF CDN returns `403` for clients that identify as `curl/x` or send
   no UA. Every request, including every redirect hop, carries a standard Android UA.

Plus: HTTP `Range` pause/resume against a `.part` sidecar, `416` restart, HTML error-page
detection, and size + SHA-256 verification.

**Verified.** `tools/verify_downloader.py` runs the downloader algorithm against a local
mock Hugging Face CDN that reproduces all of these behaviours:

```
$ python3 tools/verify_downloader.py
[1] Full download through a 302 redirect to the CDN         PASS
[2] User-Agent is sent on every hop                         PASS
[3] HTTP Range resume from a .part sidecar (206 append)     PASS
[4] 416 restarts the download cleanly                       PASS
[5] SHA-256 mismatch is detected and the file is rejected   PASS
[6] Hugging Face's HTML error page is detected              PASS
RESULT: 10 passed, 0 failed
```

`app/src/test/.../ModelDownloaderTest.kt` covers the same cases against OkHttp
MockWebServer for CI.

---

## 5. The orb

ChatGPT-voice style: deep black `#0D0D0D` field, soft white/blue orb, Inter/Roboto type.
**No neon pink or cyan gradients.**

Four states, crossfaded:

| State | Motion |
|---|---|
| IDLE | slow calm breathing |
| LISTENING | energetic rippling |
| THINKING | swirling, contained |
| SPEAKING | active pulsing |

Barge-in: if the user speaks while Vani is talking, the SPEAKING animation stops, the
LISTENING animation fades in, and the audio cuts off immediately.

### Animation assets

The spec asked for pre-rendered animations rather than real-time GPU shaders, and named
Lottie JSON, WebM or MP4 as acceptable. **Lottie JSON is used**: it is listed as
acceptable, it is text (so it reviews in a diff and adds no binary weight), and it needs no
asset-packaging step.

They are generated, not hand-written — `tools/generate_orb_animations.py` builds all four
and asserts each is **loop-seamless** (first keyframe value == last) and structurally valid.
Only the visible animation plays, so the worst case is two decoders, not four.

```bash
python3 tools/generate_orb_animations.py
```

`OrbController` is the single seam where a hardware-decoder video path (WebM/MP4) would
slot in if preferred.

---

## 6. The conversation pipeline

Stages overlap on purpose, which is what makes it feel conversational rather than serial:

1. **STT** streams partial transcripts to the UI while the user is still talking.
2. **VAD** detects end-of-speech — no fixed timeout, which is what makes barge-in feel
   instant rather than laggy.
3. **LLM** streams tokens; each token is appended to the message as it arrives.
4. **SentenceSplitter** emits complete sentences, and **TTS** synthesises and plays each
   one *while the LLM is still generating the next*.
5. **Barge-in**: the mic never closes during TTS, so the user speaking is a state flip,
   not a restart.

---

## 7. Project layout

```
app/src/main/cpp/vani_jni.cpp      JNI bridge (written against verified upstream headers)
app/src/main/cpp/CMakeLists.txt    native build
app/src/main/java/ai/vani/
  engine/    llama.cpp + sherpa-onnx wrappers (STT, VAD, TTS)
  model/     catalogue, downloader, scoped-storage paths
  voice/     state machine, sentence splitter, audio player, pipeline
  selftest/  one-tap hardware verification
  ui/        Compose screens, orb, theme
app/src/main/assets/animations/    4 Lottie orb animations
app/src/test/                       downloader unit tests
tools/                             downloader verifier + animation generator
```

---

## 8. Verification status

Be explicit about what was and was not verified, because the difference matters.

**Verified in this environment:**

- Downloader algorithm — 10/10 assertions against a mock Hugging Face CDN
- Orb animation assets — loop-seamless and structurally valid
- JNI bridge — written against the actual upstream headers (llama.cpp
  `4231b23`, sherpa-onnx `v2.0.0`), not from recollection

**Not verified — needs a device or a JDK:**

- Compilation. No JDK, Gradle, Android SDK or NDK in the authoring environment, and the
  Google Maven / Maven Central hosts are unreachable, so the APK could not be built here.
- Kotlin and C++ sources are complete but uncompiled.
- End-to-end audio on a real device.

The C++ bridge targets two API details that differ from older code and will not compile if
ported blindly: sherpa-onnx v2.0.0 renamed its streaming ASR entry points, and llama.cpp's
KV cache is now addressed through `llama_memory_t`. Both are documented at the top of
`vani_jni.cpp`.

---

## 9. Repository

`kanhiayamishra152/Vani`, branch `arena/d9bcdbe6-vani`.

The spec asked for a repository named `Vani-AI`; the token configured for this session has
no repository-creation scope, so the work is pushed to the existing `Vani` repository
instead. Renaming or mirroring it is a one-line follow-up once a token with `repo` scope is
available.
