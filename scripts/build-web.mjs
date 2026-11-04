#!/usr/bin/env node
/**
 * Vani AI — web bundle compiler.
 * Bundles the ES-module app (three.js + three-vrm + KaTeX + app code) with
 * esbuild into a single offline IIFE, copies the offline KaTeX CSS + woff2
 * fonts, the SVG brand assets, the audio worklet and (when present) the
 * original, unmodified OC-Lily VRM into the Android assets tree.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'vendor', 'katex', 'fonts'), { recursive: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });

console.log('[build-web] esbuild: web/js/main.js -> app.js');
await build({
  entryPoints: [join(ROOT, 'web', 'js', 'main.js')],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'iife',
  target: ['chrome100'],
  outfile: join(OUT, 'app.js'),
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});

console.log('[build-web] copying html / css / worklet / brand assets');
cpSync(join(ROOT, 'web', 'index.html'), join(OUT, 'index.html'));
cpSync(join(ROOT, 'web', 'css', 'app.css'), join(OUT, 'app.css'));
cpSync(join(ROOT, 'web', 'js', 'pcm-worklet.js'), join(OUT, 'pcm-worklet.js'));
cpSync(join(ROOT, 'web', 'assets', 'logo.svg'), join(OUT, 'assets', 'logo.svg'));
cpSync(join(ROOT, 'web', 'assets', 'logo-mark.svg'), join(OUT, 'assets', 'logo-mark.svg'));

console.log('[build-web] bundling offline KaTeX (css + woff2 fonts; js is inside app.js)');
const katexDist = join(ROOT, 'node_modules', 'katex', 'dist');
cpSync(join(katexDist, 'katex.min.css'), join(OUT, 'vendor', 'katex', 'katex.min.css'));
for (const f of readdirSync(join(katexDist, 'fonts'))) {
  if (f.endsWith('.woff2')) cpSync(join(katexDist, 'fonts', f), join(OUT, 'vendor', 'katex', 'fonts', f));
}

const vrmSrc = join(ROOT, 'assets', 'vrm', 'OC-Lily.vrm');
if (existsSync(vrmSrc)) {
  mkdirSync(join(OUT, 'assets', 'vrm'), { recursive: true });
  cpSync(vrmSrc, join(OUT, 'assets', 'vrm', 'OC-Lily.vrm'));
  const mb = (statSync(vrmSrc).size / 1048576).toFixed(2);
  console.log(`[build-web] bundled OC-Lily.vrm (${mb} MB, served via WebViewAssetLoader)`);
} else {
  console.warn('[build-web] WARNING: assets/vrm/OC-Lily.vrm not present — run scripts/fetch-vrm.mjs + prepare-vrm-safe.mjs for a complete APK.');
}

let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch {}
const info = { name: 'Vani AI', version: '1.5.1', versionCode: 7, package: 'ai.vani.app', commit, builtAt: new Date().toISOString() };
writeFileSync(join(OUT, 'build-info.json'), JSON.stringify(info, null, 2));
console.log('[build-web] done ->', OUT);
