// Vani AI — Module 1: Chat, ChatGPT-style history drawer, composer.
import { $, $$, el, esc, copyText, dateGroup, throttle, uid } from './util.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { on, emitLocal, hasNative, invoke } from './bridge.js';
import * as store from './store.js';
import { renderMarkdown, splitReasoning, getCode } from './markdown.js';
import { llm, isReady, generate, buildContextMessages } from './inference.js';
import { ANIME_ACTIONS } from './catalog.js';
import { openPromptStudio } from './prompts.js';
import { dictateOnce, stopDictation, speak, stopSpeech, isSpeaking } from './voice.js';

let attachments = [];         // dataURLs pending send
let activeGen = null;         // { genId, stop }
let streamingMsgId = null;
let streamingRaw = '';
let dictating = false;
let dictationBase = '';
let playingMsgId = null;
const autoSpeech = { queue: [], speaking: false, consumed: 0, messageId: null };

/** Stable key for the loaded model (per-model thinking preference is keyed by it). */
function currentModelKey() {
  return llm.info?.name || llm.info?.modelPath || 'default';
}

/** Reflect the active model's thinking state on the composer triangle toggle. */
function updateThinkToggle() {
  const btn = $('#btn-think');
  if (!btn) return;
  const on = store.getModelThinking(currentModelKey());
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Thinking on — tap to turn off' : 'Thinking off — tap to turn on');
  btn.title = on ? 'Thinking: ON' : 'Thinking: OFF';
  const lbl = btn.querySelector('.think-label');
  if (lbl) lbl.textContent = on ? 'Think' : 'Think';
}

function toggleThinking() {
  const key = currentModelKey();
  const next = !store.getModelThinking(key);
  store.setModelThinking(key, next);
  updateThinkToggle();
  setComposerStatus(next ? 'Thinking enabled for this model' : 'Direct answers enabled for this model');
}

/* ============================ rendering ============================ */
export function renderChat() {
  const list = $('#chat-list');
  const empty = $('#chat-empty');
  const t = store.getThread();
  list.innerHTML = '';
  const msgs = t?.messages || [];
  if (!msgs.length) {
    empty.hidden = false;
    empty.innerHTML = emptyStateHtml();
    wireEmptyState(empty);
  } else {
    empty.hidden = true;
    for (const m of msgs) list.appendChild(renderMessage(m));
  }
  updateComposerState();
  scrollBottom(true);
}

function emptyStateHtml() {
  if (!hasNative()) {
    return `<div class="empty-card"><img src="assets/logo-mark.svg" alt=""><h2>Vani AI</h2><p>Web preview — install the Android APK for on-device models, Live Talk and voice.</p><button class="btn-primary" id="empty-browse">${icon('box')}<span>Browse Model Hub</span></button></div>`;
  }
  if (llm.state === 'loading') {
    return `<div class="empty-card"><img src="assets/logo-mark.svg" alt=""><h2>Loading model</h2><p>Preparing on-device inference…</p><div class="typing-dots"><i></i><i></i><i></i></div></div>`;
  }
  if (!isReady()) {
    return `<div class="empty-card"><img src="assets/logo-mark.svg" alt=""><h2>No model loaded</h2><p>Vani runs 100% on-device. Download a model to start chatting — nothing leaves your phone.</p><button class="btn-primary" id="empty-browse">${icon('box')}<span>Browse Model Hub</span></button></div>`;
  }
  return `<div class="empty-card"><img src="assets/logo-mark.svg" alt=""><h2>How can I help?</h2><p>${esc(llm.info?.name || 'Model')} is ready. Ask anything, attach an image, or open Live Talk.</p><button class="btn-secondary" id="empty-live">${icon('waveform')}<span>Open Live Talk</span></button></div>`;
}

function wireEmptyState(root) {
  root.querySelector('#empty-browse')?.addEventListener('click', () => emitLocal('nav', 'models'));
  root.querySelector('#empty-live')?.addEventListener('click', () => emitLocal('live.open'));
}

