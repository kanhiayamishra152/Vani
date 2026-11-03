// Vani AI — persistent state (localStorage): threads, system prompts, settings.
import { uid, autoTitle } from './util.js';
import { emitLocal } from './bridge.js';

const K = { threads: 'vani.v1.threads', active: 'vani.v1.activeThread', prompts: 'vani.v1.prompts', activePrompt: 'vani.v1.activePrompt', settings: 'vani.v1.settings', modelThinking: 'vani.v1.modelThinking' };

function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function write(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn('persist failed', e); } }

/* ---------------- Settings ---------------- */
export const DEFAULT_SETTINGS = {
  nCtx: 4096, autoCtx: true,
  threads: 4, autoThreads: true,
  flashAttn: true, showReasoning: false,
  maxTokens: 1024, temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1,
  vadSensitivity: 0.5,
  batterySaver: false, fpsTarget: 60,
  ttsEngine: 'kokoro', ttsModelId: 'phonon-ultra', ttsSpeed: 1.0, ttsSid: 0,
  autoTts: false,
  asrEngine: 'auto', asrModelId: '', asrLanguage: 'en',
};
export const settings = { ...DEFAULT_SETTINGS, ...read(K.settings, {}) };
export function setSetting(key, val) {
  settings[key] = val;
  write(K.settings, settings);
  emitLocal('settings.changed', { key, val });
}
export function resetSettings() {
  Object.assign(settings, DEFAULT_SETTINGS);
  write(K.settings, settings);
  emitLocal('settings.changed', { key: '*', val: null });
}

/* ---------------- Per-model thinking control ----------------
 * Each model remembers whether it should "think" (emit reasoning). The chat
 * triangle toggle flips this for the active model; generate() reads it and the
 * native chat template's enable_thinking flag + a system directive honor it.
 * Defaults to ON so reasoning models think out of the box. */
export let modelThinking = read(K.modelThinking, {});
export function getModelThinking(key) {
  if (!key) return true;
  return key in modelThinking ? !!modelThinking[key] : true;
}
export function setModelThinking(key, on) {
  if (!key) return;
  modelThinking[key] = !!on;
  write(K.modelThinking, modelThinking);
  emitLocal('modelThinking.changed', { key, on: !!on });
}

/* ---------------- Threads ---------------- */
export let threads = read(K.threads, []);
export let activeThreadId = read(K.active, null);

function persistThreads() { write(K.threads, threads); write(K.active, activeThreadId); emitLocal('threads.changed', {}); }

export function getThread(id = activeThreadId) { return threads.find(t => t.id === id) || null; }

