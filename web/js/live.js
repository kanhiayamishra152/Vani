// Vani AI — Module 2: full-screen Live Talk (Liquid-AI-style) with OC-Lily.
// WebGL lives ONLY here; closing or backgrounding releases everything.
// The whole spoken conversation is preserved as chat bubbles in the thread.
import { $, $$, el, esc, throttle } from './util.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { on, hasNative, emitLocal } from './bridge.js';
import { settings } from './store.js';
import * as store from './store.js';
import { renderMarkdown, splitReasoning, hasCodeOrMath } from './markdown.js';
import { llm, isReady, generate, buildContextMessages } from './inference.js';
import { AvatarStage } from './avatar.js';
import { ANIME_ACTIONS } from './catalog.js';
import * as voice from './voice.js';

let open = false;
let avatar = null;
let mode = 'vad';
let muted = false;
let gen = null;
let pendingAction = null;
let speechQueue = [];
let speaking = false;
let sentenceBuf = '';
let assistantMsg = null;
let rawReply = '';
let overlayShown = false;
let pttHeld = false;
let listeningActive = false;

export const isLiveOpen = () => open;

/* ============================ open / close ============================ */
export async function openLive(opts = {}) {
  if (open) { if (opts.action) avatar?.performAction(opts.action); return; }
  open = true;
  pendingAction = opts.action || null;
  const root = $('#live-root');
  root.hidden = false;
  emitLocal('back.push', 'live');
  root.innerHTML = `
    <div id="live-stage"></div>
    <div class="live-top">
      <div class="live-title"><b>Live Talk</b>
        <span class="live-status"><span class="live-dot listening" id="live-dot"></span><span id="live-status-text">Waking up…</span></span>
      </div>
      <button id="live-close" aria-label="End Live Talk">${icon('x')}</button>
    </div>
    <div class="live-captions" id="live-captions"></div>
    <div id="live-overlay-slot"></div>
    <div class="live-dock">
      <div class="live-mode-row">
        <button class="pill${mode === 'vad' ? ' active' : ''}" data-mode="vad">Hands-free</button>
        <button class="pill${mode === 'ptt' ? ' active' : ''}" data-mode="ptt">Hold to Talk</button>
      </div>
      <div class="live-controls">
        <button class="live-side-btn" id="live-cmds" aria-label="Actions">${icon('sparkles')}</button>
        <button id="live-ptt" aria-label="Talk">${icon('mic')}</button>
        <button class="live-side-btn" id="live-mute" aria-label="Mute">${icon('volume')}</button>
      </div>
      <div class="live-hint" id="live-hint"></div>
    </div>`;

  // Unconditional close: even if teardown throws, Live Talk ALWAYS closes.
  $('#live-close').addEventListener('click', () => closeLive());
  $$('.live-mode-row .pill', root).forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#live-cmds').addEventListener('click', openCommandSheet);
  $('#live-mute').addEventListener('click', toggleMute);
  wirePtt();

  store.ensureThread();
  setStatus('Loading OC-Lily…');
  avatar = new AvatarStage($('#live-stage'), {
    batterySaver: () => settings.batterySaver,
    fpsTarget: () => settings.fpsTarget,
    onArrive: () => {
      if (pendingAction) { avatar?.performAction(pendingAction); pendingAction = null; }
      speakDirect('Hello!');
    },
    onError: () => {
      $('#live-stage').innerHTML = `<div class="live-fallback"><div><img src="assets/logo-mark.svg" style="width:52px;height:52px;margin-bottom:14px" alt=""><p>OC-Lily.vrm is bundled in the Android APK.<br>The web preview cannot fetch Google Drive assets.</p></div></div>`;
    },
  });
  try {
    await avatar.init();
    avatar.walkIn();
    setStatus('Walking in…');
  } catch { /* fallback panel already shown */ }

  await setupVoice();
}

export async function closeLive() {
  try {
    gen?.stop(); gen = null;
    speechQueue = [];
    voice.stopSpeech();
    await voice.stopListening();
    listeningActive = false;
    avatar?.dispose();
    avatar = null;
  } catch (e) {
    console.warn('live teardown', e);
  } finally {
    open = false;
    const root = $('#live-root');
    root.hidden = true;
    root.innerHTML = '';
    emitLocal('back.pop', 'live');
    emitLocal('live.transcript', {});
  }
}

/* ============================ voice loop ============================ */
async function setupVoice() {
  const hint = $('#live-hint');
  if (!hasNative()) { hint.textContent = 'Web preview — install the APK for the hands-free voice loop.'; return; }
  await voice.configureVoice();
  if (!isReady()) { hint.textContent = 'Load a model in Model Hub to talk. Avatar actions still work.'; }
  else if (!voice.offlineVoiceReady()) { hint.textContent = 'Tip: install Whisper (Supplementary) for fully offline ears. Using the Android recognizer for now.'; }
  else { hint.textContent = mode === 'vad' ? 'Just speak — I am listening.' : 'Hold the mic button to talk.'; }
  if (mode === 'vad' && !muted) await startVad();
}

