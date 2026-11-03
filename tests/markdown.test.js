import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, splitReasoning, hasCodeOrMath, getCode } from '../web/js/markdown.js';

test('inline + display math render to KaTeX (real symbols, no raw LaTeX)', () => {
  const html = renderMarkdown('Energy is $E=mc^2$ and $$\\int_0^1 x\\,dx$$');
  assert.match(html, /katex/);
  assert.ok(!html.includes('$E=mc^2$'), 'raw inline LaTeX must not leak');
  assert.ok(!html.includes('$$'), 'raw display delimiters must not leak');
});

test('fenced code becomes a copy card with language header', () => {
  const html = renderMarkdown('```python\nprint("hi")\n```');
  assert.match(html, /code-card/);
  assert.match(html, /code-lang">python/);
  assert.match(html, /Copy Code/);
  const id = html.match(/data-code-id="([^"]+)"/)[1];
  assert.equal(getCode(id), 'print("hi")');
});

test('code content is HTML-escaped', () => {
  const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
  assert.ok(!html.includes('<script>alert'), 'must escape script tags');
  assert.match(html, /&lt;script&gt;/);
});

test('headings, lists, bold and links', () => {
  const html = renderMarkdown('# Title\n\n- one\n- two\n\n**bold** and [x](https://example.com)');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test('hasCodeOrMath detects overlays triggers', () => {
  assert.ok(hasCodeOrMath('```\ncode\n```'));
  assert.ok(hasCodeOrMath('$$x$$'));
  assert.ok(!hasCodeOrMath('plain text only'));
});

test('splitReasoning separates think traces', () => {
  const T = '<' + 'think' + '>';
  const TC = '</' + 'think' + '>';
  const r = splitReasoning(T + 'let me think.' + TC + ' answer');
  assert.equal(r.content, 'answer');
  assert.match(r.reasoning, /let me think/);
  const open = splitReasoning('visible' + T + 'still going');
  assert.equal(open.content, 'visible');
  assert.equal(open.thinking, true);
});
