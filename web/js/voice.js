// Vani AI — native microphone capture, explicit speech-model residency and TTS.
// Android owns the only microphone consumer; this module never uses getUserMedia.
import { invoke, on, hasNative, emitLocal } from './bridge.js';
import { settings } from './store.js';
import { llm } from './inference.js';
import { Phonon } from './phonon.js';

let listening = false;
let listenCbs = {};
let listenSeq = 0;
let dictationSession = null;
const phonon = new Phonon();
let currentUtter = null;
let installedCache = [];
let configuredKey = null;
let configuring = null;
let configuringKey = null;

/** Actual native allocations, never merely the selected settings preference. */
export const speechRuntime = {
  tts: { state: 'idle', path: '', modelId: '' },
  asr: { state: 'idle', path: '', modelId: '' },
};

function applySpeechStatus(s) {
  if (s?.tts) speechRuntime.tts = { ...speechRuntime.tts, ...s.tts };
  if (s?.asr) speechRuntime.asr = { ...speechRuntime.asr, ...s.asr };
  if (s?.tts && s.tts.state !== 'ready') configuredKey = null;
  emitLocal('speech.statusChanged', speechRuntime);
}
on('tts.status', s => applySpeechStatus({ tts: s }));
on('asr.status', s => applySpeechStatus({ asr: s }));

export async function refreshSpeechStatus() {
  if (!hasNative()) return speechRuntime;
  try { applySpeechStatus(await invoke('speech.status')); } catch {}
  return speechRuntime;
}
export const isVoiceLoaded = entry => !!entry && speechRuntime.tts.state === 'ready' && speechRuntime.tts.path === entry.path;
export const isAsrLoaded = entry => !!entry && speechRuntime.asr.state === 'ready' && speechRuntime.asr.path === entry.path;

export async function refreshInstalled() {
  if (!hasNative()) { installedCache = []; return; }
  try { installedCache = await invoke('models.list'); } catch { installedCache = []; }
}

export function asrEntry() {
  const byId = installedCache.find(m => m.kind === 'asr' && m.modelId === settings.asrModelId);
  return byId || installedCache.find(m => m.kind === 'asr') || null;
}
export const whisperEntry = asrEntry;
const OFFLINE_ASR = ['whisper', 'moonshine', 'sensevoice', 'zipformer'];

export function resolveAsr() {
  const eng = settings.asrEngine || 'auto';
  if (eng === 'system') return { engine: 'system', entry: null };
  if (OFFLINE_ASR.includes(eng)) {
    const selected = installedCache.find(m => m.kind === 'asr' && m.modelId === settings.asrModelId && (m.engine || 'whisper') === eng);
    const entry = selected || installedCache.find(m => m.kind === 'asr' && (m.engine || 'whisper') === eng) || null;
    return { engine: eng, entry };
  }
  const entry = asrEntry();
  if (!entry) return { engine: 'system', entry: null };
  return { engine: entry.engine || 'whisper', entry };
}
export function voiceAvailable() { return hasNative(); }
export function offlineVoiceReady() {
  const { engine, entry } = resolveAsr();
  return (OFFLINE_ASR.includes(engine) && !!entry) || !!llm.info?.audio;
}

const asrOffs = [];
function wireAsrEvents() {
  if (asrOffs.length) return;
  asrOffs.push(
    on('asr.speechStart', p => listenCbs.onSpeechStart?.(p)),
    on('asr.speechEnd', p => listenCbs.onSpeechEnd?.(p)),
    on('asr.partial', p => listenCbs.onPartial?.(p.text || '')),
    on('asr.final', p => {
      if (p.text?.trim()) listenCbs.onFinal?.(p.text.trim());
      else if (listenCbs.once) listenCbs.onFinal?.('');
    }),
    on('asr.error', p => listenCbs.onError?.(new Error(p.error || 'Speech recognition failed'))),
  );
}