function renderMessage(m) {
  const wrap = el('div', `msg ${m.role}`);
  wrap.dataset.msgId = m.id;
  if (m.role === 'user') {
    if (m.images?.length) {
      for (const src of m.images) {
        const img = el('img', 'msg-attach-thumb');
        img.src = src; wrap.appendChild(img);
      }
    }
    if (m.content) wrap.appendChild(el('div', 'msg-bubble-user msg-text', esc(m.content)));
  } else {
    wrap.appendChild(el('div', 'msg-meta', `${icon('prism')}<span>Vani AI${m.live ? ' · Live' : ''}</span>`));
    const { reasoning, content } = splitReasoning(m.content || '');
    if (reasoning && store.settings.showReasoning) {
      const d = el('details', 'reasoning');
      d.innerHTML = `<summary><span class="reasoning-tri">${icon('chevronRight')}</span>${icon('sparkles')}<span>Thinking</span></summary><div class="reasoning-body">${esc(reasoning)}</div>`;
      wrap.appendChild(d);
    }
    const body = el('div', 'msg-text');
    if (m.id === streamingMsgId && !content) body.innerHTML = '<div class="typing-dots"><i></i><i></i><i></i></div>';
    else body.innerHTML = renderMarkdown(content || '');
    wrap.appendChild(body);
    if (m.id !== streamingMsgId && content) {
      const footer = el('div', 'msg-footer');
      const actions = el('div', 'msg-actions');
      const audio = el('button', 'icon-btn msg-audio', icon(playingMsgId === m.id && isSpeaking() ? 'stop' : 'play'));
      audio.dataset.audioId = m.id;
      audio.setAttribute('aria-label', playingMsgId === m.id && isSpeaking() ? 'Stop audio' : 'Play response audio');
      audio.disabled = !content.trim();
      audio.addEventListener('click', () => toggleMessageAudio(m.id));
      const copy = el('button', 'icon-btn', icon('copy'));
      copy.setAttribute('aria-label', 'Copy message');
      copy.addEventListener('click', async () => { (await copyText(content)) ? toast('Copied') : toast('Copy failed'); });
      const regenerate = el('button', 'icon-btn msg-regenerate', icon('refresh'));
      regenerate.setAttribute('aria-label', 'Regenerate response');
      regenerate.addEventListener('click', () => regenerateMessage(m.id));
      actions.append(audio, copy, regenerate);
      footer.appendChild(actions);
      if (m.stats) {
        const badge = el('span', 'msg-stats');
        const tps = Number(m.stats.tps);
        const ms = Number(m.stats.msPerToken) > 0 ? Number(m.stats.msPerToken) : (tps > 0 ? 1000 / tps : 0);
        const ttft = Number(m.stats.ttftMs);
        const tokens = Number(m.stats.tokens);
        const parts = [];
        if (tps > 0) parts.push(`${tps.toFixed(1)} tok/s`);
        if (ms > 0) parts.push(`${ms.toFixed(1)} ms/tok`);
        if (Number.isFinite(ttft) && ttft >= 0) parts.push(`TTFT ${Math.round(ttft)} ms`);
        if (Number.isFinite(tokens) && tokens >= 0) parts.push(`${tokens} tokens`);
        if (parts.length) { badge.innerHTML = `${icon('bolt')}<span>${parts.join(' • ')}</span>`; footer.appendChild(badge); }
      }
      wrap.appendChild(footer);
    }
  }
  return wrap;
}