async function startVad() {
  if (listeningActive || !hasNative()) return;
  try {
    await voice.startListening('vad', {
      onSpeechStart: bargeIn,
      onFinal: handleUserUtterance,
      onError: e => { $('#live-hint') && ($('#live-hint').textContent = e.message); },
    });
    listeningActive = true;
    if (!gen && !speaking) setStatus('Listening');
  } catch (e) {
    $('#live-hint') && ($('#live-hint').textContent = e.message);
  }
}

async function stopVad() {
  if (!listeningActive) return;
  listeningActive = false;
  await voice.stopListening();
}

function bargeIn() {
  // <50ms interruption: native side already stopped TTS on VAD trigger;
  // here we halt generation + queued speech and flush the partial reply.
  speechQueue = [];
  voice.stopSpeech();
  avatar?.setSpeaking(0);
  if (gen) { gen.stop(); gen = null; flushReply(); }
  setStatus('Listening');
}

function setMode(m) {
  mode = m;
  $$('.live-mode-row .pill').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  if (m === 'vad') { if (!muted) startVad(); $('#live-hint').textContent = 'Just speak — I am listening.'; }
  else { stopVad(); $('#live-hint').textContent = 'Hold the mic button to talk.'; }
}

function toggleMute() {
  muted = !muted;
  $('#live-mute').innerHTML = icon(muted ? 'micOff' : 'volume');
  $('#live-mute').classList.toggle('muted', muted);
  if (muted) stopVad();
  else if (mode === 'vad') startVad();
  toast(muted ? 'Microphone muted' : 'Microphone live');
}