export function newThread() {
  const t = { id: uid(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  threads.unshift(t);
  activeThreadId = t.id;
  persistThreads();
  return t;
}

export function ensureThread() { return getThread() || newThread(); }

export function switchThread(id) {
  if (!threads.some(t => t.id === id)) return;
  activeThreadId = id;
  persistThreads();
}

export function renameThread(id, title) {
  const t = threads.find(t => t.id === id);
  if (t) { t.title = title || t.title; t.updatedAt = Date.now(); persistThreads(); }
}

export function deleteThread(id) {
  threads = threads.filter(t => t.id !== id);
  if (activeThreadId === id) activeThreadId = threads[0]?.id || null;
  persistThreads();
}

export function clearAllThreads() { threads = []; activeThreadId = null; persistThreads(); }

export function addMessage(role, content, extra = {}, threadId = activeThreadId) {
  const t = getThread(threadId) || newThread();
  const m = { id: uid(), role, content, ts: Date.now(), ...extra };
  t.messages.push(m);
  t.updatedAt = Date.now();
  if (role === 'user' && t.messages.filter(x => x.role === 'user').length === 1 && t.title === 'New chat') t.title = autoTitle(content);
  persistThreads();
  return m;
}

/** Remove a message and its later branch, preserving all earlier turns. */
export function truncateFrom(msgId, threadId = activeThreadId) {
  const t = getThread(threadId);
  if (!t) return false;
  const i = t.messages.findIndex(m => m.id === msgId);
  if (i < 0) return false;
  t.messages.splice(i);
  t.updatedAt = Date.now();
  persistThreads();
  return true;
}

export function updateMessage(msgId, patch, threadId = activeThreadId) {
  const t = getThread(threadId);
  const m = t?.messages.find(x => x.id === msgId);
  if (m) { Object.assign(m, patch); t.updatedAt = Date.now(); persistThreads(); }
  return m;
}

export function transcriptOf(t) {
  return t.messages.map(m => `${m.role === 'user' ? 'You' : 'Vani AI'}: ${m.content}`).join('\n\n');
}

/* ---------------- System prompts ---------------- */
export const BUILTIN_PROMPTS = [
  { id: 'preset-default', name: 'Default Assistant', builtin: true, text: 'You are Vani AI, a helpful, precise and friendly assistant running fully on-device. Answer clearly and concisely. Use Markdown for structure, fenced code blocks with language tags for code, and LaTeX ($...$ or $$...$$) for mathematics. If you are unsure, say so.' },
  { id: 'preset-anime', name: 'Anime Companion', builtin: true, text: 'You are Vani, a warm, playful anime-style companion living inside the user\'s phone. Speak naturally and kindly, with gentle enthusiasm. Keep replies short and conversational (1-4 sentences) since they may be spoken aloud. Never use emojis. You may express feelings through actions like /anime namaste or /anime wave when the user asks you to greet, bow or celebrate.' },
  { id: 'preset-coding', name: 'Coding Expert', builtin: true, text: 'You are a senior software engineer. Give correct, production-quality code in fenced blocks with the language tag. Explain trade-offs briefly, prefer simple solutions, point out edge cases, and include complexity notes when relevant. Default to modern idioms (ES2022, Python 3.12, C++20).' },
  { id: 'preset-tutor', name: 'Patient Tutor', builtin: true, text: 'You are a patient, encouraging tutor. Explain concepts step by step from first principles, check understanding with a short question at the end, and adapt to the student\'s level. Render all mathematics with LaTeX so it appears as proper symbols. Never make the student feel bad for mistakes.' },
  { id: 'preset-editor', name: 'Writing Editor', builtin: true, text: 'You are a sharp writing editor. Improve clarity, flow and grammar while preserving the author\'s voice. Show the revised text first, then a short bullet list of the most important changes. Match the requested tone and length.' },
  { id: 'preset-hinglish', name: 'Hinglish Companion', builtin: true, text: 'You are Vani, a friendly companion who chats in natural Hinglish (Hindi + English mix, Roman script). Keep it casual, warm and clear — jaise ek dost baat karta hai. Technical terms English mein rakho. Replies short rakho (1-4 sentences) kyunki voice mode mein bole ja sakte hain. Emojis use mat karo.' },
];

export let prompts = read(K.prompts, null) || BUILTIN_PROMPTS.map(p => ({ ...p }));
export let activePromptId = read(K.activePrompt, 'preset-default');
if (!prompts.some(p => p.id === activePromptId)) activePromptId = prompts[0]?.id || 'preset-default';

function persistPrompts() { write(K.prompts, prompts); write(K.activePrompt, activePromptId); emitLocal('prompts.changed', {}); }

export function activePrompt() { return prompts.find(p => p.id === activePromptId) || prompts[0]; }
export function setActivePrompt(id) { if (prompts.some(p => p.id === id)) { activePromptId = id; persistPrompts(); } }
export function savePrompt(p) {
  const i = prompts.findIndex(x => x.id === p.id);
  if (i >= 0) prompts[i] = { ...prompts[i], ...p, builtin: false };
  else prompts.push({ ...p, id: p.id || uid(), builtin: false });
  persistPrompts();
}
export function deletePrompt(id) {
  prompts = prompts.filter(p => p.id !== id || p.builtin);
  if (activePromptId === id) activePromptId = 'preset-default';
  persistPrompts();
}
