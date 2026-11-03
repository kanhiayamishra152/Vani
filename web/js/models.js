// Vani AI — Module 3: Model Hub (Google AI Edge Gallery / PocketPal style).
import { $, $$, el, esc, fmtBytes, fmtMB, fmtSpeed, uid } from './util.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { invoke, on, hasNative, emitLocal } from './bridge.js';
import { settings, setSetting } from './store.js';
import { MAIN_MODELS, SUPP_MODELS } from './catalog.js';
import { llm, loadModel, unloadModel, isReady } from './inference.js';
import { configureVoice, previewVoice } from './voice.js';

let tab = 'main';
let cat = 'all';
let installed = [];      // native model registry
let downloads = [];      // native download states
const quantSel = new Map();
const variantSel = new Map();
const mmprojSel = new Map();
let openQuantMenu = null;

const dlFor = id => downloads.find(d => d.id === id && d.state !== 'done' && d.state !== 'cancelled');
const installedFor = (modelId, quant) => installed.find(m => m.modelId === modelId && m.kind === 'llm' && (!quant || m.quant === quant));
const installedSupp = modelId => installed.find(m => m.modelId === modelId && (m.kind === 'tts' || m.kind === 'asr'));

export async function refreshModels() {
  if (!hasNative()) return;
  try {
    [installed, downloads] = await Promise.all([invoke('models.list'), invoke('downloads.list')]);
  } catch { installed = []; downloads = []; }
  if ($('#screen-models').classList.contains('active')) renderHub();
}

/* ============================ rendering ============================ */
export function renderHub() {
  const root = $('#models-scroll');
  const cats = tab === 'main'
    ? [['all', 'All'], ['omni', 'Omni'], ['vision', 'Vision + Text'], ['text', 'Text']]
    : [['all', 'All'], ['tts', 'TTS'], ['asr', 'ASR']];
  root.innerHTML = `
    <div class="seg" id="hub-seg">
      <button data-tab="main" class="${tab === 'main' ? 'active' : ''}">Main Models</button>
      <button data-tab="supp" class="${tab === 'supp' ? 'active' : ''}">Supplementary</button>
    </div>
    <div class="pills" id="hub-pills">
      ${cats.map(([id, label]) => `<button class="pill${cat === id ? ' active' : ''}" data-cat="${id}">${label}</button>`).join('')}
    </div>
    ${tab === 'main' ? `<div class="hub-actions">
      <button class="btn-secondary" id="hub-url">${icon('link')}<span>Add GGUF by URL</span></button>
      <button class="btn-secondary" id="hub-import">${icon('folder')}<span>Import local file</span></button>
    </div>` : `<div class="hub-actions">
      <button class="btn-secondary" id="supp-url">${icon('link')}<span>Add TTS/ASR by HF URL</span></button>
      <button class="btn-secondary" id="supp-import">${icon('folder')}<span>Import .onnx/.bin</span></button>
    </div>
    <p class="muted small" style="margin-bottom:14px">Offline voice engines for Live Talk on the bundled sherpa-onnx runtime. Standalone files install directly; archives stream-extract with live progress.</p>`}
    <div id="hub-cards"></div>`;

  $$('#hub-seg button', root).forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; cat = 'all'; renderHub(); }));
  $$('#hub-pills .pill', root).forEach(b => b.addEventListener('click', () => { cat = b.dataset.cat; renderHub(); }));
  root.querySelector('#hub-url')?.addEventListener('click', addByUrlDialog);
  root.querySelector('#supp-url')?.addEventListener('click', addSuppDialog);
  const importHandler = async () => {
    if (!hasNative()) { toast('Import needs the Android app'); return; }
    try { await invoke('models.import'); } catch (e) { toast(e.message); }
  };
  root.querySelector('#hub-import')?.addEventListener('click', importHandler);
  root.querySelector('#supp-import')?.addEventListener('click', importHandler);

  const cards = root.querySelector('#hub-cards');
  // Top "Downloaded / Installed" section reconciles everything on disk.
  if (cat === 'all') {
    const sec = installedSection();
    if (sec) cards.appendChild(sec);
  }
  if (tab === 'main') {
    const list = MAIN_MODELS.filter(m => cat === 'all' || m.cat === cat);
    list.forEach(m => cards.appendChild(mainCard(m)));
    const customs = installed.filter(m => m.modelId === 'custom');
    const customDls = downloads.filter(d => d.modelId === 'custom' && d.state !== 'done' && d.state !== 'cancelled');
    if ((customs.length || customDls.length) && cat === 'all') {
      cards.appendChild(el('div', 'settings-section-title mt16', 'Custom models'));
      customDls.forEach(d => cards.appendChild(customCard(d)));
      customs.forEach(m => cards.appendChild(customCard(null, m)));
    }
    if (!list.length) cards.appendChild(el('p', 'muted small', 'No models in this category.'));
  } else {
    SUPP_MODELS.filter(m => cat === 'all' || m.cat === cat).forEach(m => cards.appendChild(suppCard(m)));
  }
}

