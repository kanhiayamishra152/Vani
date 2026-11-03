// Vani AI — Module 2: full-screen Live Talk with OC-Lily.
// v1.3.0: floating answer card above the avatar (tap to expand into a full
// reader with Copy / Copy Code / KaTeX), one-tap Chat History sheet, and a
// Keyboard input bar so you can type to the character while she animates.
import { $, $$, el, esc, throttle } from './util.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { on, hasNative, emitLocal } from './bridge.js';
import { settings } from './store.js';
import * as store from './store.js';
import { renderMarkdown, splitReasoning, getCode } from './markdown.js';
import { copyText } from './util.js';
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
let pttHeld = false;
let listeningActive = false;
let thinkWatchdog = null;
let thinkReassure = null;
let spokenConsumed = 0;
let lastAnswer = '';      // full text of the most recent reply (for the reader)

function clearThinkWatchdog() {
  if (thinkWatchdog) { clearTimeout(thinkWatchdog); thinkWatchdog = null; }
  if (thinkReassure) { clearTimeout(thinkReassure); thinkReassure = null; }
}

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
      <div class="live-top-actions">
        <button id="live-history-open" class="live-top-btn" aria-label="Chat History">${icon('menu')}<span>History</span></button>
        <button id="live-close" aria-label="End Live Talk">${icon('x')}</button>
      </div>
    </div>
    <button id="live-answer" class="live-answer" hidden aria-label="Read the answer">
      <span class="live-answer-text" id="live-answer-text"></span>
      <span class="live-answer-hint">${icon('more')} Tap to read</span>
    </button>
    <div id="live-reader" class="live-reader" hidden>
      <div class="live-reader-head">
        <button class="btn-secondary btn-sm" id="live-reader-back">${icon('chevronLeft')} Back to Avatar</button>
        <button class="btn-secondary btn-sm" id="live-reader-copy">${icon('copy')} Copy</button>
      </div>
      <div class="live-reader-body msg-text" id="live-reader-body"></div>
    </div>
    <div id="live-history" class="live-history" hidden>
      <div class="live-history-head"><b>Chat History</b><button class="icon-btn" id="live-history-close" aria-label="Close history">${icon('x')}</button></div>
      <div class="live-history-body" id="live-history-body"></div>
    </div>
    <div class="live-dock">
      <div class="live-mode-row">
        <button class="pill${mode === 'vad' ? ' active' : ''}" data-mode="vad">Hands-free</button>
        <button class="pill${mode === 'ptt' ? ' active' : ''}" data-mode="ptt">Hold to Talk</button>
      </div>
      <div class="live-controls">
        <button class="live-side-btn" id="live-cmds" aria-label="Actions">${icon('sparkles')}</button>
        <button id="live-ptt" aria-label="Talk">${icon('mic')}</button>
        <button class="live-side-btn" id="live-keyboard-toggle" aria-label="Keyboard">${icon('edit')}</button>
        <button class="live-side-btn" id="live-mute" aria-label="Mute">${icon('volume')}</button>
      </div>
      <div class="live-hint" id="live-hint"></div>
    </div>
    <div id="live-keyboard" class="live-keyboard" hidden>
      <input id="live-kb-input" type="text" placeholder="Type a message or /anime command to OC-Lily…" autocomplete="off">
      <button id="live-kb-send" class="btn-primary btn-sm" aria-label="Send">${icon('send')}</button>
    </div>`;

  $('#live-close').addEventListener('click', () => closeLive());
  $$('.live-mode-row .pill', root).forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#live-cmds').addEventListener('click', openCommandSheet);
  $('#live-mute').addEventListener('click', toggleMute);
  $('#live-history-open').addEventListener('click', openHistory);
  $('#live-history-close').addEventListener('click', closeHistory);
  $('#live-answer').addEventListener('click', openReader);
  $('#live-reader-back').addEventListener('click', closeReader);
  $('#live-reader-copy').addEventListener('click', async () => { (await copyText(lastAnswer)) ? toast('Copied') : toast('Copy failed'); });
  $('#live-keyboard-toggle').addEventListener('click', toggleKeyboard);
  $('#live-kb-send').addEventListener('click', sendKeyboardMessage);
  $('#live-kb-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendKeyboardMessage(); } });
  wireReaderCodeCopy();
  wirePtt();

  store.ensureThread();
  if (avatar && avatar.renderer && !avatar.disposed) {
    avatar.remount($('#live-stage'));
    if (pendingAction) { avatar.performAction(pendingAction); pendingAction = null; }
  } else {
    setStatus('Loading OC-Lily…');
    avatar = new AvatarStage($('#live-stage'), {
      batterySaver: () => settings.batterySaver,
      fpsTarget: () => settings.fpsTarget,
      onProgress: (stage, p) => {
        const label = stage === 'mesh' ? `Loading avatar mesh… ${Math.round(p * 100)}%`
          : stage === 'shaders' ? 'Compiling shaders…' : 'Ready';
        setStatus(label);
      },
      onArrive: () => {
        if (pendingAction) { avatar?.performAction(pendingAction); pendingAction = null; }
        speakDirect('Hello!');
      },
      onError: () => {
        const stage = $('#live-stage');
        if (stage) stage.innerHTML = `<div class="live-fallback"><div><img src="assets/logo-mark.svg" style="width:52px;height:52px;margin-bottom:14px" alt=""><p>OC-Lily.vrm is bundled in the Android APK.<br>The web preview cannot fetch Google Drive assets.</p></div></div>`;
      },
    });
    try {
      await avatar.init();
      avatar.walkIn();
      setStatus('Walking in…');
    } catch { /* fallback panel already shown */ }
  }

  await setupVoice();
}

export async function closeLive() {
  try {
    gen?.stop(); gen = null;
    clearThinkWatchdog();
    speechQueue = [];
    voice.stopSpeech();
    await voice.stopListening();
    listeningActive = false;
    avatar?.pause();
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

/* ============================ floating answer / reader / history / keyboard ============================ */
function updateAnswerCard() {
  const card = $('#live-answer'), txt = $('#live-answer-text');
  if (!card || !txt) return;
  const { content } = splitReasoning(rawReply);
  if (!content.trim()) { card.hidden = true; return; }
  card.hidden = false;
  txt.textContent = content.length > 160 ? '…' + content.slice(-160) : content;
}

function openReader() {
  const reader = $('#live-reader'), body = $('#live-reader-body');
  if (!reader || !body) return;
  lastAnswer = splitReasoning(rawReply).content || lastAnswer;
  body.innerHTML = renderMarkdown(lastAnswer);
  body.scrollTop = 0;
  reader.hidden = false;
}
function closeReader() { const r = $('#live-reader'); if (r) r.hidden = true; }

function wireReaderCodeCopy() {
  // Delegate Copy Code clicks inside the reader (code cards carry data-code-id).
  $('#live-reader-body')?.addEventListener('click', async e => {
    const btn = e.target.closest?.('[data-code-id]');
    if (!btn) return;
    const code = getCode(btn.dataset.codeId);
    if (code != null) (await copyText(code)) ? toast('Code copied') : toast('Copy failed');
  });
}

function openHistory() {
  const sheet = $('#live-history'), body = $('#live-history-body');
  if (!sheet || !body) return;
  const t = store.getThread();
  const msgs = t?.messages || [];
  body.innerHTML = msgs.length
    ? msgs.map(m => `<div class="live-history-msg ${m.role}"><div class="live-history-role">${m.role === 'user' ? 'You' : 'OC-Lily'}</div><div class="msg-text">${m.role === 'assistant' ? renderMarkdown(splitReasoning(m.content || '').content) : esc(m.content || '')}</div></div>`).join('')
    : '<div class="live-history-empty">No messages yet — say hello!</div>';
  sheet.hidden = false;
  body.scrollTop = body.scrollHeight;
}
function closeHistory() { const h = $('#live-history'); if (h) h.hidden = true; }

function toggleKeyboard() {
  const kb = $('#live-keyboard');
  if (!kb) return;
  kb.hidden = !kb.hidden;
  $('#live-keyboard-toggle').classList.toggle('active', !kb.hidden);
  if (!kb.hidden) { stopVad(); $('#live-kb-input').focus(); }
  else if (mode === 'vad' && !muted) startVad();
}

function sendKeyboardMessage() {
  const input = $('#live-kb-input');
  const text = input?.value.trim();
  if (!text) return;
  input.value = '';
  const anime = text.match(/^\/anime\s+([a-z]+)/i);
  if (anime) { avatar?.performAction(anime[1].toLowerCase()); return; }
  handleUserUtterance(text);
}

/* ============================ voice loop ============================ */
async function setupVoice() {
  const hint = $('#live-hint');
  if (!hasNative()) { hint.textContent = 'Web preview — install the APK for the hands-free voice loop.'; return; }
  await voice.configureVoice();
  if (!isReady()) { hint.textContent = 'Load a model in Model Hub to talk. Avatar actions still work.'; }
  else if (!voice.offlineVoiceReady()) { hint.textContent = 'Tip: install Whisper (Supplementary) for fully offline ears. Using the Android recognizer for now.'; }
  else { hint.textContent = mode === 'vad' ? 'Just speak — I am listening.' : 'Hold the mic button to talk.'; }
  if (mode === 'vad' && !muted && $('#live-keyboard')?.hidden) await startVad();
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
  speechQueue = [];
  voice.stopSpeech();
  avatar?.setSpeaking(0);
  clearThinkWatchdog();
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
  if (!isReady()) {
    const reply = 'Please load a model in the Model Hub first, then we can talk.';
    store.addMessage('assistant', reply, { live: true });
    lastAnswer = reply; rawReply = reply; updateAnswerCard();
    speakDirect(reply);
    return;
  }
  setStatus('Thinking…');
  avatar?.performAction('think');
  assistantMsg = store.addMessage('assistant', '', { live: true });
  const replyId = assistantMsg.id;
  rawReply = '';
  sentenceBuf = '';
  spokenConsumed = 0;
  speaking = false;
  const t = store.getThread();
  const thinkOn = store.getModelThinking(llm.info?.name || llm.info?.modelPath || 'default');
  let sysText = store.activePrompt().text;
  if (!thinkOn) sysText += '\n\nRespond directly with the final answer only. Do not show step-by-step reasoning and do not use  tags.';
  const messages = buildContextMessages(t.messages.filter(m => m.id !== assistantMsg.id), sysText, settings.maxTokens);
  const paint = throttle(() => { updateAnswerCard(); }, 120);

  let gotToken = false;
  clearThinkWatchdog();
  const armStall = () => {
    if (thinkWatchdog) clearTimeout(thinkWatchdog);
    thinkWatchdog = setTimeout(() => {
      if (!open) return;
      if (gen) { gen.stop(); gen = null; }
      if (assistantMsg) { store.updateMessage(assistantMsg.id, { content: rawReply }); assistantMsg = null; }
      if (!rawReply.trim()) {
        const msg = 'Sorry, that took too long. Please try again.';
        store.updateMessage(replyId, { content: msg });
        lastAnswer = msg; rawReply = msg; updateAnswerCard();
        speakDirect(msg);
      } else {
        feedSpeech(null);
      }
      setStatus(mode === 'vad' && !muted ? 'Listening' : 'Ready');
    }, 30000);
  };
  thinkReassure = setTimeout(() => { if (!gotToken && open && gen) setStatus('Still thinking…'); }, 4000);
  armStall();

  gen = generate({
    messages, thinking: thinkOn,
    onToken: tok => {
      if (!gotToken) { gotToken = true; if (thinkReassure) { clearTimeout(thinkReassure); thinkReassure = null; } }
      armStall();
      rawReply += tok;
      const { content } = splitReasoning(rawReply);
      feedSpeech(content);
      paint();
    },
    onDone: () => { gen = null; clearThinkWatchdog(); flushReply(); feedSpeech(null); lastAnswer = splitReasoning(rawReply).content; updateAnswerCard(); },
    onError: e => { gen = null; clearThinkWatchdog(); flushReply(); toast(e.message); setStatus(mode === 'vad' && !muted ? 'Listening' : 'Ready'); },
  });
}

function flushReply() {
  if (assistantMsg) { store.updateMessage(assistantMsg.id, { content: rawReply }); assistantMsg = null; }
}

/** Sentence-level streaming TTS: feed each clause to the voice while the LLM
 *  keeps generating the next sentence in parallel (code/math stripped). */
function feedSpeech(content) {
  if (content === null) {
    const rest = sentenceBuf.trim(); sentenceBuf = '';
    if (rest) enqueueSpeech(rest);
    return;
  }
  sentenceBuf = content.slice(spokenConsumed);
  let m;
  const re = /[.!?।,]\s+|\n+/g;
  let lastCut = 0;
  while ((m = re.exec(sentenceBuf))) lastCut = m.index + 1;
  if (lastCut > 0) {
    const part = sentenceBuf.slice(0, lastCut);
    spokenConsumed += lastCut;
    sentenceBuf = sentenceBuf.slice(lastCut);
    enqueueSpeech(part);
  }
}

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
        avatar?.performAction(b.dataset.a);
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
    clearThinkWatchdog();
    if (gen) { gen.stop(); gen = null; flushReply(); }
  });
  on('app.foreground', () => {
    if (!open) return;
    avatar?.resume();
    if (mode === 'vad' && !muted && $('#live-keyboard')?.hidden) startVad();
  });
  on('voice.reconfigure', async () => { if (open) await voice.configureVoice(); });
  on('voice.engineFallback', ({ engine }) => { if (open) toast(`${engine} voice not installed — using Phonon. Get it in Model Hub → Supplementary.`); });
  on('voice.ttsError', ({ error }) => { if (open) toast('TTS: ' + error); });
  on('live.transcript', () => { spokenConsumed = 0; });
  // Anti-freeze circuit breaker: on memory pressure drop the avatar's GPU load.
  // Critical pressure fully disposes the WebGL context + VRM to return VRAM;
  // the singleton reloads safely on the next Live open.
  on('memory.pressure', p => {
    if (!avatar) return;
    if (p && p.level === 'critical') { try { avatar.dispose(); } catch {} avatar = null; }
    else avatar.pause();
  });
}
