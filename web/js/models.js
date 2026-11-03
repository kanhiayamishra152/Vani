// Vani AI — Module 3: Model Hub (Google AI Edge Gallery / PocketPal style).
import { $, $$, el, esc, fmtBytes, fmtMB, fmtSpeed, uid } from './util.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { invoke, on, hasNative, emitLocal } from './bridge.js';
import { settings, setSetting } from './store.js';
import { MAIN_MODELS, SUPP_MODELS } from './catalog.js';
import { llm, loadModel, unloadModel, isReady } from './inference.js';

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
    </div>` : `<p class="muted small" style="margin-bottom:14px">Offline voice engines for Live Talk. Downloads extract automatically and run on the bundled sherpa-onnx runtime.</p>`}
    <div id="hub-cards"></div>`;

  $$('#hub-seg button', root).forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; cat = 'all'; renderHub(); }));
  $$('#hub-pills .pill', root).forEach(b => b.addEventListener('click', () => { cat = b.dataset.cat; renderHub(); }));
  root.querySelector('#hub-url')?.addEventListener('click', addByUrlDialog);
  root.querySelector('#hub-import')?.addEventListener('click', async () => {
    if (!hasNative()) { toast('Import needs the Android app'); return; }
    try { await invoke('models.import'); } catch (e) { toast(e.message); }
  });

  const cards = root.querySelector('#hub-cards');
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
      id: `${m.id}:${q}`, url: m.url(q), fileName: m.quants[q].file, total: m.quants[q].size,
      kind: 'llm', modelId: m.id, quant: q, name: `${m.title} (${q})`, extract: false,
    });
    if (wantMm && m.mmproj && !installed.find(x => x.modelId === m.id && x.kind === 'mmproj') && !dlFor(`${m.id}:mmproj`)) {
      await invoke('downloads.start', {
        id: `${m.id}:mmproj`, url: m.mmprojUrl(), fileName: `${m.id}-${m.mmproj.file}`, total: m.mmproj.size,
        kind: 'mmproj', modelId: m.id, quant: 'F16', name: `${m.title} vision projector`, extract: false,
      });
    }
    await refreshModels();
  } catch (e) { toast(e.message); }
}