function quantOf(m) { return quantSel.get(m.id) || m.defaultQuant; }
function variantOf(m) { return variantSel.get(m.id) || m.defaultVariant; }

function mainCard(m) {
  const q = quantOf(m);
  const card = el('div', 'model-card');
  card.dataset.model = m.id;
  const inst = installedFor(m.id, q);
  const mmInst = installed.find(x => x.modelId === m.id && x.kind === 'mmproj');
  const dl = dlFor(`${m.id}:${q}`);
  const mmDl = dlFor(`${m.id}:mmproj`);
  const wantMm = mmprojSel.get(m.id) !== false;

  card.innerHTML = `
    <div class="model-title-row">
      <div style="flex:1;min-width:0">
        <div class="model-title">${esc(m.title)}</div>
        <div class="model-repo">${esc(m.repo)}</div>
      </div>
      ${inst ? `<button class="icon-btn danger" data-del="${inst.id}" style="width:34px;height:34px">${icon('trash')}</button>` : ''}
    </div>
    <div class="badges">${m.badges.map((b, i) => `<span class="badge${i === 0 ? ' solid' : ''}">${esc(b)}</span>`).join('')}<span class="badge">${esc(m.ram)}</span></div>
    <div class="model-desc">${esc(m.desc)}</div>
    <div class="model-controls">
      <div class="quant-wrap">
        <button class="quant-btn" data-quant-btn="${m.id}">${esc(q)} ${icon('chevronDown')}</button>
      </div>
      <span class="model-size">${fmtBytes(m.quants[q].size)}</span>
      <span data-action-slot="${m.id}:${q}"></span>
    </div>
    ${m.mmproj && !mmInst ? `<label class="mmproj-row"><input type="checkbox" data-mmproj="${m.id}" ${wantMm ? 'checked' : ''}> ${esc(m.mmproj.label)} · ${fmtBytes(m.mmproj.size)}${mmDl ? ' (downloading…)' : ''}</label>` : ''}
    ${m.mmproj && mmInst ? `<div class="mmproj-row">${icon('check')} Vision projector installed</div>` : ''}
    <div data-dl-slot="${m.id}:${q}"></div>`;

  wireQuantMenu(card, m);
  card.querySelector(`[data-mmproj="${m.id}"]`)?.addEventListener('change', e => mmprojSel.set(m.id, e.target.checked));
  card.querySelector('[data-del]')?.addEventListener('click', () => deleteModel(inst.id, m.title));
  paintAction(card, m, q, inst, dl, mmDl, wantMm);
  return card;
}

function wireQuantMenu(card, m) {
  const btn = card.querySelector(`[data-quant-btn="${m.id}"]`);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    closeQuantMenu();
    const menu = el('div', 'quant-menu');
    menu.innerHTML = Object.entries(m.quants).map(([q, info]) =>
      `<div class="quant-option${q === quantOf(m) ? ' sel' : ''}" data-q="${q}"><span>${q}</span><span class="q-size">${fmtBytes(info.size)}</span></div>`).join('');
    btn.parentElement.appendChild(menu);
    openQuantMenu = menu;
    $$('.quant-option', menu).forEach(o => o.addEventListener('click', ev => {
      ev.stopPropagation();
      quantSel.set(m.id, o.dataset.q);
      closeQuantMenu();
      renderHub();
    }));
  });
}
function closeQuantMenu() { openQuantMenu?.remove(); openQuantMenu = null; }
document.addEventListener('click', closeQuantMenu);

