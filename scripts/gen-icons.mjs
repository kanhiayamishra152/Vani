#!/usr/bin/env node
/**
 * Vani AI — launcher / splash icon rasterizer.
 * Renders the bespoke SVG emblem into every Android mipmap density (mdpi →
 * xxxhdpi, normal + round), the legacy splash logo and the 512px store icon.
 * Adaptive (API 26+) icons use the matching vector drawable in res/.
 */
import sharp from 'sharp';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');
const svg = readFileSync(join(ROOT, 'web', 'assets', 'logo.svg'));
const mark = readFileSync(join(ROOT, 'web', 'assets', 'logo-mark.svg'));

const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

for (const [dpi, size] of Object.entries(densities)) {
  const dir = join(RES, `mipmap-${dpi}`);
  mkdirSync(dir, { recursive: true });
  await sharp(svg).resize(size, size).png().toFile(join(dir, 'ic_launcher.png'));
  // Round variant: circular mask over the squircle render.
  const circle = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  const base = await sharp(svg).resize(size, size).png().toBuffer();
  await sharp(base).composite([{ input: circle, blend: 'dest-in' }]).png().toFile(join(dir, 'ic_launcher_round.png'));
  console.log(`[gen-icons] mipmap-${dpi}: ${size}x${size} (normal + round)`);
}

mkdirSync(join(RES, 'drawable-nodpi'), { recursive: true });
await sharp(mark).resize(288, 288).png().toFile(join(RES, 'drawable-nodpi', 'splash_logo.png'));
mkdirSync(join(ROOT, 'android', 'store'), { recursive: true });
await sharp(svg).resize(512, 512).png().toFile(join(ROOT, 'android', 'store', 'playstore-icon-512.png'));
console.log('[gen-icons] splash logo + 512px store icon done.');