function messageContent(id) {
  const m = store.getThread()?.messages.find(x => x.id === id);
  return m ? splitReasoning(m.content || '').content : '';
}
function speechText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' I have put the code on screen. ')
    .replace(/```[\s\S]*$/g, ' I am writing the code on screen. ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' the formula is on screen ')
    .replace(/\$[^$\n]*\$/g, ' the expression ')
    .replace(/[*_#`>|]/g, ' ').replace(/\s+/g, ' ').trim();
}
function updateAudioButtons() {
  $$('[data-audio-id]').forEach(btn => {
    const active = btn.dataset.audioId === playingMsgId && isSpeaking();
    btn.innerHTML = icon(active ? 'stop' : 'play');
    btn.setAttribute('aria-label', active ? 'Stop audio' : 'Play response audio');
    btn.disabled = !messageContent(btn.dataset.audioId).trim();
  });
}
function cancelChatSpeech() {
  autoSpeech.queue = []; autoSpeech.speaking = false; autoSpeech.messageId = null; autoSpeech.consumed = 0;
  playingMsgId = null;
  stopSpeech();
  updateAudioButtons();
}
function updateAutoTtsToggle() {
  const btn = $('#btn-auto-tts');
  if (!btn) return;
  const enabled = !!store.settings.autoTts;
  btn.innerHTML = icon(enabled ? 'volume' : 'volumeOff');
  btn.classList.toggle('on', enabled);
  btn.setAttribute('aria-pressed', String(enabled));
  btn.setAttribute('aria-label', enabled ? 'Auto-speak replies: on' : 'Auto-speak replies: off');
  btn.title = enabled ? 'Auto-speak replies: ON' : 'Auto-speak replies: OFF';
}
function speakNextAuto(id) {
  if (autoSpeech.messageId !== id || autoSpeech.speaking) return;
  const text = autoSpeech.queue.shift();
  if (!text) {
    autoSpeech.speaking = false;
    if (playingMsgId === id) playingMsgId = null;
    updateAudioButtons();
    return;
  }
  autoSpeech.speaking = true;
  playingMsgId = id;
  speak(text, {
    onLevel: () => {},
    onStart: () => { if (playingMsgId === id) updateAudioButtons(); },
    onEnd: interrupted => {
      autoSpeech.speaking = false;
      if (autoSpeech.messageId !== id) return;
      if (!interrupted) speakNextAuto(id);
      else { if (playingMsgId === id) playingMsgId = null; updateAudioButtons(); }
    },
    onError: e => {
      autoSpeech.speaking = false;
      if (playingMsgId === id) playingMsgId = null;
      updateAudioButtons();
      setComposerStatus(e.message || 'Playback failed', 'error');
    },
  });
  updateAudioButtons();
}
function feedAutoSpeech(content, flush = false) {
  if (!store.settings.autoTts || !streamingMsgId) return;
  const id = streamingMsgId;
  if (autoSpeech.messageId !== id) {
    autoSpeech.messageId = id; autoSpeech.queue = []; autoSpeech.consumed = 0;
  }
  const text = String(content || '');
  if (text.length < autoSpeech.consumed) autoSpeech.consumed = 0;
  const rest = text.slice(autoSpeech.consumed);
  let cut = 0; let match;
  const re = /[.!?।,]\s+|\n+/g;
  while ((match = re.exec(rest))) cut = match.index + match[0].length;
  if (cut > 0) {
    const part = speechText(rest.slice(0, cut));
    autoSpeech.consumed += cut;
    if (part) autoSpeech.queue.push(part);
  }
  if (flush) {
    const tail = speechText(text.slice(autoSpeech.consumed));
    autoSpeech.consumed = text.length;
    if (tail) autoSpeech.queue.push(tail);
  }
  speakNextAuto(id);
}
function toggleMessageAudio(id) {
  if (playingMsgId === id) { cancelChatSpeech(); return; }
  cancelChatSpeech();
  const text = speechText(messageContent(id));
  if (!text) return;
  playingMsgId = id;
  speak(text, {
    onStart: () => { if (playingMsgId === id) updateAudioButtons(); },
    onEnd: () => { if (playingMsgId === id) { playingMsgId = null; updateAudioButtons(); } },
    onError: e => { if (playingMsgId === id) { playingMsgId = null; updateAudioButtons(); } setComposerStatus(e.message || 'Playback failed', 'error'); },
  });
  updateAudioButtons();
}
function regenerateMessage(id) {
  if (activeGen) return;
  const t = store.getThread();
  const index = t?.messages.findIndex(m => m.id === id) ?? -1;
  if (index < 0) return;
  const user = t.messages.slice(0, index).reverse().find(m => m.role === 'user');
  if (!user) return;
  cancelChatSpeech();
  attachments = (user.images || []).slice();
  store.truncateFrom(user.id);
  sendChat(user.content);
}

const scrollBottom = throttle(force => {
  const sc = $('#chat-scroll');
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 240;
  if (force || nearBottom) sc.scrollTop = sc.scrollHeight;
}, 120);

