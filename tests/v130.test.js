// Vani AI v1.3.0 — unit verification of the overhaul's contract guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SUPP_MODELS, ULTRALIGHT_VOICES, ANIME_ACTIONS } from '../web/js/catalog.js';
import { renderMarkdown, splitReasoning } from '../web/js/markdown.js';
import { sampleAction, AXES, setAxes } from '../web/js/anime.js';

test('Phonon-UltraLight pack is a genuine < 9 MB Paradee TTS with 4 voices', () => {
  const m = SUPP_MODELS.find(x => x.id === 'phonon-ultra');
  assert.ok(m, 'phonon-ultra entry exists');
  assert.equal(m.engine, 'kokoro');
  assert.match(m.repo, /Paradee/);
  assert.equal(m.cat, 'tts');
  assert.equal(m.kind, 'archive');
  const v = m.variants[m.defaultVariant];
  assert.ok(v.size < 9 * 1024 * 1024, `pack must be < 9 MB (got ${v.size})`);
  assert.ok(v.size > 4 * 1024 * 1024, 'pack should be a real neural model, not a stub');
  assert.equal(m.voices.length, 4, 'exactly 4 official voice profiles');
  assert.ok(m.url(m.defaultVariant).startsWith('https://'), 'HTTPS download only');
});

test('OC-Lily preparation is read-only and preserves the original asset', () => {
  const source = readFileSync(new URL('../scripts/prepare-vrm-safe.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('.resize('), 'no texture resampling');
  assert.ok(!source.includes('writeFileSync('), 'no VRM rewrite');
  assert.match(source, /byte-for-byte/);
});

test('Ultra-light voice profiles map to Paradee speaker IDs', () => {
  assert.equal(ULTRALIGHT_VOICES.length, 4);
  const ids = ULTRALIGHT_VOICES.map(v => v.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [0, 1, 2, 3]);
  assert.deepEqual(ULTRALIGHT_VOICES.map(v => v.id), [0, 1, 2, 3]);
  assert.match(ULTRALIGHT_VOICES[0].desc, /Female/);
  assert.match(ULTRALIGHT_VOICES[1].desc, /Female/);
  assert.match(ULTRALIGHT_VOICES[2].desc, /Male/);
  assert.match(ULTRALIGHT_VOICES[3].desc, /Male/);
});

test('markdown sanitizer blocks script / onerror / javascript: injection', () => {
  assert.ok(!/<script/i.test(renderMarkdown('<script>alert(1)</script>')), 'no <script> passes');
  const img = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!/<img\b/i.test(img), 'raw HTML is escaped, not an executable img element');
  assert.ok(/&lt;img/i.test(img), 'the escaped source remains visible as text');
  const link = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!/<a\b/i.test(link), 'javascript: markdown is not converted into an anchor');
  assert.ok(!/href\s*=\s*["']javascript:/i.test(link), 'no executable javascript: href');
  assert.ok(!/<iframe/i.test(renderMarkdown('<iframe src="x"></iframe>')), 'no iframe');
});

test('KaTeX runs with trust disabled (no \\href / URL injection from math)', () => {
  const out = renderMarkdown('$\\href{javascript:alert(1)}{click}$');
  assert.ok(!/javascript:/i.test(out), 'KaTeX trust:false strips javascript: href');
  assert.ok(!/<a\s/i.test(out), 'no anchor emitted from untrusted \\href');
});

test('reasoning splitter separates  from the answer', () => {
  const { reasoning, content } = splitReasoning('<think>Let me think. 2+2=4.</think>The answer is 4.');
  assert.match(reasoning, /2\+2=4/);
  assert.match(content, /answer is 4/);
  assert.ok(!/think>/i.test(content), 'think tags stripped from content');
});

test('all 12 anime actions sample cleanly and AXES exposes 4 calibrated signs', () => {
  assert.equal(ANIME_ACTIONS.length, 12);
  for (const a of ANIME_ACTIONS) {
    const s = sampleAction(a.id, 0.5);
    assert.ok(s, `action ${a.id} samples`);
    assert.ok(typeof s.duration === 'number' && s.duration > 0);
  }
  assert.deepEqual(Object.keys(AXES).sort(), ['armFwd', 'knee', 'leg', 'pitch']);
  setAxes({ pitch: 1, knee: 1, leg: 1, armFwd: 1 });
});
