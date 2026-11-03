// Vani AI — hands-free voice loop: native mic capture, VAD / hold-to-talk, TTS.
// Android capture is owned exclusively by VaniAudioBridge (16 kHz PCM into
// sherpa-onnx); this module never calls getUserMedia or opens a second mic.
import { invoke, on, hasNative, emitLocal } from './bridge.js';
import { settings } from './store.js';
import { llm } from './inference.js';
import { Phonon } from './phonon.js';

let listening = false;
let listenCbs = {};
const phonon = new Phonon();
let currentUtter = null;
let installedCache = [];

export async function refreshInstalled() {
  if (!hasNative()) { installedCache = []; return; }
  try { installedCache = await invoke('models.list'); } catch { installedCache = []; }
}

export function asrEntry() {
  const byId = installedCache.find(m => m.kind === 'asr' && m.modelId === settings.asrModelId);
  return byId || installedCache.find(m => m.kind === 'asr') || null;
}
// Back-compat alias.
export const whisperEntry = asrEntry;

const OFFLINE_ASR = ['whisper', 'moonshine', 'sensevoice', 'zipformer'];

export function resolveAsr() {
  const eng = settings.asrEngine || 'auto';
  if (eng === 'system') return { engine: 'system', entry: null };
  const entry = asrEntry();
  if (!entry) return { engine: 'system', entry: null };
  const engine = (eng !== 'auto' && OFFLINE_ASR.includes(eng)) ? eng : (entry.engine || 'whisper');
  return { engine, entry };
}

/** Voice input is available when an offline ASR model is installed, an omni
 *  model is loaded, or the Android system recognizer can serve. */
export function voiceAvailable() {
  if (!hasNative()) return false;
  return true; // system recognizer fallback is always present on Android
}
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
    on('asr.partial', p => listenCbs.onPartial?.(p.text)),
    on('asr.final', p => { if (p.text?.trim()) listenCbs.onFinal?.(p.text.trim()); }),
    on('asr.error', p => listenCbs.onError?.(new Error(p.error))),
  );
}

export async function startListening(mode, cbs) {
  if (!hasNative()) throw new Error('Voice needs the Android app');
  await refreshInstalled();
  listenCbs = cbs;
  wireAsrEvents();
  const { engine, entry } = resolveAsr();
  // Spec guard: the offline path requires a model; system path uses Android's
  // own recognizer. Either way capture is 100% native (no getUserMedia).
  if (engine !== 'system' && !entry) throw new Error('Install an ASR model from Model Hub → Supplementary');
  // v1.3.0 unified native mic: ensure RECORD_AUDIO, then the native AudioRecord
  // bridge (VaniAudioBridge) captures 16 kHz PCM straight into sherpa-onnx. This
  // permanently fixes "Could not receive audio input" (WebView getUserMedia is
  // never used on Android, and there is never more than one mic consumer).
  try {
    const res = await invoke('mic.ensurePermission');
    if (res && res.granted === false) throw new Error('Microphone permission denied — allow mic access to use voice input.');
  } catch (e) {
    if (/permission denied/i.test(e.message || '')) throw e;
    // Older native build without mic.ensurePermission: proceed (asr.start will
    // request/verify permission itself).
  }
  await invoke('asr.start', {
    engine, mode,
    dir: entry?.path || null,
    language: settings.asrLanguage || 'en',
    sensitivity: settings.vadSensitivity,
  });
  listening = true;
}

export async function stopListening() {
  listening = false;
  listenCbs = {};
  if (hasNative()) { try { await invoke('asr.stop'); } catch {} }
}

export function pttRelease() { if (hasNative()) invoke('asr.pttRelease').catch(() => {}); }
export const isListening = () => listening;

/** One-shot dictation for the composer mic button. */
export function dictateOnce({ onPartial } = {}) {
  return new Promise(async (resolve, reject) => {
    let done = false;
    const finish = async text => {
      if (done) return; done = true;
      clearTimeout(timer);
      await stopListening();
      resolve(text || '');
    };
    const timer = setTimeout(() => finish(''), 30000);
    try {
      await startListening('vad', {
        onPartial,
        onFinal: text => finish(text),
        onError: async e => { if (!done) { done = true; clearTimeout(timer); await stopListening(); reject(e); } },
      });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}
export const stopDictation = () => stopListening();

/* ============================ TTS ============================ */
export async function configureVoice() {
  await refreshInstalled();
  if (!hasNative()) return;
  let dir = null;
  // "phonon" is Piper VITS; phonon-ultra uses the Kokoro-compatible Paradee graph.
  const eng = settings.ttsEngine === 'phonon' ? 'vits' : settings.ttsEngine;
  if (['pocket', 'vits', 'kokoro', 'kitten'].includes(eng)) {
    const entry = installedCache.find(m => m.kind === 'tts' && m.modelId === settings.ttsModelId)
      || installedCache.find(m => m.kind === 'tts' && m.engine === eng);
    dir = entry?.path || null;
    if (!dir) { emitLocal('voice.engineFallback', { engine: settings.ttsEngine }); }
  }
  try {
    await invoke('tts.configure', { engine: settings.ttsEngine, dir, speed: settings.ttsSpeed, sid: settings.ttsSid || 0, paradee: settings.ttsModelId === 'phonon-ultra' });
  } catch {}
}

/** Speak a short preview line with a specific speaker id (voice picker). */
export function previewVoice(text, sid) {
  if (!hasNative()) { phonon.speak(text, { rate: settings.ttsSpeed }); return; }
  wireTts();
  stopSpeech();
  const id = 'pv' + (++utterSeq);
  currentUtter = { id, onLevel: null, onEnd: null };
  invoke('tts.speak', { utterId: id, text, sid }).catch(() => { if (currentUtter?.id === id) currentUtter = null; });
}

let ttsOffs = [];
function wireTts() {
  if (ttsOffs.length) return;
  ttsOffs.push(
    on('tts.level', p => { if (currentUtter && p.utterId === currentUtter.id) currentUtter.onLevel?.(p.level); }),
    on('tts.end', p => {
      if (currentUtter && p.utterId === currentUtter.id) {
        const u = currentUtter; currentUtter = null;
        u.onEnd?.(p.interrupted);
      }
    }),
  );
}

let utterSeq = 0;
export function speak(text, { onStart, onLevel, onEnd } = {}) {
  const clean = String(text || '').trim();
  if (!clean) { onEnd?.(false); return { stop() {} }; }
  stopSpeech();
  const id = 'u' + (++utterSeq);
  currentUtter = { id, onLevel, onEnd };
  onStart?.();
  if (!hasNative()) {
    // Web preview only — the Android app always uses the real neural engine.
    phonon.speak(clean, {
      rate: settings.ttsSpeed,
      onLevel: l => { if (currentUtter?.id === id) onLevel?.(l); },
      onEnd: () => { if (currentUtter?.id === id) { currentUtter = null; onEnd?.(false); } },
    });
  } else {
    wireTts();
    invoke('tts.speak', { utterId: id, text: clean }).catch(e => {
      if (currentUtter?.id === id) { currentUtter = null; onEnd?.(false); }
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
  } else if (hasNative()) {
    invoke('tts.stop').catch(() => {});
  }
}
export const isSpeaking = () => !!currentUtter;