function paintAction(card, m, q, inst, dl, mmDl, wantMm) {
  const slot = card.querySelector(`[data-action-slot="${m.id}:${q}"]`);
  const dlSlot = card.querySelector(`[data-dl-slot="${m.id}:${q}"]`);
  slot.innerHTML = ''; dlSlot.innerHTML = '';
  if (inst) {
    const active = isReady() && llm.info?.modelPath === inst.path;
    const b = el('button', active ? 'btn-secondary' : 'btn-primary',
      active ? `${icon('check')}<span>Active · Unload</span>` : `${icon('bolt')}<span>Load Model</span>`);
    b.addEventListener('click', async () => {
      if (active) { await unloadModel(); toast('Model unloaded'); renderHub(); return; }
      toast('Loading ' + m.title + '…');
      try {
        const mm = installed.find(x => x.modelId === m.id && x.kind === 'mmproj');
        await loadModel(inst, mm);
        toast(m.title + ' ready');
        emitLocal('nav', 'chat');
      } catch (e) { toast('Load failed: ' + e.message); }
      renderHub();
    });
    slot.appendChild(b);
    return;
  }
  if (dl) { renderProgress(dlSlot, dl); return; }
  const b = el('button', 'btn-primary', `${icon('download')}<span>Download</span>`);
  b.addEventListener('click', () => startMainDownload(m, q, wantMm));
  slot.appendChild(b);
}

async function startMainDownload(m, q, wantMm) {
  if (!hasNative()) { toast('Downloads need the Android app'); return; }
  try {
    await invoke('downloads.start', {
      id: `${m.id}:${q}`, groupId: `${m.id}:${q}`, url: m.url(q), fileName: m.quants[q].file, total: m.quants[q].size,
      kind: 'llm', modelId: m.id, quant: q, name: `${m.title} (${q})`, extract: false,
    });
    if (wantMm && m.mmproj && !installed.find(x => x.modelId === m.id && x.kind === 'mmproj') && !dlFor(`${m.id}:mmproj`)) {
      await invoke('downloads.start', {
        id: `${m.id}:mmproj`, groupId: `${m.id}:${q}`, url: m.mmprojUrl(), fileName: `${m.id}-${m.mmproj.file}`, total: m.mmproj.size,
        kind: 'mmproj', modelId: m.id, quant: 'F16', name: `${m.title} vision projector`, extract: false,
      });
    }
    await refreshModels();
  } catch (e) { toast(e.message); }
}