/* ============================ sending ============================ */
export async function sendChat(rawText) {
  const text = String(rawText ?? '').trim();
  const images = attachments.slice();
  if (!text && !images.length) return;
  if (activeGen) { setComposerStatus('Still generating — tap Stop first'); return; }

  const anime = text.match(/^\/anime\s+([a-z]+)/i);
  if (anime) {
    const action = anime[1].toLowerCase();
    if (!ANIME_ACTIONS.some(a => a.id === action)) { toast(`Unknown action: ${action}`); return; }
    store.addMessage('user', text);
    resetComposer(); renderChat(); emitLocal('anime.command', { action });
    return;
  }
  if (!isReady()) {
    if (!hasNative()) toast('Install the Android app to chat');
    else { toast('Load a model first'); emitLocal('nav', 'models'); }
    return;
  }

  cancelChatSpeech();
  store.ensureThread();
  const t = store.getThread();
  store.addMessage('user', text, images.length ? { images } : {});
  const assistant = store.addMessage('assistant', '', {});
  streamingMsgId = assistant.id;
  streamingRaw = '';
  autoSpeech.messageId = store.settings.autoTts ? assistant.id : null;
  autoSpeech.queue = []; autoSpeech.consumed = 0; autoSpeech.speaking = false;
  resetComposer(); renderChat(); setComposerStatus(''); updateComposerState();

  const history = t.messages.filter(m => m.id !== assistant.id);
  const thinkOn = store.getModelThinking(currentModelKey());
  let sysText = store.activePrompt().text;
  if (!thinkOn) sysText += '\n\nRespond directly with the final answer only. Do not show step-by-step reasoning and do not use <think> tags.';
  const messages = buildContextMessages(history, sysText, store.settings.maxTokens);
  if (images.length) messages[messages.length - 1].hasImages = true;

  const paint = throttle(() => {
    const node = $$('#chat-list .msg.assistant').find(n => n.dataset.msgId === assistant.id);
    if (!node) return;
    const { reasoning, content } = splitReasoning(streamingRaw);
    const body = node.querySelector('.msg-text');
    if (body) {
      if (content) { body.textContent = content; body.classList.add('streaming-plain'); }
      else body.innerHTML = '<div class="typing-dots"><i></i><i></i><i></i></div>';
    }
    let det = node.querySelector('.reasoning');
    if (reasoning && store.settings.showReasoning) {
      if (!det) {
        det = el('details', 'reasoning');
        det.innerHTML = `<summary><span class="reasoning-tri">${icon('chevronRight')}</span>${icon('sparkles')}<span>Thinking</span></summary><div class="reasoning-body"></div>`;
        node.insertBefore(det, body);
      }
      det.querySelector('.reasoning-body').textContent = reasoning;
    }
    scrollBottom(false);
  }, 32);

  activeGen = generate({
    messages, images, thinking: thinkOn,
    onToken: tok => {
      streamingRaw += tok;
      feedAutoSpeech(splitReasoning(streamingRaw).content);
      paint();
    },
    onDone: stats => {
      const content = splitReasoning(streamingRaw).content;
      feedAutoSpeech(content, true);
      const telemetry = stats ? {
        tps: Number(stats.tps) || 0,
        msPerToken: Number(stats.msPerToken) || 0,
        ttftMs: Number.isFinite(Number(stats.ttftMs)) ? Number(stats.ttftMs) : -1,
        tokens: Number(stats.tokens) || 0,
        promptTokens: stats.promptTokens,
        cachedTokens: stats.cachedTokens,
      } : null;
      store.updateMessage(assistant.id, { content: streamingRaw, stats: telemetry });
      activeGen = null; streamingMsgId = null;
      renderChat(); updateComposerState(); updateAudioButtons();
    },
    onError: err => {
      cancelChatSpeech();
      store.updateMessage(assistant.id, { content: streamingRaw || `_${err.message}_`, stats: null });
      activeGen = null; streamingMsgId = null;
      setComposerStatus(err.message || 'Generation failed', 'error');
      renderChat(); updateComposerState();
    },
  });
  updateComposerState();
}

export function stopGeneration() { activeGen?.stop(); cancelChatSpeech(); setComposerStatus(''); }
export const isGenerating = () => !!activeGen;

function resetComposer() {
  $('#composer-input').value = '';
  $('#composer-input').style.height = 'auto';
  attachments = [];
  renderAttachments();
  hideSlash();
}

