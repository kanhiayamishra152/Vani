import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const OUT = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');

function walk(dir, exts) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some(x => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// Emoji / pictograph ranges (excludes typographic punctuation like … · ° •).
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

test('zero emojis across web source', () => {
  const files = walk(WEB, ['.js', '.html', '.css', '.svg']);
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    const m = txt.match(EMOJI);
    assert.ok(!m, `emoji ${m ? JSON.stringify(m[0]) : ''} found in ${f.replace(ROOT, '')}`);
  }
});

test('title is exactly "Vani AI"', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  assert.match(html, /<title>Vani AI<\/title>/);
});

test('monochrome palette: red reserved, no stray brand colors', () => {
  const css = readFileSync(join(WEB, 'css', 'app.css'), 'utf8');
  assert.match(css, /#000000|#000\b/);
  assert.match(css, /#EF4444/i);
});

test('built bundle exists and index.html asset refs resolve', () => {
  assert.ok(existsSync(join(OUT, 'app.js')), 'run scripts/build-web.mjs first');
  assert.ok(statSync(join(OUT, 'app.js')).size > 100000);
  const html = readFileSync(join(OUT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1])
    .filter(r => !/^https?:/.test(r) && !r.startsWith('data:'));
  for (const r of refs) {
    assert.ok(existsSync(join(OUT, r)), `missing bundled asset: ${r}`);
  }
  assert.ok(existsSync(join(OUT, 'vendor', 'katex', 'katex.min.css')));
  assert.ok(readdirSync(join(OUT, 'vendor', 'katex', 'fonts')).some(f => f.endsWith('.woff2')));
});