function suppCard(m) {
  const card = el('div', 'model-card');
  const inst = installedSupp(m.id);
  const isActiveVoice = m.cat === 'tts' && settings.ttsModelId === m.id;
  const isActiveAsr = m.cat === 'asr' && settings.asrModelId === m.id;
  const v = variantOf(m);
  const variant = m.variants[v];
  const dl = dlFor(`${m.id}:${v}`);

  card.innerHTML = `
    <div class="model-title-row">
      <div style="flex:1;min-width:0"><div class="model-title">${esc(m.title)}</div><div class="model-repo">${esc(m.repo)}</div></div>
      ${inst ? `<button class="icon-btn danger" data-del="${inst.id}" style="width:34px;height:34px">${icon('trash')}</button>` : ''}
    </div>
    <div class="badges">${m.badges.map((b, i) => `<span class="badge${i === 0 ? ' solid' : ''}">${b}</span>`).join('')}<span class="badge">${fmtBytes(variant.size)}</span></div>
    <div class="model-desc">${esc(m.desc)}</div>
    ${inst && m.voices ? `
      <div class="voice-picker">
        <select data-voice-sel="${m.id}" aria-label="Voice">
          ${m.voices.map(x => `<option value="${x.id}">${esc(x.label)} — ${esc(x.desc)}</option>`).join('')}
        </select>
        <button class="btn-secondary btn-sm" data-voice-preview="${m.id}">${icon('volume')}<span>Preview Voice</span></button>
      </div>` : ''}
    <div class="model-controls">
      ${Object.keys(m.variants).length > 1 ? `<div class="quant-wrap"><button class="quant-btn" data-variant-btn="${m.id}">${esc(v)} ${icon('chevronDown')}</button></div>` : ''}
      <span data-supp-action></span>
    </div>
    <div data-dl-slot="${m.id}:${v}"></div>`;

  const vbtn = card.querySelector(`[data-variant-btn="${m.id}"]`);
  vbtn?.addEventListener('click', e => {
    e.stopPropagation();
    closeQuantMenu();
    const menu = el('div', 'quant-menu');
    menu.innerHTML = Object.entries(m.variants).map(([k, info]) =>
      `<div class="quant-option${k === v ? ' sel' : ''}" data-v="${k}"><span>${k}</span><span class="q-size">${fmtBytes(info.size)}</span></div>`).join('');
    vbtn.parentElement.appendChild(menu);
    openQuantMenu = menu;
    $$('.quant-option', menu).forEach(o => o.addEventListener('click', ev => {
      ev.stopPropagation(); variantSel.set(m.id, o.dataset.v); closeQuantMenu(); renderHub();
    }));
  });
  card.querySelector('[data-del]')?.addEventListener('click', () => deleteModel(inst.id, m.title));
  wireVoicePicker(card, m, inst);

  const slot = card.querySelector('[data-supp-action]');
  const dlSlot = card.querySelector(`[data-dl-slot="${m.id}:${v}"]`);
  if (inst) {
    const active = isActiveVoice || isActiveAsr;
    const b = el('button', active ? 'btn-secondary' : 'btn-primary',
      active ? `${icon('check')}<span>Active</span>` : `${icon('bolt')}<span>Activate</span>`);
    b.addEventListener('click', () => {
      if (m.cat === 'tts') {
        setSetting('ttsEngine', m.engine); setSetting('ttsModelId', m.id);
        if (m.voices) {
          const ids = m.voices.map(x => x.id);
          if (!ids.includes(settings.ttsSid)) setSetting('ttsSid', m.defaultVoice ?? ids[0]);
        }
        configureVoice();
        toast(m.title + ' is now the voice');
      } else { setSetting('asrEngine', m.engine); setSetting('asrModelId', m.id); toast(m.title + ' will power speech recognition'); }
      renderHub();
    });
    slot.appendChild(b);
  } else if (dl) {
    renderProgress(dlSlot, dl);
  } else {
    const b = el('button', 'btn-primary', `${icon('download')}<span>Download</span>`);
    b.addEventListener('click', async () => {
      if (!hasNative()) { toast('Downloads need the Android app'); return; }
      try {
        const entry = {
          id: `${m.id}:${v}`, fileName: variant.file || `${m.id}-${v}`, total: variant.size,
          kind: m.cat, modelId: m.id, quant: v, name: `${m.title} (${v})`,
          engine: m.engine, category: m.cat, extract: m.kind === 'archive',
        };
        if (m.kind === 'files') entry.files = variant.files;
        else entry.url = m.url(v);
        await invoke('downloads.start', entry);
        await refreshModels();
      } catch (e) { toast(e.message); }
    });
    slot.appendChild(b);
  }
  return card;
}

/** Voice selector + preview for installed multi-speaker TTS packs. */
function wireVoicePicker(card, m, inst) {
  const sel = card.querySelector(`[data-voice-sel="${m.id}"]`);
  if (!sel || !inst) return;
  const ids = m.voices.map(x => x.id);
  sel.value = String(ids.includes(settings.ttsSid) ? settings.ttsSid : (m.defaultVoice ?? ids[0]));
  sel.addEventListener('change', () => {
    const sid = parseInt(sel.value, 10);
    setSetting('ttsSid', sid);
    if (settings.ttsModelId === m.id) configureVoice();
  });
  card.querySelector(`[data-voice-preview="${m.id}"]`)?.addEventListener('click', async () => {
    const sid = parseInt(sel.value, 10);
    setSetting('ttsEngine', m.engine); setSetting('ttsModelId', m.id); setSetting('ttsSid', sid);
    try { await previewVoice('Hello! This is my voice. How does it sound?', sid); }
    catch (e) { toast(e.message || 'Voice preview failed'); }
    renderHub();
  });
}

function customCard(dl, inst) {
  const card = el('div', 'model-card');
  const title = inst?.name || dl?.name || 'Custom GGUF';
  card.innerHTML = `
    <div class="model-title-row"><div style="flex:1;min-width:0"><div class="model-title">${esc(title)}</div><div class="model-repo">${esc(inst?.fileName || dl?.fileName || '')}</div></div>
    ${inst ? `<button class="icon-btn danger" data-del style="width:34px;height:34px">${icon('trash')}</button>` : ''}</div>
    <div class="model-controls mt8"><span data-supp-action></span><span class="model-size">${fmtBytes(inst?.sizeBytes || dl?.total || 0)}</span></div>
    <div data-dl-slot="${dl?.id || ''}"></div>`;
  card.querySelector('[data-del]')?.addEventListener('click', () => deleteModel(inst.id, title));
  const slot = card.querySelector('[data-supp-action]');
  if (inst) {
    const active = isReady() && llm.info?.modelPath === inst.path;
    const b = el('button', active ? 'btn-secondary' : 'btn-primary', active ? `${icon('check')}<span>Active · Unload</span>` : `${icon('bolt')}<span>Load Model</span>`);
    b.addEventListener('click', async () => {
      if (active) { await unloadModel(); renderHub(); return; }
      try { await loadModel(inst); toast('Model ready'); emitLocal('nav', 'chat'); } catch (e) { toast(e.message); }
      renderHub();
    });
    slot.appendChild(b);
  } else if (dl) {
    renderProgress(card.querySelector('[data-dl-slot]'), dl);
  }
  return card;
}