function setComposerStatus(text, kind = '') {
  const node = $('#composer-status');
  if (!node) return;
  node.hidden = !text;
  node.className = `composer-status${kind ? ' ' + kind : ''}`;
  node.textContent = text || '';
}

function updateComposerState() {
  const hasText = !!$('#composer-input').value.trim() || attachments.length > 0;
  $('#btn-send').hidden = !hasText || !!activeGen;
  $('#btn-stop').hidden = !activeGen;
  $('#btn-live').hidden = hasText || !!activeGen;
  updateAutoTtsToggle();
}

function renderAttachments() {
  const box = $('#attach-preview');
  box.innerHTML = '';
  box.hidden = attachments.length === 0;
  attachments.forEach((src, i) => {
    const chip = el('div', 'attach-chip');
    const img = el('img'); img.src = src;
    const rm = el('button', '', icon('x'));
    rm.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); updateComposerState(); });
    chip.append(img, rm);
    box.appendChild(chip);
  });
}

/* ============================ camera / gallery ============================ */
let camStream = null;
async function openCamera() {
  const root = $('#camera-root');
  root.innerHTML = `<video id="camera-video" autoplay playsinline muted></video>
    <div class="camera-bar">
      <button class="icon-btn" id="camera-cancel">${icon('x')}</button>
      <button id="camera-snap" aria-label="Snap"></button>
      <span style="width:42px"></span>
    </div>`;
  root.hidden = false;
  emitLocal('back.push', 'camera');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
    $('#camera-video').srcObject = camStream;
  } catch (e) {
    toast('Camera unavailable: ' + e.name);
    closeCamera();
    return;
  }
  $('#camera-cancel').addEventListener('click', closeCamera);
  $('#camera-snap').addEventListener('click', () => {
    const v = $('#camera-video');
    const c = document.createElement('canvas');
    const scale = Math.min(1, 1280 / (v.videoWidth || 1280));
    c.width = (v.videoWidth || 1280) * scale; c.height = (v.videoHeight || 720) * scale;
    const ctx = c.getContext('2d');
    ctx.translate(c.width, 0); ctx.scale(-1, 1); // un-mirror the selfie snap
    ctx.drawImage(v, 0, 0, c.width, c.height);
    attachments.push(c.toDataURL('image/jpeg', 0.85));
    renderAttachments(); updateComposerState();
    closeCamera();
    toast('Photo attached');
  });
}
export function closeCamera() {
  try { camStream?.getTracks().forEach(t => t.stop()); } catch {}
  camStream = null;
  const root = $('#camera-root');
  root.hidden = true; root.innerHTML = '';
  emitLocal('back.pop', 'camera');
}
export const cameraOpen = () => !$('#camera-root').hidden;

function pickGallery() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', () => {
    const f = inp.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { attachments.push(String(r.result)); renderAttachments(); updateComposerState(); };
    r.readAsDataURL(f);
  });
  inp.click();
}

/* ============================ slash autocomplete ============================ */
function updateSlash() {
  const v = $('#composer-input').value;
  const m = v.match(/^\/(?:a(?:n(?:i(?:m(?:e)?)?)?)?)?(?:\s+([a-z]*))?$/i);
  const pop = $('#slash-pop');
  if (!v.startsWith('/') || !m || (v.includes(' ') && !/^\/anime\s/i.test(v))) { hideSlash(); return; }
  const q = (m[2] || '').toLowerCase();
  const items = ANIME_ACTIONS.filter(a => a.id.startsWith(q));
  if (!items.length) { hideSlash(); return; }
  pop.innerHTML = items.map(a => `<div class="slash-item" data-action="${a.id}">${icon(a.icon)}<span>/anime ${a.label.toLowerCase()}</span><span class="slash-desc">${a.desc}</span></div>`).join('');
  pop.hidden = false;
  $$('.slash-item', pop).forEach(n => n.addEventListener('click', () => {
    $('#composer-input').value = `/anime ${n.dataset.action}`;
    hideSlash();
    sendChat($('#composer-input').value);
  }));
}
function hideSlash() { $('#slash-pop').hidden = true; }

