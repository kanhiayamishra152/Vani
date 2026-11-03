// Vani AI — WebView <-> Android native bridge + app-wide event bus.
// Native side: ai.vani.app.Bridge (@JavascriptInterface "VaniNative").
// Protocol: invoke(method, argsJson, callbackId) -> _resolve(id, ok, payload)
// Events:   native evaluateJavascript -> _emit(event, payload)
const listeners = new Map();
const pending = new Map();
let seq = 0;

window.VaniBridge = {
  _resolve(id, ok, payload) {
    const p = pending.get(String(id));
    if (!p) return;
    pending.delete(String(id));
    if (ok) p.resolve(payload);
    else p.reject(new Error(payload && payload.error ? payload.error : 'native error'));
  },
  _emit(event, payload) { dispatch(event, payload); },
};

// Defensive re-entrancy guard: a handler that (transitively) re-emits the same
// event synchronously must never be able to recurse infinitely and freeze the
// WebView main thread. Cap synchronous dispatch depth and drop runaway events.
let dispatchDepth = 0;
function dispatch(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  if (dispatchDepth >= 64) { console.error('Vani: blocked runaway event recursion for', event); return; }
  dispatchDepth++;
  try {
    for (const cb of [...set]) { try { cb(payload); } catch (e) { console.error(event, e); } }
  } finally {
    dispatchDepth--;
  }
}

export const hasNative = () => typeof window.VaniNative !== 'undefined';

export function invoke(method, args = {}) {
  if (!hasNative()) return Promise.reject(new Error('Android bridge unavailable (browser preview)'));
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    try { window.VaniNative.invoke(method, JSON.stringify(args), id); }
    catch (e) { pending.delete(id); reject(e); }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 120000);
  });
}

export function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  return () => listeners.get(event)?.delete(cb);
}

// Local (JS-side) events use the same bus so modules stay decoupled.
export const emitLocal = dispatch;
