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
let closing = false;
let liveSession = 0;
let listeningPromise = null;
let avatar = null;
let avatarInitPromise = null;
let avatarLoadFailed = false;
let mode = 'vad';
let muted = false;
let gen = null;
let conversationTurn = 0;
let pendingAction = null;
let speechQueue = [];
let speaking = false;
let sentenceBuf = '';
let assistantMsg = null;
let rawReply = '';
let pttHeld = false;
let listeningActive = false;
let listeningMode = null;
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
  if (open) { if (!closing && opts.action) avatar?.performAction(opts.action); return; }
  const session = ++liveSession;
  open = true;
  closing = false;
  pendingAction = opts.action || null;
  const root = $('#live-root');
  root.hidden = false;
  emitLocal('back.push', 'live');
  root.innerHTML = `
    <div id="live-typography" aria-hidden="true"><span id="live-bg-text"></span></div>
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
    const stage = avatar;
    stage.remount($('#live-stage'));
    if (avatarLoadFailed) showAvatarFallback();
    else if (!stage.vrm && avatarInitPromise) {
      try { await avatarInitPromise; }
      catch (e) {
        avatarLoadFailed = true;
        if (avatar === stage) avatarInitPromise = null;
        if (session === liveSession && open) showAvatarFallback();
        console.warn('avatar remount init', e);
      }
      if (session !== liveSession || !open || closing || avatar !== stage) return;
      if (!avatarLoadFailed && stage.vrm) { stage.walkIn(); setStatus('Walking in…'); }
    }
    if (pendingAction && stage.vrm) { stage.performAction(pendingAction); pendingAction = null; }
  } else {
    setStatus('Loading OC-Lily…');
    avatarLoadFailed = false;
    avatar = new AvatarStage($('#live-stage'), {
      batterySaver: () => settings.batterySaver,
      fpsTarget: () => settings.fpsTarget,
      onProgress: (stage, p) => {
        if (session !== liveSession || !open) return;
        const label = stage === 'mesh' ? `Loading avatar mesh… ${Math.round(p * 100)}%`
          : stage === 'shaders' ? 'Compiling shaders…' : 'Ready';
        setStatus(label);
      },
      onArrive: () => {
        if (session !== liveSession || !open || closing) return;
        if (pendingAction) { avatar?.performAction(pendingAction); pendingAction = null; }
        speakDirect('Hello!');
      },
      onError: () => { if (session === liveSession && open) showAvatarFallback(); },
    });
    const created = avatar;
    try {
      avatarInitPromise = created.init();
      await avatarInitPromise;
      if (avatar === created) avatarInitPromise = null;
      if (session !== liveSession || !open || closing || avatar !== created) return;
      created.walkIn();
      setStatus('Walking in…');
    } catch (e) {
      avatarLoadFailed = true;
      if (avatar === created) { created.pause(); avatarInitPromise = null; }
      if (session === liveSession && open) showAvatarFallback();
      console.warn('avatar init', e);
    }
  }

  if (session === liveSession && open && !closing) await setupVoice(session);
}

function showAvatarFallback() {
  const stage = $('#live-stage');
  if (!stage) return;
  stage.querySelector('.live-fallback')?.remove();
  const panel = document.createElement('div');
  panel.className = 'live-fallback';
  panel.innerHTML = `<div><img src="assets/logo-mark.svg" style="width:52px;height:52px;margin-bottom:14px" alt=""><p>OC-Lily.vrm is bundled in the Android APK.<br>The web preview cannot fetch Google Drive assets.</p></div>`;
  // Keep the singleton canvas attached; the fallback is an overlay, not a
  // replacement that would cause a black/remount transition on the next open.
  stage.appendChild(panel);
}

export async function closeLive() {
  if (closing) return;
  closing = true;
  ++liveSession; // invalidate every async callback owned by the old session
  ++conversationTurn;
  try {
    gen?.stop(); gen = null;
    flushReply();
    clearThinkWatchdog();
    speechQueue = [];
    speaking = false;
    voice.stopSpeech();
    // Keep the singleton (and an in-flight first load) for a fast remount;
    // session invalidation above prevents it from restarting voice after close.
    avatar?.pause();
    await stopVad();
  } catch (e) {
    console.warn('live teardown', e);
    listeningActive = false;
  } finally {
    open = false;
    closing = false;
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
  const bg = $('#live-bg-text');
  if (bg) bg.textContent = content;
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
async function setupVoice(session = liveSession) {
  const hint = $('#live-hint');
  if (!hasNative()) { if (hint) hint.textContent = 'Web preview — install the APK for the hands-free voice loop.'; return; }
  try { await voice.configureVoice(); }
  catch (e) { if (hint && session === liveSession) hint.textContent = e.message || 'Selected voice is unavailable'; }
  if (session !== liveSession || !open || closing) return;
  if (!isReady()) { hint.textContent = 'Load a model in Model Hub to talk. Avatar actions still work.'; }
  else if (!voice.offlineVoiceReady()) { hint.textContent = 'Tip: install Whisper (Supplementary) for fully offline ears. Using the Android recognizer for now.'; }
  else { hint.textContent = mode === 'vad' ? 'Just speak — I am listening.' : 'Hold the mic button to talk.'; }
  if (mode === 'vad' && !muted && $('#live-keyboard')?.hidden) await startVad();
}

async function startVad() {
  if (!open || closing || listeningActive || !hasNative()) return;
  if (listeningPromise) {
    const pending = listeningPromise;
    Promise.resolve(pending).finally(() => {
      if (open && !closing && mode === 'vad' && !muted && $('#live-keyboard')?.hidden && !listeningActive && !listeningPromise) startVad();
    });
    return;
  }
  const session = liveSession;
  listeningPromise = (async () => {
    try {
      const started = await voice.startListening('vad', {
        onSpeechStart: () => { if (session === liveSession) bargeIn(); },
        onFinal: text => { if (session === liveSession) handleUserUtterance(text); },
        onError: e => { if (session === liveSession && $('#live-hint')) $('#live-hint').textContent = e.message; },
      });
      if (!started) return;
      if (session !== liveSession || !open || closing) { await voice.stopListening(); return; }
      listeningActive = true;
      listeningMode = 'vad';
      if (!gen && !speaking) setStatus('Listening');
    } catch (e) {
      if (session === liveSession && $('#live-hint')) $('#live-hint').textContent = e.message;
    } finally {
      listeningPromise = null;
    }
  })();
  return listeningPromise;
}

async function stopVad() {
  const pending = listeningPromise;
  if (!pending && !listeningActive) return;
  listeningActive = false;
  listeningMode = null;
  // Invalidate listenSeq before waiting for permission/model initialization.
  await voice.stopListening();
  if (pending) {
    try { await pending; } catch { /* the start path reports its own error */ }
  }
}

function bargeIn() {
  ++conversationTurn;
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
    if (pttHeld || closing) return;
    const session = liveSession;
    pttHeld = true;
    btn.classList.add('holding');
    bargeIn();
    try {
      if (listeningPromise || (listeningActive && listeningMode !== 'ptt')) await stopVad();
      if (session !== liveSession || !open || closing) { pttHeld = false; btn.classList.remove('holding'); return; }
      if (!listeningActive) {
        const starting = voice.startListening('ptt', {
          onFinal: text => { if (session === liveSession) handleUserUtterance(text); },
          onError: err => { if (session === liveSession) toast(err.message); },
        });
        listeningPromise = starting;
        let started;
        try { started = await starting; }
        finally { if (listeningPromise === starting) listeningPromise = null; }
        if (!started) { pttHeld = false; btn.classList.remove('holding'); return; }
        if (session !== liveSession || !open || closing) {
          await voice.stopListening();
          pttHeld = false; btn.classList.remove('holding'); return;
        }
        listeningActive = true;
        listeningMode = 'ptt';
      }
      setStatus('Listening… release to send');
    } catch (err) {
      if (session === liveSession) toast(err.message);
      pttHeld = false; btn.classList.remove('holding');
    }
  };
  const up = async () => {
    if (!pttHeld) return;
    pttHeld = false;
    btn.classList.remove('holding');
    const pending = listeningPromise;
    if (pending) { try { await pending; } catch { return; } }
    if (!open || closing || !listeningActive || listeningMode !== 'ptt') return;
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
  if (!open || closing || !text?.trim()) return;
  const session = liveSession;
  const anime = text.trim().match(/^\/anime\s+([a-z]+)/i);
  if (anime) { avatar?.performAction(anime[1].toLowerCase()); return; }
  bargeIn();
  const turn = ++conversationTurn;
  store.addMessage('user', text, { live: true });
  if (!isReady()) {
    setStatus('Load a model in Model Hub to talk');
    const hint = $('#live-hint');
    if (hint) hint.textContent = 'No model is loaded. Avatar actions still work; no reply was generated.';
    return;
  }
  setStatus('Thinking…');
  avatar?.performAction('think');
  assistantMsg = store.addMessage('assistant', '', { live: true });
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
      if (session !== liveSession || turn !== conversationTurn || !open || !gen) return;
      // A slow Omni turn is still a valid turn. Never force-stop it merely
      // because a mobile device needs more than 30 seconds.
      setStatus(gotToken ? 'Still generating…' : 'Still thinking…');
    }, 30000);
  };
  thinkReassure = setTimeout(() => {
    if (!gotToken && open && gen && session === liveSession && turn === conversationTurn) setStatus('Still thinking…');
  }, 4000);
  armStall();

  gen = generate({
    messages, thinking: thinkOn,
    onToken: tok => {
      if (session !== liveSession || turn !== conversationTurn) return;
      if (!gotToken) { gotToken = true; if (thinkReassure) { clearTimeout(thinkReassure); thinkReassure = null; } }
      armStall();
      rawReply += tok;
      const { content } = splitReasoning(rawReply);
      feedSpeech(content);
      paint();
    },
    onDone: () => {
      if (session !== liveSession || turn !== conversationTurn) return;
      gen = null; clearThinkWatchdog(); flushReply(); feedSpeech(null);
      lastAnswer = splitReasoning(rawReply).content; updateAnswerCard();
    },
    onError: e => {
      if (session !== liveSession || turn !== conversationTurn) return;
      gen = null; clearThinkWatchdog(); flushReply(); toast(e.message);
      setStatus(mode === 'vad' && !muted ? 'Listening' : 'Ready');
    },
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
  let lastCut = 0, clauseStart = 0;
  while ((m = re.exec(sentenceBuf))) {
    lastCut = m.index + m[0].length;
    enqueueSpeech(sentenceBuf.slice(clauseStart, lastCut));
    clauseStart = lastCut;
  }
  if (lastCut > 0) {
    spokenConsumed += lastCut;
    sentenceBuf = sentenceBuf.slice(lastCut);
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
  // Bound pending utterances without dropping spoken content: if synthesis is
  // slower than token generation, coalesce later clauses into one utterance.
  if (speechQueue.length >= 6) speechQueue[speechQueue.length - 1] += ' ' + clean;
  else speechQueue.push(clean);
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
  const session = liveSession, turn = conversationTurn;
  voice.speak(text, {
    onLevel: l => { if (session === liveSession && turn === conversationTurn) avatar?.setSpeaking(l); },
    onEnd: () => {
      if (session !== liveSession || turn !== conversationTurn) return;
      speaking = false; avatar?.setSpeaking(0); speakNext();
    },
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
    ++conversationTurn;
    avatar?.pause();
    stopVad().catch(e => console.warn('background mic stop', e));
    voice.stopSpeech();
    speechQueue = [];
    speaking = false;
    clearThinkWatchdog();
    if (gen) { gen.stop(); gen = null; flushReply(); }
  });
  on('app.foreground', () => {
    if (!open) return;
    avatar?.resume();
    if (mode === 'vad' && !muted && $('#live-keyboard')?.hidden) startVad();
  });
  on('voice.reconfigure', async () => { if (open) await voice.configureVoice(); });
  on('voice.engineFallback', ({ engine }) => { if (open) toast(`${engine} voice is unavailable. Select an installed voice in Model Hub.`); });
  on('voice.ttsError', ({ error }) => { if (open) toast('TTS: ' + error); });
  on('live.transcript', () => { spokenConsumed = 0; });
  // Anti-freeze circuit breaker: on memory pressure drop the avatar's GPU load.
  // Critical pressure fully disposes the WebGL context + VRM to return VRAM;
  // the singleton reloads safely on the next Live open.
  on('memory.pressure', p => {
    if (!avatar) return;
    if (p && p.level === 'critical') { try { avatar.dispose(); } catch {} avatar = null; avatarInitPromise = null; avatarLoadFailed = false; }
    else avatar.pause();
  });
}
