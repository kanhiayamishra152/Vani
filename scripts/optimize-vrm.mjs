#!/usr/bin/env node
/**
 * Vani AI — VRM integrity verifier (NO compression, NO modification).
 *
 * v1.2.0 mandate: the OC-Lily avatar must be bundled 100% original — zero
 * texture downscale, zero re-encode, zero geometry change. This script now
 * ONLY validates the GLB/VRM container and reports its size + sha256. It
 * never writes to the file. Kept as a no-op safeguard so any stray invocation
 * (local or CI) cannot alter the owner's original character.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || join(ROOT, 'assets', 'vrm', 'OC-Lily.vrm');

if (!existsSync(FILE)) {
  console.error(`[optimize-vrm] ${FILE} not found — run fetch-vrm.mjs first.`);
  process.exit(1);
}

const buf = readFileSync(FILE);
if (buf.readUInt32LE(0) !== 0x46546c67) {
  console.error('[optimize-vrm] not a GLB/VRM file (bad magic).');
  process.exit(1);
}
const sha = createHash('sha256').update(buf).digest('hex');
console.log(`[optimize-vrm] original preserved byte-for-byte: ${(buf.length / 1048576).toFixed(2)} MB  sha256=${sha}`);
console.log('[optimize-vrm] no textures resized, no geometry touched (v1.2.0 zero-compression policy).');
