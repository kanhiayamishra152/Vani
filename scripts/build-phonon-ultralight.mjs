#!/usr/bin/env node
/**
 * Vani AI v1.3.0 — build the genuine Phonon-UltraLight-8M-INT8 TTS pack.
 *
 * Paradee 1.2 is a 7.88M-parameter INT8 model with four learned voices. The
 * adapter in scripts/convert-paradee.py makes it consumable by the already
 * bundled sherpa-onnx Kokoro runtime; it does not replace the model with a
 * stub or a larger pack. The archive contains only the adapted model, its
 * tiny voice/token tables and provenance (no 6 MB lexicon: the native app uses
 * piper-phonemize for text -> phonemes).
 *
 *   node scripts/build-phonon-ultralight.mjs <out-dir> [--update-catalog]
 *
 * Hard-fails if the final archive is >= 9 MiB so we never ship the 28 MB pack.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = process.argv[2] || 'dist-tts';
const UPDATE_CATALOG = process.argv.includes('--update-catalog');
const MAX_BYTES = 9 * 1024 * 1024;
const HF = 'https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.2/resolve/v1.2';
const run = c => execSync(c, { stdio: 'inherit' });
const q = s => `'${String(s).replaceAll("'", "'\\''")}'`;

mkdirSync(OUT, { recursive: true });
const work = join(OUT, 'work');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

console.log('[ultralight] downloading Paradee-8M v1.2 INT8 (four voices) …');
run(`curl -fsSL --retry 3 -o ${q(join(work, 'paradee_int8.onnx'))} ${q(`${HF}/onnx/paradee_int8.onnx?download=true`)}`);
run(`curl -fsSL --retry 3 -o ${q(join(work, 'config.json'))} ${q(`${HF}/config.json?download=true`)}`);

const packDir = join(work, 'phonon-ultralight-8m-int8');
console.log('[ultralight] adapting the graph for sherpa-onnx Kokoro …');
run(`python3 ${q(resolve('scripts/convert-paradee.py'))} ${q(join(work, 'paradee_int8.onnx'))} ${q(join(work, 'config.json'))} ${q(packDir)}`);

// Inference is a build gate, not an optional post-publish check: the original
// and adapted graphs must agree and sherpa must synthesize all four voices.
run(`python3 ${q(resolve('scripts/verify-paradee.py'))} ${q(join(work, 'paradee_int8.onnx'))} ${q(packDir)}`);

const archive = join(OUT, 'phonon-ultralight-8m-int8.tar.bz2');
run(`tar cjf ${q(archive)} -C ${q(work)} phonon-ultralight-8m-int8`);
const size = statSync(archive).size;
console.log(`[ultralight] archive: ${archive} = ${size} bytes (${(size / 1048576).toFixed(2)} MiB)`);
if (size >= MAX_BYTES) {
  console.error(`[ultralight] FAIL: ${size} bytes >= 9 MiB cap. The pack is too large — do NOT ship.`);
  process.exit(1);
}
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(join(OUT, 'SHA256SUMS.txt'), `${sha256}  phonon-ultralight-8m-int8.tar.bz2\n`);
writeFileSync(join(OUT, 'size.json'), JSON.stringify({ file: 'phonon-ultralight-8m-int8.tar.bz2', bytes: size, sha256, voices: 4, sampleRate: 24000, model: 'Paradee-8M-v1.2' }, null, 2) + '\n');

if (UPDATE_CATALOG) {
  const catalogPath = resolve('web/js/catalog.js');
  let text = readFileSync(catalogPath, 'utf8');
  const marker = "variants: { INT8: { file: 'phonon-ultralight-8m-int8.tar.bz2', size:";
  const start = text.indexOf(marker);
  if (start < 0) throw new Error('could not locate phonon-ultra size in catalog.js');
  const tail = text.slice(start);
  const updated = tail.replace(/size:\s*\d+/, `size: ${size}`);
  text = text.slice(0, start) + updated;
  writeFileSync(catalogPath, text);
  console.log(`[ultralight] updated catalog download size to ${size} bytes`);
}
console.log('[ultralight] OK: genuine four-voice INT8 pack (< 9 MiB), preview-ready.');
