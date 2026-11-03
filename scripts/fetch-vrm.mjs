#!/usr/bin/env node
/**
 * Vani AI — OC-Lily VRM fetcher (mandatory CI asset).
 * Downloads the owner's exact VRM character from Google Drive, transparently
 * handling Drive's large-file virus-scan confirmation interstitial, verifies
 * the GLB magic, and writes assets/vrm/OC-Lily.vrm.
 *
 * Usage: node scripts/fetch-vrm.mjs [--optional]
 *   --optional  warn instead of failing when the download is unreachable
 *               (used for local web-only builds; CI always requires it).
 * Env: VANI_VRM_URL overrides the source URL (mirror support).
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE_ID = '1vyE1GP6k7cRSoHBW_n8YTmpMBNMajByw';
const OUT = join(ROOT, 'assets', 'vrm', 'OC-Lily.vrm');
const OPTIONAL = process.argv.includes('--optional');

const URLS = [
  process.env.VANI_VRM_URL,
  `https://drive.usercontent.google.com/download?id=${FILE_ID}&export=download&confirm=t`,
  `https://drive.google.com/uc?export=download&confirm=t&id=${FILE_ID}`,
].filter(Boolean);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  'Accept': '*/*',
};

function isGLB(buf) {
  return buf.length > 12 && buf.readUInt32LE(0) === 0x46546c67; // 'glTF'
}

/** Drive sometimes answers with an HTML confirmation form for big files. */
async function resolveDriveInterstitial(html) {
  // Modern form: <form action="https://drive.usercontent.google.com/download" ...> with hidden inputs id/export/confirm/uuid
  const action = html.match(/<form[^>]+action="([^"]+)"/i);
  if (!action) return null;
  const inputs = [...html.matchAll(/<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)];
  if (!inputs.length) return null;
  const params = new URLSearchParams();
  for (const m of inputs) params.set(m[1], m[2].replace(/&amp;/g, '&'));
  if (!params.has('id')) params.set('id', FILE_ID);
  if (!params.has('confirm')) params.set('confirm', 't');
  const base = action[1].replace(/&amp;/g, '&');
  return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
}

async function tryFetch(url) {
  console.log(`[fetch-vrm] GET ${url}`);
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(240_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (isGLB(buf)) return buf;
  const head = buf.subarray(0, 4096).toString('utf8');
  if (head.includes('<html') || head.includes('<!DOCTYPE')) {
    const next = await resolveDriveInterstitial(head);
    if (next && next !== url) {
      console.log('[fetch-vrm] virus-scan confirmation interstitial detected — following confirmation token');
      const res2 = await fetch(next, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(240_000) });
      if (!res2.ok) throw new Error(`HTTP ${res2.status} after confirmation`);
      buf = Buffer.from(await res2.arrayBuffer());
      if (isGLB(buf)) return buf;
    }
    throw new Error('Drive returned HTML instead of the VRM binary (quota/auth?)');
  }
  throw new Error(`Not a GLB/VRM file (magic: ${buf.subarray(0, 4).toString('hex')})`);
}

async function main() {
  if (existsSync(OUT) && isGLB(await (await import('node:fs/promises')).readFile(OUT))) {
    console.log(`[fetch-vrm] already present: ${OUT} (${(statSync(OUT).size / 1048576).toFixed(2)} MB) — keeping cached copy`);
    return;
  }
  let lastErr;
  for (const url of URLS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const buf = await tryFetch(url);
        mkdirSync(dirname(OUT), { recursive: true });
        writeFileSync(OUT, buf);
        const sha = createHash('sha256').update(buf).digest('hex');
        console.log(`[fetch-vrm] OK: ${(buf.length / 1048576).toFixed(2)} MB  sha256=${sha}`);
        return;
      } catch (e) {
        lastErr = e;
        console.warn(`[fetch-vrm] attempt ${attempt} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  const msg = `[fetch-vrm] FAILED to download OC-Lily.vrm: ${lastErr?.message}`;
  if (OPTIONAL) { console.warn(msg + ' (--optional: continuing without VRM)'); return; }
  console.error(msg);
  process.exit(1);
}

main();