function suppCard(m) {
  const card = el('div', 'model-card');
  const inst = installedSupp(m.id);
  const isActiveVoice = m.cat === 'tts' && settings.ttsEngine === m.engine && (m.kind === 'builtin' || settings.ttsModelId === m.id);
  const isActiveAsr = m.cat === 'asr' && settings.asrModelId === m.id;

  if (m.kind === 'builtin') {
    card.innerHTML = `
      <div class="model-title-row"><div style="flex:1"><div class="model-title">${esc(m.title)}</div><div class="model-repo">${esc(m.repo)}</div></div></div>
      <div class="badges">${m.badges.map((b, i) => `<span class="badge${i === 0 ? ' solid' : ''}">${b}</span>`).join('')}</div>
      <div class="model-desc">${esc(m.desc)}</div>
      <div class="model-controls"><span data-supp-action></span></div>`;
    const slot = card.querySelector('[data-supp-action]');
    const b = el('button', isActiveVoice ? 'btn-secondary' : 'btn-primary',
      isActiveVoice ? `${icon('check')}<span>Active Voice</span>` : `${icon('volume')}<span>Use This Voice</span>`);
    b.addEventListener('click', () => {
      setSetting('ttsEngine', 'phonon'); setSetting('ttsModelId', 'phonon');
      toast('Phonon is now the Live Talk voice'); renderHub();
    });
    slot.appendChild(b);
    return card;
  }

  const v = variantOf(m);
  const dl = dlFor(`${m.id}:${v}`);
  card.innerHTML = `
    <div class="model-title-row">
      <div style="flex:1;min-width:0"><div class="model-title">${esc(m.title)}</div><div class="model-repo">${esc(m.repo)}</div></div>
      ${inst ? `<button class="icon-btn danger" data-del="${inst.id}" style="width:34px;height:34px">${icon('trash')}</button>` : ''}
    </div>
    <div class="badges">${m.badges.map((b, i) => `<span class="badge${i === 0 ? ' solid' : ''}">${b}</span>`).join('')}<span class="badge">${fmtBytes(m.variants[v].size)}</span></div>
    <div class="model-desc">${esc(m.desc)}</div>
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

  const slot = card.querySelector('[data-supp-action]');
  const dlSlot = card.querySelector(`[data-dl-slot="${m.id}:${v}"]`);
  if (inst) {
    const active = isActiveVoice || isActiveAsr;
    const b = el('button', active ? 'btn-secondary' : 'btn-primary',
      active ? `${icon('check')}<span>Active</span>` : `${icon('bolt')}<span>Activate</span>`);
    b.addEventListener('click', () => {
      if (m.cat === 'tts') { setSetting('ttsEngine', m.engine); setSetting('ttsModelId', m.id); toast(m.title + ' is now the voice'); }
      else { setSetting('asrEngine', 'whisper'); setSetting('asrModelId', m.id); toast(m.title + ' will power speech recognition'); }
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
        await invoke('downloads.start', {
          id: `${m.id}:${v}`, url: m.url(v), fileName: m.variants[v].file, total: m.variants[v].size,
          kind: m.cat, modelId: m.id, quant: v, name: `${m.title} (${v})`, extract: true,
        });
        await refreshModels();
      } catch (e) { toast(e.message); }
    });
    slot.appendChild(b);
  }
  return card;
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

/* ============================ progress ============================ */
function renderProgress(slot, dl) {
  slot.innerHTML = `
    <div class="dl-progress" data-dl-id="${esc(dl.id)}">
      <div class="dl-bar"><div class="dl-bar-fill" style="width:${dl.total ? (100 * dl.received / dl.total).toFixed(1) : 0}%"></div></div>
      <div class="dl-stats"><span data-dl-mb>${fmtMB(dl.received)} / ${dl.total ? fmtMB(dl.total) : '?'} MB</span><span data-dl-pct>${dl.total ? (100 * dl.received / dl.total).toFixed(0) : 0}%</span><span data-dl-speed>${dl.state === 'downloading' ? fmtSpeed(dl.speed || 0) : dl.state}</span></div>
      <div class="dl-actions">
        <button data-act="pause" ${dl.state !== 'downloading' && dl.state !== 'queued' ? 'hidden' : ''}>${icon('pause')}<span>Pause</span></button>
        <button data-act="resume" ${dl.state === 'downloading' || dl.state === 'queued' ? 'hidden' : ''}>${icon('play')}<span>Resume</span></button>
        <button data-act="cancel" class="cancel">${icon('x')}<span>Cancel</span></button>
      </div>
      ${dl.error ? `<div class="muted small mt8">${esc(dl.error)}</div>` : ''}
    </div>`;
  slot.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    try {
      if (act === 'cancel') {
        emitLocal('modal.open', {
          title: 'Cancel download?', body: '<p class="muted small">Progress will be discarded. You can also pause and resume later from the exact byte offset.</p>',
          actions: [{ label: 'Keep' }, { label: 'Cancel download', danger: true, fn: async () => { await invoke('downloads.cancel', { id: dl.id }); refreshModels(); } }],
        });
      } else { await invoke(`downloads.${act}`, { id: dl.id }); }
    } catch (e) { toast(e.message); }
  }));
}

function paintProgress(p) {
  const node = document.querySelector(`[data-dl-id="${CSS.escape(p.id)}"]`);
  if (!node) return;
  const pct = p.total ? (100 * p.received / p.total) : 0;
  node.querySelector('.dl-bar-fill').style.width = pct.toFixed(1) + '%';
  node.querySelector('[data-dl-mb]').textContent = `${fmtMB(p.received)} / ${p.total ? fmtMB(p.total) : '?'} MB`;
  node.querySelector('[data-dl-pct]').textContent = pct.toFixed(0) + '%';
  node.querySelector('[data-dl-speed]').textContent = p.state === 'downloading' ? fmtSpeed(p.speed || 0) : (p.state === 'extracting' ? 'extracting…' : p.state);
  const pause = node.querySelector('[data-act="pause"]');
  const resume = node.querySelector('[data-act="resume"]');
  if (pause && resume) {
    pause.hidden = !(p.state === 'downloading' || p.state === 'queued');
    resume.hidden = (p.state === 'downloading' || p.state === 'queued');
  }
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
  on('llm.status', () => { if ($('#screen-models').classList.contains('active')) renderHub(); });
  on('settings.changed', () => { if ($('#screen-models').classList.contains('active')) renderHub(); });
  on('nav', t => { if (t === 'models') refreshModels(); });
  refreshModels();
}