/* ============================ history drawer ============================ */
export function openDrawer() {
  renderDrawer();
  $('#drawer-scrim').hidden = false;
  const d = $('#drawer');
  d.hidden = false;
  requestAnimationFrame(() => d.classList.add('open'));
  emitLocal('back.push', 'drawer');
}
export function closeDrawer() {
  const d = $('#drawer');
  d.classList.remove('open');
  $('#drawer-scrim').hidden = true;
  setTimeout(() => { d.hidden = true; }, 220);
  emitLocal('back.pop', 'drawer');
}
export const drawerOpen = () => !$('#drawer').hidden;

function renderDrawer() {
  const d = $('#drawer');
  const groups = new Map();
  const sorted = [...store.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of sorted) {
    const g = dateGroup(t.updatedAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  d.innerHTML = `
    <div class="drawer-head"><img src="assets/logo-mark.svg" alt=""><b>Vani AI</b></div>
    <div class="drawer-new"><button class="btn-primary btn-block" id="drawer-new">${icon('plus')}<span>New Chat</span></button></div>
    <div class="drawer-threads">${[...groups.entries()].map(([g, ts]) => `
      <div class="drawer-group-label">${g}</div>
      ${ts.map(t => `<div class="thread-item${t.id === store.activeThreadId ? ' active' : ''}" data-id="${t.id}">
        <span class="thread-title">${esc(t.title)}</span>
        <button class="thread-kebab" data-kebab="${t.id}" aria-label="Chat options">${icon('more')}</button>
      </div>`).join('')}
    `).join('') || '<div class="muted small" style="padding:16px 10px">No conversations yet</div>'}</div>
    <div class="drawer-foot">
      <button class="drawer-foot-item" id="drawer-prompts">${icon('sparkles')}<span>System Prompt Studio</span></button>
      <button class="drawer-foot-item" id="drawer-models">${icon('box')}<span>Model Hub</span></button>
      <div class="drawer-version">Vani AI v1.4.0 · on-device</div>
    </div>`;
  $('#drawer-new').addEventListener('click', () => { store.newThread(); closeDrawer(); renderChat(); });
  $('#drawer-prompts').addEventListener('click', () => { closeDrawer(); openPromptStudio(); });
  $('#drawer-models').addEventListener('click', () => { closeDrawer(); emitLocal('nav', 'models'); });
  $$('.thread-item', d).forEach(n => n.addEventListener('click', e => {
    if (e.target.closest('[data-kebab]')) return;
    store.switchThread(n.dataset.id);
    closeDrawer(); renderChat();
  }));
  $$('[data-kebab]', d).forEach(n => n.addEventListener('click', e => {
    e.stopPropagation();
    threadActions(n.dataset.kebab);
  }));
}

function threadActions(id) {
  const t = store.threads.find(x => x.id === id);
  if (!t) return;
  emitLocal('sheet.open', {
    title: t.title,
    items: [
      { label: 'Rename', icon: 'edit', fn: () => renameDialog(t) },
      { label: 'Copy Full Transcript', icon: 'copy', fn: async () => { (await copyText(store.transcriptOf(t))) ? toast('Transcript copied') : toast('Copy failed'); } },
      { label: 'Delete', icon: 'trash', danger: true, fn: () => confirmDelete(t) },
    ],
  });
}

function renameDialog(t) {
  emitLocal('modal.open', {
    title: 'Rename chat',
    body: `<div class="field"><label>Title</label><input type="text" id="rename-input" value="${esc(t.title)}" maxlength="80"></div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Save', primary: true, fn: root => { store.renameThread(t.id, root.querySelector('#rename-input').value.trim()); renderChat(); if (drawerOpen()) renderDrawer(); } },
    ],
  });
}

function confirmDelete(t) {
  emitLocal('modal.open', {
    title: 'Delete chat?',
    body: `<p class="muted" style="font-size:14px">"${esc(t.title)}" will be permanently removed from this device.</p>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Delete', danger: true, fn: () => { store.deleteThread(t.id); renderChat(); if (drawerOpen()) renderDrawer(); toast('Chat deleted'); } },
    ],
  });
}

/* ============================ wiring ============================ */
export function initChat() {
  $('#btn-menu').innerHTML = icon('menu');
  $('#btn-prompt-studio').innerHTML = icon('sparkles');
  $('#btn-new-chat-top').innerHTML = icon('edit');
  $('#btn-attach').innerHTML = icon('camera');
  $('#btn-mic').innerHTML = icon('mic');
  $('#btn-auto-tts').innerHTML = icon('volumeOff');
  $('#btn-auto-tts').addEventListener('click', () => {
    const next = !store.settings.autoTts;
    store.setSetting('autoTts', next);
    if (next && activeGen) { autoSpeech.messageId = streamingMsgId; autoSpeech.consumed = 0; }
    if (!next) cancelChatSpeech();
    updateAutoTtsToggle();
  });
  $('#btn-send').innerHTML = icon('arrowUp');
  $('#btn-stop').innerHTML = icon('stop');
  $('#btn-live').innerHTML = icon('waveform');
  // Per-model thinking triangle toggle.
  const thinkBtn = $('#btn-think');
  if (thinkBtn) {
    thinkBtn.innerHTML = `<span class="think-tri">${icon('chevronRight')}</span><span class="think-label">Think</span>`;
    thinkBtn.addEventListener('click', toggleThinking);
    updateThinkToggle();
  }

  $('#btn-menu').addEventListener('click', openDrawer);
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  $('#btn-prompt-studio').addEventListener('click', openPromptStudio);
  $('#btn-new-chat-top').addEventListener('click', () => { store.newThread(); renderChat(); });
  $('#btn-send').addEventListener('click', () => sendChat($('#composer-input').value));
  $('#btn-stop').addEventListener('click', stopGeneration);
  $('#btn-live').addEventListener('click', () => emitLocal('live.open'));
  $('#btn-attach').addEventListener('click', () => emitLocal('sheet.open', {
    title: 'Attach image',
    items: [
      { label: 'Camera', icon: 'camera', fn: openCamera },
      { label: 'Gallery', icon: 'image', fn: pickGallery },
    ],
  }));

  const input = $('#composer-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    updateComposerState();
    updateSlash();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      sendChat(input.value);
    }
  });

  $('#btn-mic').addEventListener('click', async () => {
    if (dictating) { stopDictation(); setComposerStatus(''); return; }
    dictating = true;
    dictationBase = input.value;
    $('#btn-mic').innerHTML = icon('stop');
    setComposerStatus('Listening… speak now', 'listening');
    updateComposerState();
    const join = part => dictationBase + (dictationBase && part && !/\s$/.test(dictationBase) ? ' ' : '') + part;
    try {
      const text = await dictateOnce({
        onPartial: part => { input.value = join(part); updateComposerState(); },
      });
      input.value = text ? join(text) : dictationBase;
      setComposerStatus(text ? '' : 'No speech detected');
      if (text) input.focus();
      updateComposerState();
    } catch (e) {
      input.value = dictationBase;
      setComposerStatus(e.message || 'Dictation failed', 'error');
      updateComposerState();
    } finally {
      dictating = false;
      $('#btn-mic').innerHTML = icon('mic');
      updateComposerState();
    }
  });

  // Delegated code-copy buttons (chat + live overlay).
  document.addEventListener('click', async e => {
    const btn = e.target.closest('.copy-btn[data-code-id]');
    if (!btn) return;
    const code = getCode(btn.dataset.codeId);
    if (code !== undefined && await copyText(code)) {
      const span = btn.querySelector('span');
      const old = span.textContent;
      btn.querySelector('svg').outerHTML = icon('check');
      span.textContent = 'Copied';
      setTimeout(() => { btn.querySelector('svg').outerHTML = icon('copy'); span.textContent = old; }, 1600);
    } else toast('Copy failed');
  });

  on('threads.changed', () => { if (!activeGen) renderChat(); if (drawerOpen()) renderDrawer(); });
  on('llm.statusChanged', () => { updateThinkToggle(); if (!activeGen) renderChat(); });
  on('modelThinking.changed', () => updateThinkToggle());
  on('settings.changed', p => {
    if (p.key === 'showReasoning' && !activeGen) renderChat();
    if (p.key === 'autoTts') { if (!store.settings.autoTts) cancelChatSpeech(); updateAutoTtsToggle(); }
  });
  on('live.transcript', () => { if (!activeGen) renderChat(); });
  on('app.background', () => {
    if (dictating) { stopDictation(); dictating = false; $('#btn-mic').innerHTML = icon('mic'); setComposerStatus(''); }
    cancelChatSpeech(); updateComposerState();
  });

  renderChat();
}