/* ============================ installed section ============================ */
function installedSection() {
  const items = installed.filter(m => m.kind !== 'mmproj');
  if (!items.length) return null;
  const wrap = el('div', 'installed-section');
  wrap.appendChild(el('div', 'settings-section-title', `Downloaded / Installed (${items.length})`));
  items.forEach(m => wrap.appendChild(installedRow(m)));
  return wrap;
}

function installedRow(m) {
  const row = el('div', 'installed-row');
  const isLlm = m.kind === 'llm' || m.kind === 'gguf';
  const active = isLlm ? (isReady() && llm.info?.modelPath === m.path)
    : (m.kind === 'tts' ? settings.ttsModelId === m.modelId : settings.asrModelId === m.modelId);
  const kindLabel = isLlm ? 'LLM' : (m.kind || '').toUpperCase();
  row.innerHTML = `
    <div class="installed-info">
      <div class="installed-name">${esc(m.name || m.modelId)}</div>
      <div class="installed-meta">${esc(kindLabel)}${m.engine ? ' · ' + esc(m.engine) : ''} · ${fmtBytes(m.sizeBytes || 0)}</div>
    </div>
    <button class="btn-secondary btn-sm" data-use>${active ? `${icon('check')}<span>Active</span>` : `${icon('bolt')}<span>Use</span>`}</button>
    <button class="icon-btn danger" data-del style="width:32px;height:32px">${icon('trash')}</button>`;
  row.querySelector('[data-use]').addEventListener('click', async () => {
    if (isLlm) {
      if (active) { await unloadModel(); renderHub(); return; }
      try {
        const mm = installed.find(x => x.modelId === m.modelId && x.kind === 'mmproj');
        await loadModel(m, mm); toast('Model ready'); emitLocal('nav', 'chat');
      } catch (e) { toast('Load failed: ' + e.message); }
      renderHub();
    } else if (m.kind === 'tts') {
      setSetting('ttsEngine', m.engine || 'vits'); setSetting('ttsModelId', m.modelId);
      configureVoice(); toast((m.name || m.modelId) + ' is now the voice'); renderHub();
    } else {
      setSetting('asrEngine', m.engine || 'whisper'); setSetting('asrModelId', m.modelId);
      toast((m.name || m.modelId) + ' will power speech recognition'); renderHub();
    }
  });
  row.querySelector('[data-del]').addEventListener('click', () => deleteModel(m.id, m.name || m.modelId));
  return row;
}

