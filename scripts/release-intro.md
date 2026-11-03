## Vani AI v1.2.0 — full-quality avatar, real voices, persistent models, unbreakable downloads

This release addresses every issue from the on-device v1.0.1 test session (Poco M6 Plus 5G): the blurry avatar, the black screen on the second Live open, the fake "Phonon" voice, models vanishing between launches, downloads stalling at 98% / "100% extracting…", and Live Talk hanging on "Thinking…".

**Install in place — no uninstall.** v1.2.0 is signed with the *same* persisted keystore as v1.0.1 (`versionCode 3`), so it updates directly over v1.0.1 and keeps your chats, settings and downloaded models.

### 1 · OC-Lily avatar — 100% original, full quality
- **Zero compression.** The texture-downscale / re-encode pipeline is removed; the owner's original `OC-Lily-Neural4D-AnimeArt.vrm` is bundled byte-for-byte (the CI optimize step is gone). No geometry merging either.
- **Crisp render:** `antialias:true`, `pixelRatio = min(devicePixelRatio, 2.0)`, sRGB output, MToon shading + outlines, and **max anisotropic filtering** on every texture.
- **OrbitControls:** one-finger orbit + two-finger pinch zoom, damped (0.08), target at the chest, zoom clamped 1.2–3.8 m.
- **Rest pose fixed:** arms rest ~14° outside the torso/skirt with elbows slightly forward so hands never clip; the 12 `/anime` actions were refined to avoid self-intersection.
- **No more black screen:** the stage is a persistent singleton — closing Live **pauses** it, opening **resumes** it; the WebGL context is never force-lost.
- Tapping an action in the `/anime` sheet now performs the gesture **only** — it no longer writes `/anime …` bubbles into your chat.

### 2 · Models that stay put
- Everything (catalog, custom-URL and local-imported) lives in `filesDir/models/` with a persisted registry **plus a startup disk scan** that reconciles any `.gguf` / `.onnx` / voice files back into the Hub — nothing disappears between launches.
- A top **"Downloaded / Installed"** section in Models → All lists every installed model with **Use / Active** and **Delete**, alongside its category card.
- The **last active model auto-reloads** on launch.
- Added **LFM2.5-350M** and **LFM2.5-1.2B-Instruct** (Liquid AI) as first-class Main Models next to LFM3-Omni-2B.

### 3 · Phonon is a real voice now
- Phonon is a genuine downloadable **4-voice neural pack** (Piper VCTK multi-speaker, int8, **~22.3 MB** — an honest size; no real 8.4 MB multi-speaker pack exists). Live progress, pause/cancel, persistent install.
- **4-voice selector + Preview** on the card *and* in Settings → Live Talk: **Vani/Aria** (warm female), **Nova/Meera** (expressive female), **Orion/Aarav** (deep male), **Echo/Kabir** (crisp male).
- Voice selectors + preview also for **Pocket TTS 100M** and **Kokoro-82M** (incl. Hindi `hf_alpha` / `hm_omega`).

### 4 · Downloads that finish + 7 ASR engines
- The 98% / "100% extracting…" stall and broken Resume-at-100% are fixed: standalone `.onnx` models install with **no extraction**, archives **stream-extract with live progress**, and finalize is **idempotent** — at 100% a model becomes **Installed → Activate / Delete**, never "Resume".
- **Seven ASR options:** Whisper Tiny / Base / Small (multilingual, int8 standalone), Moonshine Tiny / Base (fast English), SenseVoice Small (multilingual + emotion), and Zipformer (streaming-fast English).
- **Add TTS/ASR by Hugging Face URL or repo** and **Import local `.onnx` / `.bin` / `.gguf`** (multi-file) right inside the Supplementary tab.

> Honest notes: real int8 sizes are shown (e.g. Whisper Tiny ≈ 99 MB, Moonshine Base ≈ 106 MB). There is no official EN/HI bilingual Zipformer, so the Zipformer slot ships the real fast **English** model — Hindi is covered by Whisper and SenseVoice.

### 5 · Live Talk never hangs
- End-to-end Mic/STT → loaded GGUF → active TTS (Phonon / Kokoro / system fallback) → OC-Lily lip-sync. A **watchdog** re-arms on every token and recovers if generation ever goes silent; the **first complete sentence is dispatched to speech immediately** for the fastest possible first words.

### Verified
Automated headless-Chromium interactive tests click every control and assert state transitions (not just DOM existence), plus the unit suite. Built and signed by GitHub Actions with the persisted v1 keystore.

### Install
Download `vani-ai-1.2.0-release.apk` and sideload over v1.0.1 (in-place update). Open Model Hub, grab a model (e.g. **LFM2.5-350M Q4_K_M**), tap **Load Model**, then chat or start Live Talk. Install the **Phonon Voice Pack** and an ASR model from Supplementary for the full offline voice loop.
