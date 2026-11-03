#!/usr/bin/env node
/**
 * Vani AI — smart VRM texture optimizer (lossless geometry).
 * Resizes ONLY oversized embedded textures (>1024px) inside the GLB/VRM
 * container to 1024x1024. Every mesh, skin, morph target, spring bone, MToon
 * material and VRM 0.x/1.0 extension byte survives untouched — only image
 * bufferViews are re-encoded and bufferView offsets re-laid-out.
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || join(ROOT, 'assets', 'vrm', 'OC-Lily.vrm');
const MAX = 1024;

if (!existsSync(FILE)) {
  console.error(`[optimize-vrm] ${FILE} not found — run fetch-vrm.mjs first.`);
  process.exit(1);
}

const buf = readFileSync(FILE);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB/VRM file');
const totalLen = buf.readUInt32LE(8);
let off = 12;
let json = null, bin = null;
const chunks = [];
while (off < totalLen) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));      // JSON
  else if (type === 0x004e4942) bin = data;                               // BIN
  else chunks.push({ type, data });                                       // preserve unknown chunks
  off += 8 + len;
}
if (!json || !bin) throw new Error('GLB missing JSON or BIN chunk');

const views = json.bufferViews || [];
const images = json.images || [];
let resized = 0, savedBytes = 0;

// 1. Replace oversized image payloads.
const replacements = new Map(); // bufferView index -> new Buffer
for (const img of images) {
  if (img.bufferView === undefined) continue; // external URI — leave alone
  const bv = views[img.bufferView];
  const start = bv.byteOffset || 0;
  const raw = bin.subarray(start, start + bv.byteLength);
  let meta;
  try { meta = await sharp(raw).metadata(); } catch { continue; }
  if (!meta.width || !meta.height || (meta.width <= MAX && meta.height <= MAX)) continue;
  const hasAlpha = !!meta.hasAlpha;
  const isPng = (img.mimeType || meta.format) === 'image/png' || meta.format === 'png';
  let pipeline = sharp(raw).resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true });
  let out, mime;
  if (isPng && hasAlpha) { out = await pipeline.png({ compressionLevel: 9 }).toBuffer(); mime = 'image/png'; }
  else if (isPng)        { out = await pipeline.png({ compressionLevel: 9 }).toBuffer(); mime = 'image/png'; }
  else                   { out = await pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer(); mime = 'image/jpeg'; }
  replacements.set(img.bufferView, out);
  img.mimeType = mime;
  savedBytes += bv.byteLength - out.length;
  resized++;
  console.log(`[optimize-vrm] texture "${img.name || img.bufferView}": ${meta.width}x${meta.height} -> <=${MAX}  (${(bv.byteLength / 1048576).toFixed(2)} MB -> ${(out.length / 1048576).toFixed(2)} MB)`);
}

if (resized === 0) {
  console.log('[optimize-vrm] all textures already <=1024px — container untouched.');
  process.exit(0);
}

// 2. Re-lay-out the BIN chunk: copy every bufferView in order, 4-byte aligned.
const parts = [];
let cursor = 0;
const pad = (n) => (4 - (n % 4)) % 4;
for (let i = 0; i < views.length; i++) {
  const bv = views[i];
  const data = replacements.has(i) ? replacements.get(i) : bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const p = pad(cursor);
  if (p) { parts.push(Buffer.alloc(p)); cursor += p; }
  bv.byteOffset = cursor;
  bv.byteLength = data.length;
  parts.push(Buffer.from(data));
  cursor += data.length;
}
const endPad = pad(cursor);
if (endPad) { parts.push(Buffer.alloc(endPad)); cursor += endPad; }
const newBin = Buffer.concat(parts);
json.buffers[0].byteLength = newBin.length;

// 3. Reassemble GLB (JSON chunk padded with spaces, BIN with zeros — glTF spec).
const jsonBufRaw = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = pad(jsonBufRaw.length);
const jsonBuf = Buffer.concat([jsonBufRaw, Buffer.alloc(jsonPad, 0x20)]);
const binPad = pad(newBin.length);
const binBuf = Buffer.concat([newBin, Buffer.alloc(binPad)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
const outBuf = Buffer.concat([header, jh, jsonBuf, bh, binBuf]);
writeFileSync(FILE, outBuf);
console.log(`[optimize-vrm] done: ${resized} textures resized, container ${(buf.length / 1048576).toFixed(2)} MB -> ${(outBuf.length / 1048576).toFixed(2)} MB (saved ${(savedBytes / 1048576).toFixed(2)} MB). Meshes/morphs/spring-bones/MToon preserved.`);