/* ============================ add TTS/ASR by HF URL/repo ============================ */
function addSuppDialog() {
  emitLocal('modal.open', {
    title: 'Add TTS / ASR model',
    body: `
      <div class="field"><label>Display name</label><input type="text" id="supp-add-name" placeholder="My voice model"></div>
      <div class="field"><label>Hugging Face URL or repo</label><input type="text" id="supp-add-url" placeholder="owner/repo  or  https://huggingface.co/…/resolve/main/model.onnx"></div>
      <div class="field"><label>Type</label><select id="supp-add-cat"><option value="tts">TTS (voice)</option><option value="asr">ASR (speech recognition)</option></select></div>
      <div class="field"><label>Engine</label><select id="supp-add-engine">
        <optgroup label="TTS"><option value="vits">Piper VITS</option><option value="kokoro">Kokoro</option><option value="pocket">Pocket TTS</option></optgroup>
        <optgroup label="ASR"><option value="whisper">Whisper</option><option value="moonshine">Moonshine</option><option value="sensevoice">SenseVoice</option><option value="zipformer">Zipformer</option></optgroup>
      </select></div>
      <p class="muted small">Paste a repo (owner/name) to auto-fetch its model files, or a direct .onnx / .tar.bz2 URL. Files install to native storage and persist across launches.</p>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Add & Download', primary: true, fn: async root => {
        let url = root.querySelector('#supp-add-url').value.trim();
        const name = root.querySelector('#supp-add-name').value.trim() || 'Custom voice model';
        const cat = root.querySelector('#supp-add-cat').value;
        const engine = root.querySelector('#supp-add-engine').value;
        if (!url) { toast('Enter a Hugging Face URL or repo'); return false; }
        if (!hasNative()) { toast('Downloads need the Android app'); return false; }
        const modelId = `custom-${uid()}`;
        try {
          if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://huggingface.co/${url}`;
          const isRepo = /huggingface\.co\/[^/]+\/[^/]+\/?$/.test(url) && !url.includes('/resolve/');
          if (isRepo) {
            const repo = url.replace(/\/+$/, '').split('huggingface.co/')[1];
            const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`, { signal: AbortSignal.timeout(20000) });
            if (!res.ok) throw new Error('Repo not found (HTTP ' + res.status + ')');
            const tree = await res.json();
            const files = (Array.isArray(tree) ? tree : [])
              .filter(f => f.type === 'file' && /\.(onnx|txt|bin|json)$/i.test(f.path) && !/test_wavs|README|\.gitattributes/i.test(f.path))
              .map(f => ({ name: f.path.split('/').pop(), url: `https://huggingface.co/${repo}/resolve/main/${f.path}?download=true`, bytes: f.size || 0 }));
            if (!files.length) { toast('No .onnx model files found in that repo'); return false; }
            const total = files.reduce((a, f) => a + (f.bytes || 0), 0);
            await invoke('downloads.start', { id: `${modelId}:custom`, fileName: modelId, total, kind: cat, modelId, quant: 'custom', name, engine, category: cat, extract: false, files });
          } else if (/\.tar\.bz2(\?|$)/i.test(url)) {
            const fileName = decodeURIComponent(url.split('?')[0].split('/').pop() || 'model.tar.bz2');
            await invoke('downloads.start', { id: `${modelId}:custom`, url, fileName, total: 0, kind: cat, modelId, quant: 'custom', name, engine, category: cat, extract: true });
          } else {
            const fileName = decodeURIComponent(url.split('?')[0].split('/').pop() || 'model.onnx');
            await invoke('downloads.start', { id: `${modelId}:custom`, fileName: modelId, total: 0, kind: cat, modelId, quant: 'custom', name, engine, category: cat, extract: false, files: [{ name: fileName, url, bytes: 0 }] });
          }
          toast('Download started');
          refreshModels();
        } catch (e) { toast(e.message); return false; }
      } },
    ],
  });
}

/* ============================ progress ============================ */
function renderProgress(slot, dl) {
  slot.innerHTML = `
    <div class="dl-progress" data-dl-id="${esc(dl.id)}">
      <div class="dl-bar"><div class="dl-bar-fill" style="width:${dl.total ? (100 * dl.received / dl.total).toFixed(1) : 0}%"></div></div>
      <div class="dl-stats"><span data-dl-mb>${fmtMB(dl.received)} / ${dl.total ? fmtMB(dl.total) : '?'} MB</span><span data-dl-pct>${dl.total ? (100 * dl.received / dl.total).toFixed(0) : 0}%</span><span data-dl-speed>${dlSpeedLabel(dl)}</span></div>
      <div class="dl-actions">
        <button data-act="pause" ${dl.state !== 'downloading' && dl.state !== 'queued' ? 'hidden' : ''}>${icon('pause')}<span>Pause</span></button>
        <button data-act="resume" ${dl.state !== 'paused' ? 'hidden' : ''}>${icon('play')}<span>Resume</span></button>
        <button data-act="cancel" class="cancel" ${dl.state === 'finalizing' ? 'hidden' : ''}>${icon('x')}<span>Cancel</span></button>
      </div>
      ${dl.error ? `<div class="muted small mt8">${esc(dl.error)}</div>` : ''}
    </div>`;
  slot.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    try {
      if (act === 'cancel') {
        emitLocal('modal.open', {
          title: 'Cancel download?', body: '<p class="muted small">Progress will be discarded. You can also pause and resume later from the exact byte offset.</p>',
          actions: [{ label: 'Keep' }, { label: 'Cancel download', danger: true, fn: async () => { await invoke('downloads.cancel', { id: dl.id, groupId: dl.groupId || '' }); refreshModels(); } }],
        });
      } else { await invoke(`downloads.${act}`, { id: dl.id }); }
    } catch (e) { toast(e.message); }
  }));
}

