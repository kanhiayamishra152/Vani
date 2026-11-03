// Vani AI — on-device inference orchestration (llama.cpp via JNI bridge).
import { invoke, on, hasNative, emitLocal } from './bridge.js';
import { settings } from './store.js';
import { estTokens } from './util.js';

export const llm = {
  state: 'idle',          // idle | loading | ready | error
  info: null,             // { modelPath, name, nCtx, nThreads, vision, audio }
  error: null,
};

export function isReady() { return llm.state === 'ready'; }

export async function refreshStatus() {
  if (!hasNative()) return;
  try { applyStatus(await invoke('llm.status')); } catch {}
}

function applyStatus(s) {
  llm.state = s.state || 'idle';
  llm.info = s.state === 'ready' ? s : null;
  llm.error = s.error || null;
  emitLocal('llm.status', { ...llm });
}

on('llm.status', applyStatus);

export async function loadModel(entry, mmprojEntry) {
  if (!hasNative()) throw new Error('Install the Android app to load models');
  llm.state = 'loading'; llm.error = null;
  emitLocal('llm.status', { ...llm });
  try {
    const s = await invoke('llm.load', {
      path: entry.path,
      name: entry.name || entry.fileName,
      mmprojPath: mmprojEntry?.path || null,
      nCtx: settings.nCtx,
      nThreads: settings.threads,
      nBatch: 256,
      flashAttn: !!settings.flashAttn,
    });
    applyStatus(s);
    return s;
  } catch (e) {
    llm.state = 'error'; llm.error = e.message;
    emitLocal('llm.status', { ...llm });
    throw e;
  }
}

export async function unloadModel() {
  if (!hasNative()) return;
  try { await invoke('llm.unload'); } catch {}
  applyStatus({ state: 'idle' });
}

/** Budget history so prompt + generation fits the context window. */
export function buildContextMessages(history, systemText, reserve) {
  const budget = Math.max(512, settings.nCtx - reserve - 256);
  const msgs = [];
  let used = estTokens(systemText);
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m.content && !m.images?.length) continue;
    const cost = estTokens(m.content) + (m.images?.length ? 768 * m.images.length : 0);
    if (used + cost > budget && msgs.length > 0) break;
    used += cost;
    msgs.unshift({ role: m.role, content: m.content || '' });
  }
  return [{ role: 'system', content: systemText }, ...msgs];
}

let genSeq = 0;
/**
 * Stream a completion. handlers: onToken(text), onDone(stats), onError(err).
 * Returns { genId, stop() }.
 */
export function generate({ messages, images = [], onToken, onDone, onError }) {
  const genId = 'g' + (++genSeq) + '-' + Date.now().toString(36);
  const offs = [
    on('llm.token', p => { if (p.genId === genId) onToken?.(p.text); }),
    on('llm.done', p => { if (p.genId === genId) { cleanup(); onDone?.(p); } }),
    on('llm.error', p => { if (p.genId === genId) { cleanup(); onError?.(new Error(p.error || 'generation failed')); } }),
  ];
  function cleanup() { offs.forEach(f => f()); }
  invoke('llm.generate', {
    genId,
    messages,
    images,
    params: {
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      topP: settings.topP,
      topK: settings.topK,
      repeatPenalty: settings.repeatPenalty,
      enableThinking: !!settings.showReasoning,
    },
  }).catch(e => { cleanup(); onError?.(e); });
  return {
    genId,
    stop() { invoke('llm.stop', { genId }).catch(() => {}); },
  };
}