export async function startListening(mode, cbs = {}) {
  if (!hasNative()) throw new Error('Voice needs the Android app');
  const requestSeq = ++listenSeq;
  listenCbs = cbs;
  wireAsrEvents();
  await refreshInstalled();
  if (requestSeq !== listenSeq) return;
  const { engine, entry } = resolveAsr();
  if (engine !== 'system' && !entry) throw new Error(`Install a matching ${engine} model in Model Hub → Supplementary`);
  try {
    const res = await invoke('mic.ensurePermission');
    if (res && res.granted === false) throw new Error('Microphone permission denied — allow mic access to use voice input.');
  } catch (e) {
    if (/permission denied/i.test(e.message || '')) throw e;
    // Compatibility with older native bridges without mic.ensurePermission.
  }
  if (requestSeq !== listenSeq) return;
  await invoke('asr.start', {
    engine, mode, dir: entry?.path || null, modelId: entry?.modelId || '', name: entry?.name || '',
    language: settings.asrLanguage || 'en', sensitivity: settings.vadSensitivity,
    once: !!cbs.once,
  });
  // Stop may have been pressed while permission/model loading was pending.
  if (requestSeq !== listenSeq) { invoke('asr.stop').catch(() => {}); return; }
  listening = true;
}

export async function stopListening() {
  ++listenSeq;
  listening = false;
  listenCbs = {};
  if (hasNative()) { try { await invoke('asr.stop'); } catch {} }
}
export function pttRelease() { if (hasNative()) invoke('asr.pttRelease').catch(() => {}); }
export const isListening = () => listening;

/** Explicit supplementary-model lifecycle (no microphone permission needed). */
export async function loadAsrModel(entry) {
  if (!hasNative()) throw new Error('ASR models need the Android app');
  const status = await invoke('asr.load', {
    engine: entry.engine || 'whisper', dir: entry.path, modelId: entry.modelId || '', name: entry.name || '',
    language: settings.asrLanguage || 'en',
  });
  applySpeechStatus({ asr: status });
  return status;
}
export async function unloadAsrModel() {
  await stopListening();
  const status = await invoke('asr.unload');
  applySpeechStatus({ asr: status });
}

/** One-shot, cancellable dictation. Cancellation resolves without inventing text. */
export function dictateOnce({ onPartial } = {}) {
  if (dictationSession) return Promise.reject(new Error('Dictation is already active'));
  return new Promise((resolve, reject) => {
    let done = false;
    const session = { finish: null, timer: null };
    const finish = async (text = '', error = null) => {
      if (done) return;
      done = true;
      clearTimeout(session.timer);
      if (dictationSession === session) dictationSession = null;
      await stopListening();
      if (error) reject(error); else resolve(text || '');
    };
    session.finish = finish;
    dictationSession = session;
    session.timer = setTimeout(() => finish(''), 30000);
    startListening('vad', {
      once: true, onPartial,
      onFinal: text => finish(text),
      onError: e => finish('', e),
    }).catch(e => finish('', e));
  });
}
export async function stopDictation() {
  const session = dictationSession;
  if (session) await session.finish('');
  else await stopListening();
}

/* ============================ TTS ============================ */
function voiceConfigKey() { return [settings.ttsEngine, settings.ttsModelId, settings.ttsSpeed, settings.ttsSid].join('|'); }

/** Configure exactly the selected installed voice; never silently substitute one. */
export function configureVoice() {
  if (!hasNative()) return Promise.resolve();
  const key = voiceConfigKey();
  if (configuredKey === key && speechRuntime.tts.state === 'ready') return Promise.resolve();
  if (settings.ttsEngine === 'system' && configuredKey === key) return Promise.resolve();
  if (configuring && configuringKey === key) return configuring;
  configuringKey = key;
  configuring = (async () => {
    await refreshInstalled();
    let dir = null;
    let selectedEntry = null;
    const eng = settings.ttsEngine === 'phonon' ? 'vits' : settings.ttsEngine;
    if (['pocket', 'vits', 'kokoro', 'kitten'].includes(eng)) {
      selectedEntry = installedCache.find(m => (m.kind === 'tts' || m.kind === 'dir') && m.modelId === settings.ttsModelId);
      dir = selectedEntry?.path || null;
      if (!dir) throw new Error('Install the selected voice in Model Hub → Supplementary before playing audio');
    }
    const status = await invoke('tts.configure', {
      engine: settings.ttsEngine, dir, speed: settings.ttsSpeed,
      sid: settings.ttsSid || 0, paradee: settings.ttsModelId === 'phonon-ultra',
      modelId: selectedEntry?.modelId || '', name: selectedEntry?.name || '',
    });
    configuredKey = key;
    if (status?.state) applySpeechStatus({ tts: status });
  })().finally(() => { configuring = null; configuringKey = null; });
  return configuring;
}

