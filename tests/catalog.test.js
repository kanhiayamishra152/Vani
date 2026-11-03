import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIN_MODELS, SUPP_MODELS, CATEGORIES, ANIME_ACTIONS } from '../web/js/catalog.js';

test('six main models with required fields', () => {
  assert.equal(MAIN_MODELS.length, 6);
  for (const m of MAIN_MODELS) {
    assert.ok(m.id && m.title && m.repo, m.id);
    assert.ok(m.defaultQuant && m.quants[m.defaultQuant], m.id);
    for (const [q, info] of Object.entries(m.quants)) {
      assert.ok(info.file.endsWith('.gguf'), `${m.id}/${q}`);
      assert.ok(info.size > 0, `${m.id}/${q} size`);
      assert.match(m.url(q), /^https:\/\/huggingface\.co\//);
    }
  }
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

test('supplementary engines: phonon builtin + neural TTS + whisper ASR', () => {
  const ids = SUPP_MODELS.map(m => m.id);
  for (const want of ['phonon', 'pocket-tts', 'piper-lessac', 'kokoro', 'whisper-tiny', 'whisper-base']) {
    assert.ok(ids.includes(want), want);
  }
  const phonon = SUPP_MODELS.find(m => m.id === 'phonon');
  assert.equal(phonon.kind, 'builtin');
  assert.equal(phonon.size, 0);
  const pocket = SUPP_MODELS.find(m => m.id === 'pocket-tts');
  assert.equal(pocket.variants.INT8.size, 98336520);
  assert.match(pocket.url('INT8'), /github\.com\/k2-fsa\/sherpa-onnx/);
  const tiny = SUPP_MODELS.find(m => m.id === 'whisper-tiny');
  assert.equal(tiny.variants.PACK.size, 116204861);
});

test('categories and 12 anime actions', () => {
  assert.ok(CATEGORIES.some(c => c.id === 'all'));
  assert.equal(ANIME_ACTIONS.length, 12);
  for (const want of ['namaste', 'wave', 'bow', 'jump', 'spin', 'dance', 'think', 'nod', 'headshake', 'happy', 'shy', 'surprised']) {
    assert.ok(ANIME_ACTIONS.some(a => a.id === want), want);
  }
});
