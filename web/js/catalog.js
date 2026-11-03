// Vani AI — 2026 frontier model catalog.
// Every filename + byte size below was verified against the upstream repo
// file tree (Hugging Face API / GitHub Releases API) on 2026-11-03.
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

// Supplementary engines run on the bundled sherpa-onnx runtime (TTS / ASR).
// Archives are extracted natively after download; Phonon is built into the app.
export const SUPP_MODELS = [
  {
    id: 'phonon', cat: 'tts', kind: 'builtin', engine: 'phonon',
    title: 'Phonon Ultra-Light TTS', repo: 'Built-in formant engine',
    desc: 'Instant on-device formant synthesis with near-zero RAM and zero download. Robotic but always available — the ultra-light fallback voice.',
    badges: ['TTS', '~0 MB', 'Instant'], size: 0,
  },
  {
    id: 'pocket-tts', cat: 'tts', kind: 'archive', engine: 'pocket',
    title: 'Pocket TTS 100M', repo: 'Kyutai · k2-fsa/sherpa-onnx pack',
    desc: 'Kyutai Pocket TTS — compact 100M neural voice with natural prosody. Runs fully offline on the bundled sherpa-onnx runtime.',
    badges: ['TTS', 'Neural 100M'],
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
    desc: 'The classic compact Piper VITS voice (~63 MB ONNX). Clear US-English speech with tiny latency and RAM.',
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
    desc: 'Kokoro 82M multi-language voice — the best quality-to-size neural TTS. 10 voices, natural intonation.',
    badges: ['TTS', 'Multi-voice'],
    variants: {
      INT8: { file: 'kokoro-int8-multi-lang-v1_0.tar.bz2', size: 132353410 },
      FP32: { file: 'kokoro-multi-lang-v1_0.tar.bz2', size: 349886476 },
    },
    defaultVariant: 'INT8',
    url(v) { return GH_TTS(this.variants[v].file); },
  },
  {
    id: 'whisper-tiny', cat: 'asr', kind: 'archive', engine: 'whisper',
    title: 'Whisper Tiny (multilingual)', repo: 'csukuangfj/sherpa-onnx-whisper-tiny',
    desc: 'OpenAI Whisper tiny with exact mel frontend — fast offline speech recognition for the hands-free Live Talk loop. English + Hindi.',
    badges: ['ASR', 'Offline STT'],
    variants: { PACK: { file: 'sherpa-onnx-whisper-tiny.tar.bz2', size: 116204861 } },
    defaultVariant: 'PACK',
    url(v) { return GH_ASR(this.variants[v].file); },
  },
  {
    id: 'whisper-base', cat: 'asr', kind: 'archive', engine: 'whisper',
    title: 'Whisper Base (multilingual)', repo: 'csukuangfj/sherpa-onnx-whisper-base',
    desc: 'Higher-accuracy Whisper base for noisy environments and Hinglish dictation. Still fully offline.',
    badges: ['ASR', 'Higher accuracy'],
    variants: { PACK: { file: 'sherpa-onnx-whisper-base.tar.bz2', size: 207557382 } },
    defaultVariant: 'PACK',
    url(v) { return GH_ASR(this.variants[v].file); },
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
