// Vani AI — Module 4: interactive hardware & inference settings.
import { $, $$, el, esc, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { invoke, on, hasNative, emitLocal } from './bridge.js';
import { settings, setSetting, resetSettings, clearAllThreads, getModelThinking, setModelThinking } from './store.js';
import { openPromptStudio } from './prompts.js';
import { llm } from './inference.js';
import { SUPP_MODELS } from './catalog.js';
import { configureVoice, previewVoice } from './voice.js';

let device = null;
let gpuName = null;
let pollTimer = null;
let buildInfo = null;

const CTX_VALUES = [512, 1024, 2048, 4096, 6144, 8192, 12288, 16384, 32768];
const THREAD_VALUES = [1, 2, 4, 6, 8];
const MAXTOK_VALUES = [256, 512, 1024, 2048, 4096];
const TOPK_VALUES = [1, 5, 10, 20, 40, 60, 100];
const FPS_VALUES = [24, 30, 60];

async function measure() {
  if (hasNative()) { try { device = await invoke('device.info'); } catch {} }
  if (!gpuName) {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      if (ext) gpuName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {}
  }
}

export function autoTune(apply = true) {
  const freeGB = (device?.ramAvailBytes || 4 * 1073741824) / 1073741824;
  const cores = device?.cores || 8;
  const ctx = freeGB >= 6 ? 8192 : freeGB >= 4.5 ? 6144 : freeGB >= 3.5 ? 4096 : freeGB >= 2.5 ? 2048 : 1024;
  const threads = cores >= 8 ? 4 : Math.max(1, Math.min(4, cores - 1));
  if (apply) {
    if (settings.autoCtx) setSetting('nCtx', ctx);
    if (settings.autoThreads) setSetting('threads', threads);
  }
  return { ctx, threads };
}

/* ============================ pickers ============================ */
function pickValue(title, values, current, fmt, onPick) {
  emitLocal('sheet.open', {
    title,
    options: values.map(v => ({ label: fmt(v), value: v })),
    selected: current,
    onPick: v => { onPick(v); renderSettings(); },
  });
}
const pickCtx = () => pickValue('Context window (n_ctx)', CTX_VALUES, settings.nCtx, v => `${v} tokens`, v => { setSetting('nCtx', v); setSetting('autoCtx', false); toast(`Context: ${v} tokens`); });
const pickThreads = () => pickValue('Inference threads', THREAD_VALUES, settings.threads, v => `${v} thread${v > 1 ? 's' : ''}`, v => { setSetting('threads', v); setSetting('autoThreads', false); toast(`Threads: ${v}`); });

/* ============================ row builders ============================ */
function rowToggle(title, desc, key, onChange) {
  const row = el('div', 'settings-row');
  row.innerHTML = `<div class="row-text"><span class="row-title">${title}</span><span class="row-desc">${desc}</span></div>
    <label class="switch"><input type="checkbox" ${settings[key] ? 'checked' : ''}><span class="track"><span class="knob"></span></span></label>`;
  row.querySelector('input').addEventListener('change', e => {
    setSetting(key, e.target.checked);
    onChange?.(e.target.checked);
  });
  return row;
}

function rowPicker(title, desc, valueText, onOpen) {
  const row = el('div', 'settings-row');
  row.innerHTML = `<div class="row-text"><span class="row-title">${title}</span><span class="row-desc">${desc}</span></div>
    <button class="value-pill">${esc(valueText)} ${icon('chevronDown')}</button>`;
  row.querySelector('.value-pill').addEventListener('click', onOpen);
  return row;
}

function rowSlider(title, desc, key, min, max, step, fmt) {
  const row = el('div', 'slider-row');
  row.innerHTML = `<div class="slider-head"><span class="row-title">${title}</span><span class="slider-val">${fmt(settings[key])}</span></div>
    <span class="row-desc">${desc}</span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${settings[key]}">`;
  const input = row.querySelector('input');
  const val = row.querySelector('.slider-val');
  input.addEventListener('input', () => { val.textContent = fmt(Number(input.value)); });
  input.addEventListener('change', () => { setSetting(key, Number(input.value)); });
  return row;
}

function rowModelThinking() {
  const key = llm.info?.name || llm.info?.modelPath || '';
  const row = el('div', 'settings-row');
  row.id = 'sec-model-thinking';
  const enabled = key ? getModelThinking(key) : true;
  row.innerHTML = `<div class="row-text"><span class="row-title">Think with this model</span><span class="row-desc">${key ? `Per-model control for ${esc(llm.info?.name || 'loaded model')}. The chat triangle changes only this model.` : 'Load a model to set its independent thinking preference.'}</span></div>
    <label class="switch"><input type="checkbox" ${enabled ? 'checked' : ''} ${key ? '' : 'disabled'} aria-label="Think with this model"><span class="track"><span class="knob"></span></span></label>`;
  row.querySelector('input').addEventListener('change', e => {
    if (!key) return;
    setModelThinking(key, e.target.checked);
    toast(e.target.checked ? 'Thinking ON for this model' : 'Thinking OFF for this model');
  });
  return row;
}

function rowButton(title, desc, btnLabel, ic, fn, danger = false) {
  const row = el('div', 'settings-row');
  row.innerHTML = `<div class="row-text"><span class="row-title">${title}</span><span class="row-desc">${desc}</span></div>
    <button class="${danger ? 'btn-danger' : 'btn-secondary'}" style="padding:8px 14px;font-size:13px">${icon(ic)}<span>${btnLabel}</span></button>`;
  row.querySelector('button').addEventListener('click', fn);
  return row;
}

/* ============================ render ============================ */
export async function renderSettings() {
  const root = $('#settings-scroll');
  await measure();
  const totalRAM = device ? fmtBytes(device.ramTotalBytes) : '—';
  const freeRAM = device ? fmtBytes(device.ramAvailBytes) : '—';
  const gpu = gpuName || device?.gpuHint || 'Adreno 613';
  const cores = device?.cores || '—';

  root.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Hardware</div>
      <div class="settings-card">
        <div class="telemetry">
          <div class="telemetry-cell"><span class="telemetry-val" id="tel-total">${totalRAM}</span><span class="telemetry-key">Total RAM</span></div>
          <div class="telemetry-cell"><span class="telemetry-val" id="tel-free">${freeRAM}</span><span class="telemetry-key">Free RAM (live)</span></div>
          <div class="telemetry-cell"><span class="telemetry-val" style="font-size:14px">${esc(String(gpu).replace(/ANGLE \(|\)|Qualcomm, /g, '').slice(0, 34))}</span><span class="telemetry-key">GPU</span></div>
          <div class="telemetry-cell"><span class="telemetry-val">${cores}</span><span class="telemetry-key">CPU cores</span></div>
        </div>
      </div>
      <div class="settings-card mt8" id="sec-hw-actions"></div>
    </div>
    <div class="settings-section"><div class="settings-section-title">Inference</div><div class="settings-card" id="sec-inference"></div></div>
    <div class="settings-section"><div class="settings-section-title">Voice</div><div class="settings-card" id="sec-voice"></div></div>
    <div class="settings-section"><div class="settings-section-title">Live Talk & Battery</div><div class="settings-card" id="sec-battery"></div></div>
    <div class="settings-section"><div class="settings-section-title">Persona</div><div class="settings-card" id="sec-persona"></div></div>
    <div class="settings-section"><div class="settings-section-title">Data</div><div class="settings-card" id="sec-data"></div></div>
    <div class="settings-section"><div class="settings-section-title">About</div><div class="settings-card" id="sec-about"></div></div>`;

  $('#sec-hw-actions').append(rowButton('Re-measure and auto-tune', 'Probe free RAM and CPU, then pick the best context window and thread count.', 'Re-measure', 'refresh', async () => {
    await measure();
    const t = autoTune(true);
    toast(`Tuned: ${t.ctx} ctx · ${t.threads} threads`);
    renderSettings();
  }));

  const inf = $('#sec-inference');
  inf.append(
    rowPicker('Context window', 'Tokens of conversation memory (n_ctx). Applies on next model load.', `${settings.nCtx}`, pickCtx),
    rowToggle('Auto-scale context to RAM', 'Pick n_ctx automatically from free memory. Turning off opens the picker.', 'autoCtx', on => { if (!on) pickCtx(); else { autoTune(true); renderSettings(); } }),
    rowPicker('Inference threads', 'CPU threads for token generation. 4 is ideal for Snapdragon 4 Gen 2.', `${settings.threads}`, pickThreads),
    rowToggle('Auto-select threads', 'Choose the thread count from the CPU topology. Turning off opens the picker.', 'autoThreads', on => { if (!on) pickThreads(); else { autoTune(true); renderSettings(); } }),
    rowToggle('Flash attention', 'Faster attention with lower memory use on supported models.', 'flashAttn'),
    rowToggle('Show reasoning traces', 'Display the model\'s thinking in a collapsible card. Use the chat triangle to enable/disable thinking per model.', 'showReasoning'),
    rowModelThinking(),
    rowPicker('Max new tokens', 'Upper bound on tokens generated per reply.', `${settings.maxTokens}`, () => pickValue('Max new tokens', MAXTOK_VALUES, settings.maxTokens, v => `${v} tokens`, v => setSetting('maxTokens', v))),
    rowSlider('Temperature', 'Higher = more creative, lower = more focused.', 'temperature', 0, 2, 0.05, v => v.toFixed(2)),
    rowSlider('Top-p', 'Nucleus sampling probability mass.', 'topP', 0.05, 1, 0.01, v => v.toFixed(2)),
    rowPicker('Top-k', 'Vocabulary shortlist per token.', `${settings.topK}`, () => pickValue('Top-k', TOPK_VALUES, settings.topK, v => `${v}`, v => setSetting('topK', v))),
    rowSlider('Repeat penalty', 'Discourage repeating the same phrases.', 'repeatPenalty', 1, 1.5, 0.01, v => v.toFixed(2)),
  );

  const voice = $('#sec-voice');
  const activeTts = SUPP_MODELS.find(m => m.id === settings.ttsModelId);
  const voiceEngineLabel = settings.ttsEngine === 'system' ? 'System TTS' : (activeTts?.title || settings.ttsEngine);
  const voiceList = activeTts?.voices || null;
  const curVoice = voiceList ? (voiceList.find(x => x.id === settings.ttsSid) || voiceList.find(x => x.id === activeTts.defaultVoice) || voiceList[0]) : null;
  voice.append(
    rowPicker('Live Talk voice', 'Neural voice packs are installed from Model Hub → Supplementary.', voiceEngineLabel, () => {
      emitLocal('sheet.open', {
        title: 'Live Talk voice',
        options: [
          { label: 'Phonon Ultra-Light 8M', sub: '4 learned voices · < 9 MB', value: 'phonon-ultra' },
          { label: 'Phonon Voice Pack (Studio)', sub: '4 neural voices · ~22 MB', value: 'phonon' },
          { label: 'Pocket TTS 100M', sub: 'Install from Supplementary', value: 'pocket-tts' },
          { label: 'Piper VITS Lessac', sub: 'Install from Supplementary', value: 'piper-lessac' },
          { label: 'Kokoro-82M', sub: 'Multi-voice · Hindi', value: 'kokoro' },
          { label: 'System TTS', sub: 'Android text-to-speech', value: 'system' },
        ],
        selected: settings.ttsEngine === 'system' ? 'system' : settings.ttsModelId,
        onPick: v => {
          if (v === 'system') { setSetting('ttsEngine', 'system'); setSetting('ttsModelId', ''); }
          else {
            const m = SUPP_MODELS.find(x => x.id === v);
            if (m) {
              setSetting('ttsEngine', m.engine); setSetting('ttsModelId', m.id);
              if (m.voices) { const ids = m.voices.map(x => x.id); if (!ids.includes(settings.ttsSid)) setSetting('ttsSid', m.defaultVoice ?? ids[0]); }
            }
          }
          configureVoice(); toast('Voice: ' + (v === 'system' ? 'System TTS' : (SUPP_MODELS.find(x => x.id === v)?.title || v))); renderSettings();
        },
      });
    }),
  );
  if (voiceList) {
    voice.append(
      rowPicker('Voice character', `${activeTts.title} — choose one of ${voiceList.length} voices.`, curVoice ? `${curVoice.label} · ${curVoice.desc}` : 'Select', () => {
        emitLocal('sheet.open', {
          title: 'Voice character',
          options: voiceList.map(x => ({ label: x.label, sub: x.desc, value: x.id })),
          selected: settings.ttsSid,
          onPick: v => { setSetting('ttsSid', v); configureVoice(); toast('Voice: ' + (voiceList.find(x => x.id === v)?.label || v)); renderSettings(); },
        });
      }),
      rowButton('Preview voice', 'Hear a sample of the selected voice.', 'Preview', 'volume', () => {
        Promise.resolve(configureVoice()).then(() => previewVoice('Hello! This is my voice. How does it sound?', settings.ttsSid));
      }),
    );
  }
  const asrLabels = { auto: 'Auto', whisper: 'Whisper (offline)', moonshine: 'Moonshine (offline)', sensevoice: 'SenseVoice (offline)', zipformer: 'Zipformer (offline)', system: 'System recognizer' };
  voice.append(
    rowSlider('Speech rate', 'Speaking speed for the Live Talk voice.', 'ttsSpeed', 0.6, 1.6, 0.05, v => v.toFixed(2) + '×'),
    rowPicker('Speech recognition', 'Offline ASR runs on-device; System uses the Android recognizer.', asrLabels[settings.asrEngine] || 'Auto', () => {
      emitLocal('sheet.open', {
        title: 'Speech recognition',
        options: [
          { label: 'Auto', sub: 'Best installed offline model, else System', value: 'auto' },
          { label: 'Whisper (offline)', sub: 'Tiny / Base / Small', value: 'whisper' },
          { label: 'Moonshine (offline)', sub: 'Ultra-fast English', value: 'moonshine' },
          { label: 'SenseVoice (offline)', sub: 'Multilingual + emotion', value: 'sensevoice' },
          { label: 'Zipformer (offline)', sub: 'Streaming-fast English', value: 'zipformer' },
          { label: 'System recognizer', sub: 'Android speech services', value: 'system' },
        ],
        selected: settings.asrEngine,
        onPick: v => { setSetting('asrEngine', v); renderSettings(); },
      });
    }),
    rowSlider('VAD sensitivity', 'Higher = triggers on quieter speech. Lower rejects background noise.', 'vadSensitivity', 0.1, 0.9, 0.05, v => v.toFixed(2)),
  );

  const bat = $('#sec-battery');
  bat.append(
    rowToggle('Battery Saver Mode', 'Cap Live Talk at 30 FPS active / 24 FPS idle and reduce GPU load.', 'batterySaver', () => toast(settings.batterySaver ? 'Battery Saver on' : 'Battery Saver off')),
    rowPicker('FPS target (active)', 'Idle listening always drops to 24–30 FPS automatically.', `${settings.fpsTarget} FPS`, () => pickValue('Active FPS target', FPS_VALUES, settings.fpsTarget, v => `${v} FPS`, v => setSetting('fpsTarget', v))),
  );

  $('#sec-persona').append(rowButton('System Prompt Studio', 'Create, edit and switch the AI persona used in Chat and Live Talk.', 'Open', 'sparkles', openPromptStudio));

  const data = $('#sec-data');
  data.append(
    rowButton('Clear all chats', 'Permanently delete every conversation on this device.', 'Clear', 'trash', () => {
      emitLocal('modal.open', {
        title: 'Clear all chats?', body: '<p class="muted small">Every conversation will be permanently deleted. Models and settings are kept.</p>',
        actions: [{ label: 'Cancel' }, { label: 'Clear all', danger: true, fn: () => { clearAllThreads(); toast('All chats cleared'); } }],
      });
    }, true),
    rowButton('Reset settings', 'Restore every inference, voice and battery option to defaults.', 'Reset', 'refresh', () => { resetSettings(); toast('Settings reset'); renderSettings(); }),
  );

  const about = $('#sec-about');
  about.innerHTML = `
    <div class="settings-row"><div class="row-text"><span class="row-title">Vani AI</span><span class="row-desc">Version 1.3.0 (4) · ai.vani.app · build ${esc(buildInfo?.commit || 'dev')}</span></div><img src="assets/logo-mark.svg" style="width:30px;height:30px" alt=""></div>
    <div class="settings-row"><div class="row-text"><span class="row-title">Private by design</span><span class="row-desc">Inference, speech and chat history stay on this device. Models download only from the sources you choose.</span></div></div>
    <div class="settings-row"><div class="row-text"><span class="row-title">Open source</span><span class="row-desc">llama.cpp · sherpa-onnx · three.js · three-vrm · KaTeX</span></div><button class="btn-secondary" id="about-repo" style="padding:8px 14px;font-size:13px">${icon('link')}<span>GitHub</span></button></div>`;
  about.querySelector('#about-repo').addEventListener('click', () => {
    if (hasNative()) invoke('system.openExternal', { url: 'https://github.com/kanhiayamishra152/Vani' }).catch(() => {});
    else window.open('https://github.com/kanhiayamishra152/Vani', '_blank');
  });
}

/* ============================ init ============================ */
export function initSettings() {
  fetch('build-info.json').then(r => r.json()).then(j => { buildInfo = j; }).catch(() => {});
  on('tab.changed', async t => {
    clearInterval(pollTimer);
    if (t === 'settings') {
      await renderSettings();
      pollTimer = setInterval(async () => {
        if (!hasNative()) return;
        try {
          device = await invoke('device.info');
          const n = $('#tel-free');
          if (n) n.textContent = fmtBytes(device.ramAvailBytes);
        } catch {}
      }, 5000);
    }
  });
  on('settings.changed', p => {
    // Re-apply voice config live if Live Talk is running.
    if (['ttsEngine', 'ttsModelId', 'ttsSpeed', 'ttsSid', 'asrEngine', 'asrModelId'].includes(p.key)) emitLocal('voice.reconfigure', {});
  });
  measure().then(() => autoTune(true));
}