function wirePtt() {
  const btn = $('#live-ptt');
  const down = async e => {
    e.preventDefault();
    if (!hasNative()) { toast('Voice needs the Android app'); return; }
    if (mode === 'vad') { bargeIn(); return; }
    if (pttHeld) return;
    pttHeld = true;
    btn.classList.add('holding');
    bargeIn();
    try {
      if (!listeningActive) {
        await voice.startListening('ptt', { onFinal: handleUserUtterance, onError: err => toast(err.message) });
        listeningActive = true;
      }
      setStatus('Listening… release to send');
    } catch (err) { toast(err.message); pttHeld = false; btn.classList.remove('holding'); }
  };
  const up = () => {
    if (!pttHeld) return;
    pttHeld = false;
    btn.classList.remove('holding');
    voice.pttRelease();
    setStatus('Thinking…');
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
}

/* ============================ conversation ============================ */
function handleUserUtterance(text) {
  if (!open || !text?.trim()) return;
  const anime = text.trim().match(/^\/anime\s+([a-z]+)/i);
  if (anime) { avatar?.performAction(anime[1].toLowerCase()); return; }
  bargeIn();
  store.addMessage('user', text, { live: true });
  addCaption('user', text);
  if (!isReady()) {
    const reply = 'Please load a model in the Model Hub first, then we can talk.';
    store.addMessage('assistant', reply, { live: true });
    addCaption('assistant', reply);
    speakDirect(reply);
    return;
  }
  setStatus('Thinking…');
  assistantMsg = store.addMessage('assistant', '', { live: true });
  rawReply = '';
  sentenceBuf = '';
  spokenConsumed = 0;
  speaking = false;
  overlayShown = false;
  const t = store.getThread();
  const messages = buildContextMessages(t.messages.filter(m => m.id !== assistantMsg.id), store.activePrompt().text, settings.maxTokens);
  const cap = addCaption('assistant', '');
  const paint = throttle(() => {
    const { content } = splitReasoning(rawReply);
    cap.textContent = content.slice(-220);
    scrollCaptions();
    maybeOverlay(content);
  }, 150);

  gen = generate({
    messages,
    onToken: tok => {
      rawReply += tok;
      const { content } = splitReasoning(rawReply);
      feedSpeech(content);
      paint();
    },
    onDone: () => { gen = null; flushReply(); feedSpeech(null); },
    onError: e => { gen = null; flushReply(); toast(e.message); setStatus('Listening'); },
  });
}

function flushReply() {
  if (assistantMsg) { store.updateMessage(assistantMsg.id, { content: rawReply }); assistantMsg = null; }
}

/** Sentence-level streaming TTS with code/math stripped from speech. */
function feedSpeech(content) {
  if (content === null) { // flush remainder
    const rest = sentenceBuf.trim(); sentenceBuf = '';
    if (rest) enqueueSpeech(rest);
    return;
  }
  sentenceBuf = content.slice(spokenConsumed);
  let m;
  const re = /[.!?।]\s+|\n+/g;
  let lastCut = 0;
  while ((m = re.exec(sentenceBuf))) lastCut = m.index + 1;
  if (lastCut > 0) {
    const part = sentenceBuf.slice(0, lastCut);
    spokenConsumed += lastCut;
    sentenceBuf = sentenceBuf.slice(lastCut);
    enqueueSpeech(part);
  }
}
let spokenConsumed = 0;

function enqueueSpeech(text) {
  let clean = text
    .replace(/```[\s\S]*?```/g, ' I have put the code on screen. ')
    .replace(/```[\s\S]*$/g, ' I am writing the code on screen. ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' the formula is on screen ')
    .replace(/\$[^$\n]*\$/g, ' the expression ')
    .replace(/[*_#`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return;
  speechQueue.push(clean);
  if (!speaking) speakNext();
}

function speakNext() {
  const text = speechQueue.shift();
  if (!text) {
    speaking = false;
    avatar?.setSpeaking(0);
    if (open && !gen) setStatus(mode === 'vad' && !muted ? 'Listening' : 'Ready');
    return;
  }
  speaking = true;
  setStatus('Speaking');
  voice.speak(text, {
    onLevel: l => avatar?.setSpeaking(l),
    onEnd: () => { speaking = false; avatar?.setSpeaking(0); speakNext(); },
  });
}

function speakDirect(text) {
  if (!open) return;
  speechQueue = [text];
  if (!speaking) speakNext();
}

/* ============================ captions & overlay ============================ */
function addCaption(role, text) {
  const box = $('#live-captions');
  if (!box) return null;
  const cap = el('div', `live-cap ${role}`);
  cap.textContent = text;
  box.appendChild(cap);
  while (box.children.length > 6) box.firstChild.remove();
  scrollCaptions();
  return cap;
}
function scrollCaptions() { const b = $('#live-captions'); if (b) b.scrollTop = b.scrollHeight; }

function maybeOverlay(content) {
  if (overlayShown || !hasCodeOrMath(content)) return;
  overlayShown = true;
  const slot = $('#live-overlay-slot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="live-overlay-card">
      <div class="live-overlay-head"><span>Code & Math</span><button class="icon-btn" id="overlay-close" style="width:32px;height:32px">${icon('x')}</button></div>
      <div class="live-overlay-body msg-text" id="overlay-body"></div>
    </div>`;
  const paint = throttle(() => {
    const body = $('#overlay-body');
    if (body) { body.innerHTML = renderMarkdown(splitReasoning(rawReply).content); body.scrollTop = body.scrollHeight; }
  }, 300);
  const off = on('llm.token', paint);
  const offDone = on('llm.done', () => { paint(); off(); offDone(); });
  $('#overlay-close').addEventListener('click', () => { slot.innerHTML = ''; off(); offDone(); });
}

function setStatus(text) {
  const n = $('#live-status-text');
  if (n) n.textContent = text;
  const dot = $('#live-dot');
  if (dot) dot.classList.toggle('listening', /listen/i.test(text));
}

/* ============================ command sheet ============================ */
function openCommandSheet() {
  emitLocal('sheet.open', {
    title: '/anime actions',
    custom: root => {
      const grid = el('div', 'anime-grid');
      grid.innerHTML = ANIME_ACTIONS.map(a => `<button data-a="${a.id}">${icon(a.icon)}<span>${a.label}</span></button>`).join('');
      root.appendChild(grid);
      $$('button', grid).forEach(b => b.addEventListener('click', () => {
        emitLocal('sheet.close');
        const action = b.dataset.a;
        store.addMessage('user', `/anime ${action}`, { live: true });
        avatar?.performAction(action);
      }));
    },
  });
}

/* ============================ lifecycle ============================ */
export function initLive() {
  on('live.open', opts => openLive(opts || {}));
  on('anime.command', ({ action }) => {
    if (open) avatar?.performAction(action);
    else openLive({ action });
  });
  on('app.background', () => {
    if (!open) return;
    avatar?.pause();
    stopVad();
    voice.stopSpeech();
    speechQueue = [];
    if (gen) { gen.stop(); gen = null; flushReply(); }
  });
  on('app.foreground', () => {
    if (!open) return;
    avatar?.resume();
    if (mode === 'vad' && !muted) startVad();
  });
  on('voice.reconfigure', async () => {
    if (!open) return;
    await voice.configureVoice();
  });
  on('voice.engineFallback', ({ engine }) => {
    if (open) toast(`${engine} voice not installed — using Phonon. Get it in Model Hub → Supplementary.`);
  });
  on('voice.ttsError', ({ error }) => { if (open) toast('TTS: ' + error); });
  // Reset per-reply speech cursor.
  on('live.transcript', () => { spokenConsumed = 0; });
}
