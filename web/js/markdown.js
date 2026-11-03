// Vani AI — safe Markdown renderer with offline KaTeX math + code copy cards.
// Raw LaTeX never reaches the screen: $...$, $$...$$, \(...\), \[...\] are
// rendered to real symbols; fenced code becomes monochrome copy cards.
import katex from 'katex';
import { esc, uid } from './util.js';
import { icon } from './icons.js';

const codeRegistry = new Map();
export function getCode(id) { return codeRegistry.get(id); }

function mathToHtml(tex, displayMode) {
  // v1.3.0 security: KaTeX trust:false disables \href/\includegraphics/\htmlData
  // (no arbitrary HTML/URLs from model output); maxExpand caps macro-expansion
  // bombs. Everything else in renderMarkdown is escaped then re-built from a
  // strict tag whitelist — <script>/<iframe>/on*= /javascript: can never pass.
  try { return katex.renderToString(tex, { throwOnError: false, displayMode, output: 'html', strict: false, trust: false, maxExpand: 1000 }); }
  catch { return `<code class="inline">${esc(tex)}</code>`; }
}

function codeCard(lang, code) {
  const id = uid();
  codeRegistry.set(id, code);
  if (codeRegistry.size > 400) codeRegistry.delete(codeRegistry.keys().next().value);
  return `<div class="code-card"><div class="code-card-head"><span class="code-lang">${esc(lang || 'code')}</span><button class="copy-btn" data-code-id="${id}">${icon('copy')}<span>Copy Code</span></button></div><pre><code>${esc(code)}</code></pre></div>`;
}

export function hasCodeOrMath(text) {
  return /```[\s\S]*?```/.test(text) || /\$\$[\s\S]+?\$\$/.test(text) || /\\\[[\s\S]+?\\\]/.test(text);
}

export function renderMarkdown(src) {
  let text = String(src ?? '');
  const stash = [];
  const put = html => { stash.push(html); return `\x00B${stash.length - 1}\x00`; };

  // 1. Fenced code blocks (tolerate an unterminated fence while streaming).
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => put(codeCard(lang.trim(), code.replace(/\n$/, ''))));
  // 2. Display math.
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => put(mathToHtml(tex.trim(), true)));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => put(mathToHtml(tex.trim(), true)));
  // 3. Inline code, then inline math.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => put(`<code class="inline">${esc(code)}</code>`));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => put(mathToHtml(tex.trim(), false)));
  text = text.replace(/\$(?=\S)([^$\n]*?\S)\$/g, (_, tex) => put(mathToHtml(tex.trim(), false)));

  // 4. Escape everything else, then block-level formatting.
  const lines = esc(text).split('\n');
  const out = [];
  let i = 0;
  const inline = s => s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    if (/^\x00B\d+\x00$/.test(trimmed)) { out.push(trimmed); i++; continue; }
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.push('<hr>'); i++; continue; }
    if (/^&gt;\s?/.test(trimmed)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^&gt;\s?/, '')); i++; }
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`); continue;
    }
    if (/^([-*•]|\d+\.)\s+/.test(trimmed)) {
      const ordered = /^\d+\./.test(trimmed);
      const items = [];
      while (i < lines.length && /^([-*•]|\d+\.)\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*•]|\d+\.)\s+/, '')); i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(it => `<li>${inline(it)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const cells = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inline(c.trim()));
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|&gt;|[-*•]\s|\d+\.\s|\x00B\d+\x00$)/.test(lines[i].trim()) && !/^(-{3,})$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }

  let html = out.join('\n');
  html = html.replace(/\x00B(\d+)\x00/g, (_, n) => stash[Number(n)] ?? '');
  return html;
}

/** Split streamed raw output into reasoning traces + visible content. */
export function splitReasoning(raw) {
  let reasoning = '';
  let content = String(raw ?? '');
  content = content.replace(/<think>([\s\S]*?)<\/think>/g, (_, r) => { reasoning += r; return ''; });
  const open = content.indexOf('<think>');
  let thinking = false;
  if (open >= 0) { reasoning += content.slice(open + 7); content = content.slice(0, open); thinking = true; }
  return { reasoning: reasoning.trim(), content: content.replace(/^\s+/, ''), thinking };
}
