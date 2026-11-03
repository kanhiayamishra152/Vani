#!/usr/bin/env node
/**
 * Vani AI v1.3.0 — original-quality OC-Lily VRM validation.
 *
 * The owner's VRM is an immutable asset: this script NEVER resizes, re-encodes
 * or rewrites textures, geometry, MToon materials, outlines, morphs or spring
 * bones. It only parses the GLB container and audits the embedded asset before
 * build-web copies the exact bytes into the APK. Runtime anti-freeze handling
 * lives in avatar.js/CrashGuard (capped DPR, no MSAA, asynchronous compilation
 * and native memory pressure release), not in lossy asset preprocessing.
 *
 * Usage: node scripts/prepare-vrm-safe.mjs [--check]
 *   --check  is an explicit read-only CI validation alias; both modes are safe.
 * Input: assets/vrm/OC-Lily.vrm (never modified).
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'assets', 'vrm', 'OC-Lily.vrm');
const CHECK_ONLY = process.argv.includes('--check');

function parseGLB(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB/VRM file');
  if (buf.readUInt32LE(4) !== 2) throw new Error('unsupported GLB version');
  if (buf.readUInt32LE(8) !== buf.length) throw new Error('GLB declared length does not match file length');
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a || 20 + jsonLen > buf.length) throw new Error('invalid JSON chunk');
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  let off = 20 + jsonLen;
  let bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (off + 8 + len > buf.length) throw new Error('truncated GLB chunk');
    if (type === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
  }
  if (!bin) throw new Error('no BIN chunk; refusing an incomplete avatar');
  return { json, bin };
}

function main() {
  if (!existsSync(FILE)) {
    console.warn(`[prepare-vrm-safe] ${FILE} not present — run fetch-vrm.mjs first.`);
    process.exit(CHECK_ONLY ? 1 : 0);
  }
  const before = readFileSync(FILE);
  const { json, bin } = parseGLB(before);
  const images = json.images || [];
  const embedded = images.filter(img => img.bufferView != null).length;
  const meshes = (json.meshes || []).length;
  const materials = (json.materials || []).length;
  const morphs = (json.meshes || []).reduce((n, mesh) => n + (mesh.primitives || []).reduce((m, p) => m + (p.targets?.length || 0), 0), 0);
  const hasVrm = !!(json.extensions?.VRM || json.extensions?.VRMC_vrm);
  if (!meshes || !materials || !hasVrm) throw new Error('VRM audit failed: missing meshes, materials or VRM extension');
  if (embedded !== images.length) throw new Error('VRM audit failed: an image is external; the offline avatar must be self-contained');

  // Reading again and comparing hashes makes the no-rewrite contract explicit,
  // including when this script is invoked with --check in a clean CI checkout.
  const after = readFileSync(FILE);
  const shaBefore = createHash('sha256').update(before).digest('hex');
  const shaAfter = createHash('sha256').update(after).digest('hex');
  if (shaBefore !== shaAfter) throw new Error('avatar changed during read-only validation');
  console.log(`[prepare-vrm-safe] ${images.length} original embedded textures, ${meshes} meshes, ${materials} materials, ${morphs} morph targets, BIN ${(bin.length / 1048576).toFixed(2)} MB`);
  console.log(`[prepare-vrm-safe] OK${CHECK_ONLY ? ' (--check)' : ''}: original OC-Lily preserved byte-for-byte; sha256=${shaAfter}`);
  console.log('[prepare-vrm-safe] no texture resize, re-encode, geometry edit or optimization performed');
}

try { main(); } catch (e) {
  console.error('[prepare-vrm-safe] FAILED:', e.message);
  process.exit(1);
}
