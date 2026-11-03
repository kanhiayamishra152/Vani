#!/usr/bin/env node
/**
 * Vani AI — pinned native dependency fetcher.
 *  - llama.cpp v0.8.0 source (GGUF inference engine, built via NDK/CMake)
 *  - sherpa-onnx 2.0.1 prebuilt Android AAR (local TTS / ASR / VAD runtime)
 *  - silero_vad.onnx (bundled voice-activity detector, ~0.6 MB)
 *  - piper-phonemize 1.5.9 AAR (offline text frontend for Paradee)
 * All sources are pinned for reproducible builds. --optional degrades to
 * warnings for local web-only builds on restricted networks.
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONAL = process.argv.includes('--optional');

export const LLAMA_TAG = 'v0.8.0';
export const SHERPA_VERSION = '2.0.1';

const TARGETS = [
  {
    name: 'llama.cpp source',
    url: `https://codeload.github.com/ggml-org/llama.cpp/tar.gz/refs/tags/${LLAMA_TAG}`,
    kind: 'llama-tar',
    dest: join(ROOT, 'third_party', 'llama.cpp'),
    pin: LLAMA_TAG,
  },
  {
    name: 'sherpa-onnx AAR',
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-${SHERPA_VERSION}.aar`,
    kind: 'file',
    dest: join(ROOT, 'android', 'app', 'libs', `sherpa-onnx-${SHERPA_VERSION}.aar`),
    minBytes: 30_000_000,
  },
  {
    name: 'piper-phonemize AAR (offline English frontend)',
    url: 'https://github.com/csukuangfj/piper-phonemize/releases/download/v1.5.9/piper-phonemize-1.5.9.aar',
    kind: 'file',
    dest: join(ROOT, 'android', 'app', 'libs', 'piper-phonemize-1.5.9.aar'),
    minBytes: 12_000_000,
  },
  {
    name: 'silero VAD model',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    kind: 'file',
    dest: join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'vad', 'silero_vad.onnx'),
    minBytes: 500_000,
  },
];

async function download(url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`[fetch-native] GET ${url} (attempt ${i})`);
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) { lastErr = e; console.warn(`[fetch-native]   failed: ${e.message}`); await new Promise(r => setTimeout(r, 3000 * i)); }
  }
  throw lastErr;
}

let failures = 0;
for (const t of TARGETS) {
  try {
    if (t.kind === 'llama-tar') {
      const pinFile = join(t.dest, '.vani-pin');
      if (existsSync(pinFile) && readFileSync(pinFile, 'utf8').trim() === t.pin) { console.log(`[fetch-native] ${t.name}: cached ${t.pin}`); continue; }
      const buf = await download(t.url);
      mkdirSync(join(ROOT, 'third_party'), { recursive: true });
      const tar = join(ROOT, 'third_party', 'llama.tar.gz');
      writeFileSync(tar, buf);
      if (existsSync(t.dest)) rmSync(t.dest, { recursive: true, force: true });
      execSync(`tar xzf ${tar} -C ${join(ROOT, 'third_party')}`);
      renameSync(join(ROOT, 'third_party', `llama.cpp-${t.pin.replace(/^v/, '')}`), t.dest);
      writeFileSync(pinFile, t.pin);
      rmSync(tar);
      console.log(`[fetch-native] ${t.name}: OK (${(buf.length / 1048576).toFixed(1)} MB)`);
    } else {
      if (existsSync(t.dest) && statSync(t.dest).size >= (t.minBytes || 1)) { console.log(`[fetch-native] ${t.name}: cached`); continue; }
      const buf = await download(t.url);
      if (t.minBytes && buf.length < t.minBytes) throw new Error(`suspiciously small: ${buf.length} bytes`);
      mkdirSync(dirname(t.dest), { recursive: true });
      writeFileSync(t.dest, buf);
      console.log(`[fetch-native] ${t.name}: OK (${(buf.length / 1048576).toFixed(1)} MB)`);
    }
  } catch (e) {
    failures++;
    const msg = `[fetch-native] FAILED ${t.name}: ${e.message}`;
    if (OPTIONAL) console.warn(msg + ' (--optional: continuing)');
    else { console.error(msg); }
  }
}
if (failures && !OPTIONAL) process.exit(1);
console.log('[fetch-native] done.');