function dlSpeedLabel(dl) {
  if (dl.state === 'downloading') return fmtSpeed(dl.speed || 0);
  if (dl.state === 'extracting') return 'extracting…';
  if (dl.state === 'finalizing') return 'installing…';
  if (dl.state === 'queued') return 'queued';
  return dl.state;
}

function paintProgress(p) {
  const node = document.querySelector(`[data-dl-id="${CSS.escape(p.id)}"]`);
  if (!node) return;
  const pct = p.total ? Math.min(100, 100 * p.received / p.total) : 0;
  node.querySelector('.dl-bar-fill').style.width = pct.toFixed(1) + '%';
  node.querySelector('[data-dl-mb]').textContent = `${fmtMB(p.received)} / ${p.total ? fmtMB(p.total) : '?'} MB`;
  node.querySelector('[data-dl-pct]').textContent = pct.toFixed(0) + '%';
  node.querySelector('[data-dl-speed]').textContent = dlSpeedLabel(p);
  const busy = p.state === 'downloading' || p.state === 'queued';
  const finalizing = p.state === 'finalizing';
  const pause = node.querySelector('[data-act="pause"]');
  const resume = node.querySelector('[data-act="resume"]');
  const cancel = node.querySelector('[data-act="cancel"]');
  if (pause) pause.hidden = !busy;
  if (resume) resume.hidden = p.state !== 'paused'; // never show Resume at 100%
  if (cancel) cancel.hidden = finalizing;
}

/* ============================ dialogs ============================ */
function addByUrlDialog() {
  emitLocal('modal.open', {
    title: 'Add GGUF by URL',
    body: `
      <div class="field"><label>Display name</label><input type="text" id="url-name" placeholder="My model"></div>
      <div class="field"><label>Direct .gguf URL</label><input type="url" id="url-input" placeholder="https://huggingface.co/…/resolve/main/model.gguf"></div>
      <p class="muted small">Downloads stream to native storage with HTTP Range resume — interruptions never lose progress.</p>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Download', primary: true, fn: async root => {
        const url = root.querySelector('#url-input').value.trim();
        const name = root.querySelector('#url-name').value.trim() || 'Custom GGUF';
        if (!/^https?:\/\/.+/.test(url)) { toast('Enter a valid URL'); return false; }
        if (!hasNative()) { toast('Downloads need the Android app'); return; }
        const fileName = decodeURIComponent(url.split('?')[0].split('/').pop() || 'model.gguf');
        try {
          await invoke('downloads.start', { id: `custom:${uid()}`, url, fileName, total: 0, kind: 'llm', modelId: 'custom', quant: '', name, extract: false });
          toast('Download started');
          refreshModels();
        } catch (e) { toast(e.message); }
      } },
    ],
  });
}

function deleteModel(id, title) {
  emitLocal('modal.open', {
    title: 'Delete model?',
    body: `<p class="muted small">"${esc(title)}" will be removed from device storage. You can re-download it anytime.</p>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Delete', danger: true, fn: async () => {
        const active = isReady() && llm.info?.modelPath === installed.find(m => m.id === id)?.path;
        if (active) await unloadModel();
        await invoke('models.delete', { id });
        toast('Model deleted');
        refreshModels();
      } },
    ],
  });
}

/* ============================ init ============================ */
export function initModels() {
  on('download.progress', paintProgress);
  on('download.done', () => { refreshModels(); });
  on('download.state', () => { refreshModels(); });
  on('models.changed', refreshModels);
  on('llm.statusChanged', () => { if ($('#screen-models').classList.contains('active')) renderHub(); });
  on('settings.changed', () => { if ($('#screen-models').classList.contains('active')) renderHub(); });
  on('tab.changed', t => { if (t === 'models') refreshModels(); });
  refreshModels().then(() => {
    // Auto-resume downloads interrupted by an app kill (active states only —
    // never override a user's intentional Pause). The native service resumes
    // from the .part offset or idempotently finalizes a complete download.
    if (!hasNative()) return;
    for (const d of downloads) {
      if (['downloading', 'queued', 'extracting', 'finalizing'].includes(d.state)) {
        invoke('downloads.resume', { id: d.id }).catch(() => {});
      }
    }
  });
}
