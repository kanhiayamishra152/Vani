import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIN_MODELS, SUPP_MODELS, CATEGORIES, ANIME_ACTIONS } from '../web/js/catalog.js';

test('eight main models with required fields (incl. LFM2.5)', () => {
  assert.equal(MAIN_MODELS.length, 8);
  for (const m of MAIN_MODELS) {
    assert.ok(m.id && m.title && m.repo, m.id);
    assert.ok(m.defaultQuant && m.quants[m.defaultQuant], m.id);
    for (const [q, info] of Object.entries(m.quants)) {
      assert.ok(info.file.endsWith('.gguf'), `${m.id}/${q}`);
      assert.ok(info.size > 0, `${m.id}/${q} size`);
      assert.match(m.url(q), /^https:\/\/huggingface\.co\//);
    }
  }
  // v1.2.0: LFM2.5 first-class entries.
  const m350 = MAIN_MODELS.find(m => m.id === 'lfm25-350m');
  const m12 = MAIN_MODELS.find(m => m.id === 'lfm25-12b');
  assert.ok(m350 && m12);
  assert.equal(m350.quants.Q4_0.size, 219309792);
  assert.equal(m12.quants.Q4_K_M.size, 730895168);
  assert.match(m350.repo, /LiquidAI\/LFM2\.5-350M-GGUF/);
  assert.match(m12.repo, /LiquidAI\/LFM2\.5-1\.2B-Instruct-GGUF/);
});

test('LFM3-Omni-2B has NO Q5_K_M and no runtime gate', () => {
  const lfm = MAIN_MODELS.find(m => m.id === 'lfm3-omni-2b');
  assert.ok(lfm);
  assert.equal(lfm.cat, 'omni');
  assert.ok(!('Q5_K_M' in lfm.quants), 'LFM3 must not offer Q5_K_M');
  assert.ok(lfm.quants.Q4_K_M && lfm.quants.Q8_0);
  assert.equal(lfm.quants.Q4_K_M.size, 1099630080);
  assert.ok(!/upgrade|b11963|confirm/i.test(JSON.stringify(lfm)));
});

test('verified exact byte sizes for headline quants', () => {
  const get = (id, q) => MAIN_MODELS.find(m => m.id === id).quants[q].size;
  assert.equal(get('qwen3-5-08b', 'Q4_K_M'), 532517120);
  assert.equal(get('qwen3-5-2b', 'Q4_K_M'), 1280835840);
  assert.equal(get('qwen3-5-4b', 'Q4_K_M'), 2740937888);
  assert.equal(get('gemma-4-e2b', 'Q4_K_M'), 3106738272);
  assert.equal(get('gemma-4-e4b', 'Q4_K_M'), 4977171584);
});

test('supplementary: real Phonon pack + neural TTS voices + 7 ASR engines', () => {
  const ids = SUPP_MODELS.map(m => m.id);
  for (const want of ['phonon', 'pocket-tts', 'piper-lessac', 'kokoro',
    'whisper-tiny', 'whisper-base', 'whisper-small', 'moonshine-tiny', 'moonshine-base', 'sensevoice', 'zipformer']) {
    assert.ok(ids.includes(want), want);
  }
  // Phonon is now a REAL downloadable multi-speaker pack, not a builtin formant.
  const phonon = SUPP_MODELS.find(m => m.id === 'phonon');
  assert.equal(phonon.kind, 'archive');
  assert.equal(phonon.engine, 'vits');
  assert.equal(phonon.variants.INT8.size, 23366127);
  assert.equal(phonon.voices.length, 4);
  assert.deepEqual(phonon.voices.map(v => v.id).sort((a, b) => a - b), [82, 87, 92, 107]);
  assert.equal(phonon.defaultVoice, 107);
  assert.match(phonon.url('INT8'), /vits-piper-en_GB-vctk-medium-int8\.tar\.bz2/);
  // Pocket + Kokoro voice selectors.
  const pocket = SUPP_MODELS.find(m => m.id === 'pocket-tts');
  assert.equal(pocket.variants.INT8.size, 98336520);
  assert.ok(pocket.voices.length >= 4);
  const kokoro = SUPP_MODELS.find(m => m.id === 'kokoro');
  assert.ok(kokoro.voices.some(v => v.label === 'hf_alpha' && v.id === 31));
  assert.ok(kokoro.voices.some(v => v.label === 'hm_omega' && v.id === 33));
  // Whisper standalone multi-file (no extraction).
  const tiny = SUPP_MODELS.find(m => m.id === 'whisper-tiny');
  assert.equal(tiny.kind, 'files');
  assert.equal(tiny.engine, 'whisper');
  assert.equal(tiny.variants.INT8.files.length, 3);
  assert.equal(tiny.variants.INT8.size, 103609903);
  for (const f of tiny.variants.INT8.files) assert.match(f.url, /^https:\/\/huggingface\.co\//);
  // Zipformer standalone transducer (encoder/decoder/joiner/tokens).
  const zip = SUPP_MODELS.find(m => m.id === 'zipformer');
  assert.equal(zip.kind, 'files');
  assert.equal(zip.engine, 'zipformer');
  assert.equal(zip.variants.INT8.files.length, 4);
  // Moonshine + SenseVoice archives with the right engines.
  assert.equal(SUPP_MODELS.find(m => m.id === 'moonshine-tiny').engine, 'moonshine');
  assert.equal(SUPP_MODELS.find(m => m.id === 'sensevoice').engine, 'sensevoice');
});

test('categories and 12 anime actions', () => {
  assert.ok(CATEGORIES.some(c => c.id === 'all'));
  assert.equal(ANIME_ACTIONS.length, 12);
  for (const want of ['namaste', 'wave', 'bow', 'jump', 'spin', 'dance', 'think', 'nod', 'headshake', 'happy', 'shy', 'surprised']) {
    assert.ok(ANIME_ACTIONS.some(a => a.id === want), want);
  }
});