export async function unloadVoice() {
  stopSpeech();
  configuredKey = null;
  if (!hasNative()) return;
  const status = await invoke('tts.unload');
  applySpeechStatus({ tts: status });
}

let ttsOffs = [];
function wireTts() {
  if (ttsOffs.length) return;
  ttsOffs.push(
    on('tts.start', p => { if (currentUtter && p.utterId === currentUtter.id) currentUtter.onStart?.(); }),
    on('tts.level', p => { if (currentUtter && p.utterId === currentUtter.id) currentUtter.onLevel?.(p.level); }),
    on('tts.end', p => {
      if (currentUtter && p.utterId === currentUtter.id) {
        const u = currentUtter; currentUtter = null;
        u.onEnd?.(!!p.interrupted);
      }
    }),
    on('tts.error', p => {
      if (!currentUtter || (p.utterId && p.utterId !== currentUtter.id)) return;
      const u = currentUtter; currentUtter = null;
      const error = new Error(p.error || 'Speech playback failed');
      u.onError?.(error);
      emitLocal('voice.ttsError', { error: error.message });
    }),
  );
}

let utterSeq = 0;
/** Speak a preview with the selected speaker. Each request owns a cancellable track. */
export async function previewVoice(text, sid = settings.ttsSid) {
  if (!hasNative()) { phonon.speak(text, { rate: settings.ttsSpeed }); return; }
  wireTts();
  stopSpeech();
  await configureVoice();
  const id = 'pv' + (++utterSeq);
  currentUtter = { id, onLevel: null, onEnd: null, onError: null };
  try { await invoke('tts.speak', { utterId: id, text, sid }); }
  catch (e) {
    if (currentUtter?.id === id) currentUtter = null;
    throw e;
  }
}

export function speak(text, { onStart, onLevel, onEnd, onError } = {}) {
  const clean = String(text || '').trim();
  if (!clean) { onEnd?.(false); return { stop() {} }; }
  stopSpeech();
  const id = 'u' + (++utterSeq);
  currentUtter = { id, onStart, onLevel, onEnd, onError };
  if (!hasNative()) {
    onStart?.();
    phonon.speak(clean, {
      rate: settings.ttsSpeed,
      onLevel: l => { if (currentUtter?.id === id) onLevel?.(l); },
      onEnd: () => { if (currentUtter?.id === id) { currentUtter = null; onEnd?.(false); } },
    });
  } else {
    wireTts();
    configureVoice().then(() => {
      if (currentUtter?.id !== id) return null;
      return invoke('tts.speak', { utterId: id, text: clean, sid: settings.ttsSid || 0 });
    }).catch(e => {
      if (currentUtter?.id === id) {
        currentUtter = null;
        onError?.(e);
        if (!onError) onEnd?.(false);
      }
      emitLocal('voice.ttsError', { error: e.message });
    });
  }
  return { stop: () => { if (currentUtter?.id === id) stopSpeech(); } };
}

export function stopSpeech() {
  phonon.stop();
  if (currentUtter) {
    const u = currentUtter; currentUtter = null;
    if (hasNative()) invoke('tts.stop').catch(() => {});
    u.onEnd?.(true);
  } else if (hasNative()) invoke('tts.stop').catch(() => {});
}
export const isSpeaking = () => !!currentUtter;
on('models.changed', () => { configuredKey = null; });
