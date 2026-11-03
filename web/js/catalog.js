// Vani AI — 2026 frontier model catalog.
// Every filename + byte size below was verified against the upstream repo
// file tree (Hugging Face API / GitHub Releases API).
const HF = (repo, file) => `https://huggingface.co/${repo}/resolve/main/${file}?download=true`;
const GH_TTS = name => `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${name}`;
const GH_ASR = name => `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${name}`;

export const MAIN_MODELS = [
  {
    id: 'lfm3-omni-2b', cat: 'omni', title: 'LFM3-Omni-2B', repo: 'LiquidAI/LFM3-Omni-2B-GGUF',
    desc: 'Liquid AI any-to-any omni model — speech, vision and text in one 2B network. The recommended Live Talk voice model.',
    badges: ['Omni', 'Speech + Vision', '128K ctx'], ram: '~2.2 GB RAM',
    quants: {
      Q4_0:   { file: 'LFM3-Omni-2B-Q4_0.gguf',   size: 1049617920 },
      Q4_K_M: { file: 'LFM3-Omni-2B-Q4_K_M.gguf', size: 1099630080 },
      Q8_0:   { file: 'LFM3-Omni-2B-Q8_0.gguf',   size: 1846240768 },
      F16:    { file: 'LFM3-Omni-2B-F16.gguf',    size: 3466628608 },
    },
    defaultQuant: 'Q4_K_M',
    mmproj: { file: 'mmproj-LFM3-Omni-2B-Q8_0.gguf', size: 506842528, label: 'Vision / audio projector' },
    url(q) { return HF(this.repo, this.quants[q].file); },
    mmprojUrl() { return HF(this.repo, this.mmproj.file); },
  },
  {
    id: 'lfm25-350m', cat: 'text', title: 'LFM2.5-350M', repo: 'LiquidAI/LFM2.5-350M-GGUF',
    desc: 'Liquid AI ultra-fast 350M hybrid model. Instant loads and snappy replies on budget phones — ideal for Live Talk.',
    badges: ['Text / Reasoning', 'Ultra-light', 'Fast'], ram: '~0.8 GB RAM',
    quants: {
      Q4_0:   { file: 'LFM2.5-350M-Q4_0.gguf',   size: 219309792 },
      Q4_K_M: { file: 'LFM2.5-350M-Q4_K_M.gguf', size: 229312224 },
      Q5_K_M: { file: 'LFM2.5-350M-Q5_K_M.gguf', size: 260376288 },
      Q8_0:   { file: 'LFM2.5-350M-Q8_0.gguf',   size: 379217632 },
      F16:    { file: 'LFM2.5-350M-F16.gguf',    size: 711485152 },
    },
    defaultQuant: 'Q4_K_M',
    url(q) { return HF(this.repo, this.quants[q].file); },
  },
  {
    id: 'lfm25-12b', cat: 'text', title: 'LFM2.5-1.2B-Instruct', repo: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
    desc: 'Liquid AI 1.2B instruct model — strong on-device reasoning in a compact footprint. Great speed/quality balance.',
    badges: ['Text / Reasoning', 'Recommended'], ram: '~1.6 GB RAM',
    quants: {
      Q4_0:   { file: 'LFM2.5-1.2B-Instruct-Q4_0.gguf',   size: 695751488 },
      Q4_K_M: { file: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf', size: 730895168 },
      Q5_K_M: { file: 'LFM2.5-1.2B-Instruct-Q5_K_M.gguf', size: 843354944 },
      Q8_0:   { file: 'LFM2.5-1.2B-Instruct-Q8_0.gguf',   size: 1246253888 },
      F16:    { file: 'LFM2.5-1.2B-Instruct-F16.gguf',    size: 2343326528 },
    },
    defaultQuant: 'Q4_K_M',
    url(q) { return HF(this.repo, this.quants[q].file); },
  },
  {
    id: 'gemma-4-e4b', cat: 'vision', title: 'Gemma-4-E4B-it', repo: 'unsloth/gemma-4-E4B-it-GGUF',
    desc: 'Google DeepMind Gemma 4 effective-4B multimodal flagship. Strongest quality — best with 8 GB RAM devices.',
    badges: ['Vision + Text', 'Flagship'], ram: '~6 GB RAM',
    quants: {
      Q4_K_M: { file: 'gemma-4-E4B-it-Q4_K_M.gguf', size: 4977171584 },
      Q5_K_M: { file: 'gemma-4-E4B-it-Q5_K_M.gguf', size: 5481798784 },
      Q8_0:   { file: 'gemma-4-E4B-it-Q8_0.gguf',   size: 8192953472 },
    },
    defaultQuant: 'Q4_K_M',
    mmproj: { file: 'mmproj-F16.gguf', size: 990372672, label: 'Vision projector' },
    url(q) { return HF(this.repo, this.quants[q].file); },
    mmprojUrl() { return HF(this.repo, this.mmproj.file); },
  },
  {
    id: 'qwen3-5-4b', cat: 'vision', title: 'Qwen3.5-4B', repo: 'unsloth/Qwen3.5-4B-GGUF',
    desc: 'Alibaba Qwen3.5 4B — excellent reasoning, coding and multilingual chat with vision input and 262K context.',
    badges: ['Vision + Text', 'Reasoning', '262K ctx'], ram: '~4 GB RAM',
    quants: {
      Q4_K_M: { file: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2740937888 },
      Q5_K_M: { file: 'Qwen3.5-4B-Q5_K_M.gguf', size: 3143656608 },
      Q8_0:   { file: 'Qwen3.5-4B-Q8_0.gguf',   size: 4482403488 },
    },
    defaultQuant: 'Q4_K_M',
    mmproj: { file: 'mmproj-F16.gguf', size: 672423616, label: 'Vision projector' },
    url(q) { return HF(this.repo, this.quants[q].file); },
    mmprojUrl() { return HF(this.repo, this.mmproj.file); },
  },
  {
    id: 'qwen3-5-2b', cat: 'vision', title: 'Qwen3.5-2B', repo: 'unsloth/Qwen3.5-2B-GGUF',
    desc: 'The sweet spot for Snapdragon 4 Gen 2 — fast tokens, vision input, strong Hinglish and reasoning.',
    badges: ['Vision + Text', 'Recommended'], ram: '~2.5 GB RAM',
    quants: {
      Q4_K_M: { file: 'Qwen3.5-2B-Q4_K_M.gguf', size: 1280835840 },
      Q5_K_M: { file: 'Qwen3.5-2B-Q5_K_M.gguf', size: 1435238656 },
      Q8_0:   { file: 'Qwen3.5-2B-Q8_0.gguf',   size: 2012012800 },
    },
    defaultQuant: 'Q4_K_M',
    mmproj: { file: 'mmproj-F16.gguf', size: 668227264, label: 'Vision projector' },
    url(q) { return HF(this.repo, this.quants[q].file); },
    mmprojUrl() { return HF(this.repo, this.mmproj.file); },
  },
  {
    id: 'gemma-4-e2b', cat: 'text', title: 'Gemma-4-E2B-it', repo: 'unsloth/gemma-4-E2B-it-GGUF',
    desc: 'Compact Gemma 4 effective-2B for everyday chat, summaries and writing — light enough to stay resident.',
    badges: ['Text / Reasoning'], ram: '~4 GB RAM',
    quants: {
      Q4_K_M: { file: 'gemma-4-E2B-it-Q4_K_M.gguf', size: 3106738272 },
      Q5_K_M: { file: 'gemma-4-E2B-it-Q5_K_M.gguf', size: 3356037216 },
      Q8_0:   { file: 'gemma-4-E2B-it-Q8_0.gguf',   size: 5048352864 },
    },
    defaultQuant: 'Q4_K_M',
    mmproj: { file: 'mmproj-F16.gguf', size: 985654080, label: 'Vision projector (optional)' },
    url(q) { return HF(this.repo, this.quants[q].file); },
    mmprojUrl() { return HF(this.repo, this.mmproj.file); },
  },
  {
    id: 'qwen3-5-08b', cat: 'text', title: 'Qwen3.5-0.8B', repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    desc: 'Ultra-light 0.8B starter model — instant loads and snappy replies on any device. Great first download.',
    badges: ['Text / Reasoning', 'Ultra-light'], ram: '~1.2 GB RAM',
    quants: {
      Q4_K_M: { file: 'Qwen3.5-0.8B-Q4_K_M.gguf', size: 532517120 },
      Q5_K_M: { file: 'Qwen3.5-0.8B-Q5_K_M.gguf', size: 590057728 },
      Q8_0:   { file: 'Qwen3.5-0.8B-Q8_0.gguf',   size: 811843840 },
    },
    defaultQuant: 'Q4_K_M',
    mmproj: { file: 'mmproj-F16.gguf', size: 204987232, label: 'Vision projector (optional)' },
    url(q) { return HF(this.repo, this.quants[q].file); },
    mmprojUrl() { return HF(this.repo, this.mmproj.file); },
  },
];

/* Selectable neural voices. Speaker IDs verified against the upstream model
   metadata (Piper en_GB-vctk-medium speaker_id_map; Kokoro v1.0 sid table). */
export const PHONON_VOICES = [
  { id: 107, label: 'Vani / Aria', desc: 'Female — Warm & Natural' },
  { id: 87, label: 'Nova / Meera', desc: 'Female — Expressive & Clear' },
  { id: 92, label: 'Orion / Aarav', desc: 'Male — Deep & Calm' },
  { id: 82, label: 'Echo / Kabir', desc: 'Male — Crisp & Energetic' },
];
// Phonon-UltraLight-8M (Paradee 1.2 INT8) — four learned voices.
// IDs are the model's native voice order: af_heart, bf_isabella, am_puck, bm_fable.
export const ULTRALIGHT_VOICES = [
  { id: 0, label: 'Aria / Vani', desc: 'Female — Warm' },
  { id: 1, label: 'Meera / Nova', desc: 'Female — Clear' },
  { id: 2, label: 'Aarav / Orion', desc: 'Male — Calm' },
  { id: 3, label: 'Kabir / Echo', desc: 'Male — Crisp' },
];
export const KOKORO_VOICES = [
  { id: 3, label: 'af_heart', desc: 'Female — Warm (US)' },
  { id: 2, label: 'af_bella', desc: 'Female — Bright (US)' },
  { id: 9, label: 'af_sarah', desc: 'Female — Clear (US)' },
  { id: 21, label: 'bf_emma', desc: 'Female — British' },
  { id: 11, label: 'am_adam', desc: 'Male — Deep (US)' },
  { id: 16, label: 'am_michael', desc: 'Male — Clear (US)' },
  { id: 31, label: 'hf_alpha', desc: 'Female — Hindi' },
  { id: 33, label: 'hm_omega', desc: 'Male — Hindi' },
];
export const POCKET_VOICES = [
  { id: 0, label: 'Voice 1', desc: 'Neutral' },
  { id: 1, label: 'Voice 2', desc: 'Warm' },
  { id: 2, label: 'Voice 3', desc: 'Bright' },
  { id: 3, label: 'Voice 4', desc: 'Deep' },
];

// Supplementary engines run on the bundled sherpa-onnx runtime (TTS / ASR).
// kind:'archive' → native .tar.bz2 stream-extract with live progress.
// kind:'files'   → standalone .onnx/.txt multi-file download (no extraction).
export const SUPP_MODELS = [
  {
    // v1.3.0 TRUE ultra-light pack: Paradee 1.2 INT8 (7.88M parameters), with
    // four learned voices. The graph adapter is built + size-verified by CI;
    // piper-phonemize lives in the APK, not in this < 9 MiB download.
    id: 'phonon-ultra', cat: 'tts', kind: 'archive', engine: 'kokoro',
    title: 'Phonon Ultra-Light 8M', repo: 'Paradee-8M v1.2 · Vani AI pack',
    desc: 'Genuine ~8 MB ultra-light neural TTS (NOT the 28 MB pack). Four learned voices — Aria/Vani, Meera/Nova, Aarav/Orion, Kabir/Echo — with instant preview. The default Live Talk voice.',
    badges: ['TTS', '< 9 MB', '4 Voices', 'Neural'],
    voices: ULTRALIGHT_VOICES, defaultVoice: 0,
    variants: { INT8: { file: 'phonon-ultralight-8m-int8.tar.bz2', size: 7374491 } },
    defaultVariant: 'INT8',
    url(v) { return `https://github.com/kanhiayamishra152/Vani/releases/download/phonon-ultralight-v1/${this.variants[v].file}`; },
  },
  {
    id: 'phonon', cat: 'tts', kind: 'archive', engine: 'vits',
    title: 'Phonon Voice Pack (Studio)', repo: 'Piper VCTK multi-speaker · k2-fsa/sherpa-onnx',
    desc: 'Real compact 4-voice neural TTS (Piper VCTK, int8). Warm female, expressive female, deep male and crisp male — with a voice selector and preview.',
    badges: ['TTS', '4 Voices', 'Neural'],
    voices: PHONON_VOICES, defaultVoice: 107,
    variants: { INT8: { file: 'vits-piper-en_GB-vctk-medium-int8.tar.bz2', size: 23366127 } },
    defaultVariant: 'INT8',
    url(v) { return GH_TTS(this.variants[v].file); },
  },
  {
    id: 'pocket-tts', cat: 'tts', kind: 'archive', engine: 'pocket',
    title: 'Pocket TTS 100M', repo: 'Kyutai · k2-fsa/sherpa-onnx pack',
    desc: 'Kyutai Pocket TTS — compact 100M neural voice with natural prosody and selectable voices. Runs fully offline.',
    badges: ['TTS', 'Neural 100M'],
    voices: POCKET_VOICES, defaultVoice: 0,
    variants: {
      INT8: { file: 'sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2', size: 98336520 },
      FP16: { file: 'sherpa-onnx-pocket-tts-2026-01-26.tar.bz2', size: 168148625 },
    },
    defaultVariant: 'INT8',
    url(v) { return GH_TTS(this.variants[v].file); },
  },
  {
    id: 'piper-lessac', cat: 'tts', kind: 'archive', engine: 'vits',
    title: 'Piper VITS — Lessac (Medium)', repo: 'rhasspy/piper · k2-fsa/sherpa-onnx pack',
    desc: 'The classic compact Piper VITS voice. Clear US-English speech with tiny latency and RAM.',
    badges: ['TTS', 'Piper VITS'],
    variants: {
      FP32: { file: 'vits-piper-en_US-lessac-medium.tar.bz2', size: 67230653 },
      INT8: { file: 'vits-piper-en_US-lessac-medium-int8.tar.bz2', size: 20969179 },
      FP16: { file: 'vits-piper-en_US-lessac-medium-fp16.tar.bz2', size: 35955459 },
    },
    defaultVariant: 'FP32',
    url(v) { return GH_TTS(this.variants[v].file); },
  },
  {
    id: 'kokoro', cat: 'tts', kind: 'archive', engine: 'kokoro',
    title: 'Kokoro-82M v1.0', repo: 'Kokoro-82M-v1.0 · k2-fsa/sherpa-onnx pack',
    desc: 'Kokoro 82M multi-language voice — the best quality-to-size neural TTS. Many voices incl. Hindi (hf_alpha / hm_omega).',
    badges: ['TTS', 'Multi-voice'],
    voices: KOKORO_VOICES, defaultVoice: 3,
    variants: {
      INT8: { file: 'kokoro-int8-multi-lang-v1_0.tar.bz2', size: 132353410 },
      FP32: { file: 'kokoro-multi-lang-v1_0.tar.bz2', size: 349886476 },
    },
    defaultVariant: 'INT8',
    url(v) { return GH_TTS(this.variants[v].file); },
  },
  {
    id: 'whisper-tiny', cat: 'asr', kind: 'files', engine: 'whisper',
    title: 'Whisper Tiny (multilingual)', repo: 'csukuangfj/sherpa-onnx-whisper-tiny',
    desc: 'OpenAI Whisper tiny, int8 standalone ONNX — fast offline speech recognition. English + Hindi. No archive extraction.',
    badges: ['ASR', 'Offline STT'],
    variants: {
      INT8: {
        size: 103609903,
        files: [
          { name: 'tiny-encoder.int8.onnx', url: HF('csukuangfj/sherpa-onnx-whisper-tiny', 'tiny-encoder.int8.onnx'), bytes: 12937772 },
          { name: 'tiny-decoder.int8.onnx', url: HF('csukuangfj/sherpa-onnx-whisper-tiny', 'tiny-decoder.int8.onnx'), bytes: 89855401 },
          { name: 'tiny-tokens.txt', url: HF('csukuangfj/sherpa-onnx-whisper-tiny', 'tiny-tokens.txt'), bytes: 816730 },
        ],
      },
    },
    defaultVariant: 'INT8',
  },
  {
    id: 'whisper-base', cat: 'asr', kind: 'files', engine: 'whisper',
    title: 'Whisper Base (multilingual)', repo: 'csukuangfj/sherpa-onnx-whisper-base',
    desc: 'Higher-accuracy Whisper base, int8 standalone ONNX for noisy environments and Hinglish dictation. Fully offline.',
    badges: ['ASR', 'Higher accuracy'],
    variants: {
      INT8: {
        size: 160609290,
        files: [
          { name: 'base-encoder.int8.onnx', url: HF('csukuangfj/sherpa-onnx-whisper-base', 'base-encoder.int8.onnx'), bytes: 29120534 },
          { name: 'base-decoder.int8.onnx', url: HF('csukuangfj/sherpa-onnx-whisper-base', 'base-decoder.int8.onnx'), bytes: 130672026 },
          { name: 'base-tokens.txt', url: HF('csukuangfj/sherpa-onnx-whisper-base', 'base-tokens.txt'), bytes: 816730 },
        ],
      },
    },
    defaultVariant: 'INT8',
  },
  {
    id: 'whisper-small', cat: 'asr', kind: 'files', engine: 'whisper',
    title: 'Whisper Small (multilingual)', repo: 'csukuangfj/sherpa-onnx-whisper-small',
    desc: 'Whisper small, int8 standalone ONNX — the highest accuracy of the Whisper family here. Multilingual.',
    badges: ['ASR', 'Best accuracy'],
    variants: {
      INT8: {
        size: 375485327,
        files: [
          { name: 'small-encoder.int8.onnx', url: HF('csukuangfj/sherpa-onnx-whisper-small', 'small-encoder.int8.onnx'), bytes: 112442483 },
          { name: 'small-decoder.int8.onnx', url: HF('csukuangfj/sherpa-onnx-whisper-small', 'small-decoder.int8.onnx'), bytes: 262226114 },
          { name: 'small-tokens.txt', url: HF('csukuangfj/sherpa-onnx-whisper-small', 'small-tokens.txt'), bytes: 816730 },
        ],
      },
    },
    defaultVariant: 'INT8',
  },
  {
    id: 'moonshine-tiny', cat: 'asr', kind: 'archive', engine: 'moonshine',
    title: 'Moonshine Tiny (English)', repo: 'Useful Sensors · k2-fsa/sherpa-onnx pack',
    desc: 'Moonshine tiny — extremely fast, low-latency English ASR optimized for edge devices.',
    badges: ['ASR', 'Ultra-fast'],
    variants: { INT8: { file: 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2', size: 29858559 } },
    defaultVariant: 'INT8',
    url(v) { return GH_ASR(this.variants[v].file); },
  },
  {
    id: 'moonshine-base', cat: 'asr', kind: 'archive', engine: 'moonshine',
    title: 'Moonshine Base (English)', repo: 'Useful Sensors · k2-fsa/sherpa-onnx pack',
    desc: 'Moonshine base — fast, accurate English ASR optimized for edge devices.',
    badges: ['ASR', 'Fast + accurate'],
    variants: { INT8: { file: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2', size: 111266225 } },
    defaultVariant: 'INT8',
    url(v) { return GH_ASR(this.variants[v].file); },
  },
  {
    id: 'sensevoice', cat: 'asr', kind: 'archive', engine: 'sensevoice',
    title: 'SenseVoice Small (multilingual)', repo: 'Alibaba · k2-fsa/sherpa-onnx pack',
    desc: 'Alibaba SenseVoice — very accurate multilingual ASR (zh/en/ja/ko/yue) with emotion and audio-event tags.',
    badges: ['ASR', 'Multilingual'],
    variants: { INT8: { file: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2', size: 163002883 } },
    defaultVariant: 'INT8',
    url(v) { return GH_ASR(this.variants[v].file); },
  },
  {
    id: 'zipformer', cat: 'asr', kind: 'files', engine: 'zipformer',
    title: 'Zipformer Fast (English)', repo: 'csukuangfj/sherpa-onnx-zipformer-en-2023-06-26',
    desc: 'k2 Zipformer transducer, int8 standalone ONNX — very fast streaming-style English ASR. No archive extraction.',
    badges: ['ASR', 'Streaming-fast'],
    variants: {
      INT8: {
        size: 70350183,
        files: [
          { name: 'encoder-epoch-99-avg-1.int8.onnx', url: HF('csukuangfj/sherpa-onnx-zipformer-en-2023-06-26', 'encoder-epoch-99-avg-1.int8.onnx'), bytes: 68778564 },
          { name: 'decoder-epoch-99-avg-1.int8.onnx', url: HF('csukuangfj/sherpa-onnx-zipformer-en-2023-06-26', 'decoder-epoch-99-avg-1.int8.onnx'), bytes: 1307236 },
          { name: 'joiner-epoch-99-avg-1.int8.onnx', url: HF('csukuangfj/sherpa-onnx-zipformer-en-2023-06-26', 'joiner-epoch-99-avg-1.int8.onnx'), bytes: 259335 },
          { name: 'tokens.txt', url: HF('csukuangfj/sherpa-onnx-zipformer-en-2023-06-26', 'tokens.txt'), bytes: 5048 },
        ],
      },
    },
    defaultVariant: 'INT8',
  },
];

export const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'omni', label: 'Omni' },
  { id: 'vision', label: 'Vision + Text' },
  { id: 'text', label: 'Text' },
  { id: 'tts', label: 'TTS' },
  { id: 'asr', label: 'ASR' },
];

export const ANIME_ACTIONS = [
  { id: 'namaste', label: 'Namaste', desc: 'Respectful greeting', icon: 'prism' },
  { id: 'wave', label: 'Wave', desc: 'Friendly hello', icon: 'user' },
  { id: 'bow', label: 'Bow', desc: 'Polite bow', icon: 'chevronDown' },
  { id: 'jump', label: 'Jump', desc: 'Excited hop', icon: 'arrowUp' },
  { id: 'spin', label: 'Spin', desc: '360° twirl', icon: 'refresh' },
  { id: 'dance', label: 'Dance', desc: 'Happy groove', icon: 'music' },
  { id: 'think', label: 'Think', desc: 'Hand on chin', icon: 'help' },
  { id: 'nod', label: 'Nod', desc: 'Agreement', icon: 'check' },
  { id: 'headshake', label: 'Head shake', desc: 'Disagreement', icon: 'x' },
  { id: 'happy', label: 'Happy', desc: 'Joyful bounce', icon: 'smile' },
  { id: 'shy', label: 'Shy', desc: 'Blushing bashful', icon: 'heart' },
  { id: 'surprised', label: 'Surprised', desc: 'Startled gasp', icon: 'alert' },
];
