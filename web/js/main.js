// Vani AI — app bootstrap: navigation, back stack, modals/sheets, lifecycle.
import { $, $$, el, esc } from './util.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { on, invoke, hasNative, emitLocal } from './bridge.js';
import { initChat, closeDrawer, drawerOpen, closeCamera, cameraOpen } from './chat.js';
import { initModels } from './models.js';
import { initSettings } from './settings.js';
import { initLive, closeLive, isLiveOpen } from './live.js';
import { refreshStatus, autoRestore } from './inference.js';

let currentTab = 'chat';
const backStack = [];
let modalOpen = false;
let sheetOpen = false;

/* ---------------- navigation ---------------- */
function nav(tab) {
  currentTab = tab;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${tab}`));
  $$('#tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  // Notify listeners on a SEPARATE event. nav() also listens to 'nav' (command
  // channel), so emitting 'nav' here would recurse infinitely and freeze the UI.
  emitLocal('tab.changed', tab);
  syncBackState();
}

function syncBackState() {
  if (hasNative()) invoke('system.setBackState', { handled: backStack.length > 0 || currentTab !== 'chat' }).catch(() => {});
}

on('nav', nav);
on('back.push', tag => { if (!backStack.includes(tag)) backStack.push(tag); syncBackState(); });
on('back.pop', tag => { const i = backStack.indexOf(tag); if (i >= 0) backStack.splice(i, 1); syncBackState(); });

function handleBack() {
  const top = backStack[backStack.length - 1];
  if (top === 'live') { closeLive(); return; }
  if (top === 'sheet') { closeSheet(); return; }
  if (top === 'modal') { closeModal(); return; }
  if (top === 'camera') { closeCamera(); return; }
  if (top === 'drawer') { closeDrawer(); return; }
  if (currentTab !== 'chat') { nav('chat'); return; }
  if (hasNative()) invoke('system.exit').catch(() => {});
}
on('system.back', handleBack);

/* ---------------- modal ---------------- */
function openModal({ title, body, actions = [], onMount, wide }) {
  closeModal();
  const root = $('#modal-root');
  root.hidden = false;
  modalOpen = true;
  emitLocal('back.push', 'modal');
  root.innerHTML = `
    <div class="modal" ${wide ? 'style="max-width:480px"' : ''}>
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" id="modal-x" style="width:34px;height:34px">${icon('x')}</button></div>
      <div class="modal-body">${body || ''}</div>
      ${actions.length ? `<div class="modal-foot">${actions.map((a, i) => `<button class="${a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : 'btn-secondary'}" data-mi="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
  $('#modal-x').addEventListener('click', closeModal);
  $$('[data-mi]', root).forEach(b => b.addEventListener('click', async () => {
    const a = actions[Number(b.dataset.mi)];
    let keep = false;
    try { keep = (await a.fn?.(root)) === false; } catch (e) { toast(e.message); }
    if (!keep) closeModal();
  }));
  onMount?.(root);
}
function closeModal() {
  if (!modalOpen) return;
  modalOpen = false;
  const root = $('#modal-root');
  root.hidden = true; root.innerHTML = '';
  emitLocal('back.pop', 'modal');
}
on('modal.open', openModal);
on('modal.close', closeModal);

/* ---------------- bottom sheet (actions / pickers) ---------------- */
function openSheet(cfg) {
  closeSheet();
  const root = $('#sheet-root');
  root.hidden = false;
  sheetOpen = true;
  emitLocal('back.push', 'sheet');
  root.innerHTML = `<div class="sheet"><div class="sheet-grip"></div>${cfg.title ? `<div class="sheet-title">${esc(cfg.title)}</div>` : ''}<div class="sheet-list" id="sheet-list"></div></div>`;
  const list = $('#sheet-list');
  if (cfg.custom) {
    cfg.custom(list);
  } else if (cfg.options) {
    list.innerHTML = cfg.options.map((o, i) => `
      <div class="picker-option${o.value === cfg.selected ? ' sel' : ''}" data-oi="${i}">
        <span>${esc(o.label)}${o.sub ? `<div class="picker-sub">${esc(o.sub)}</div>` : ''}</span>
        ${o.value === cfg.selected ? icon('check') : ''}
      </div>`).join('');
    $$('[data-oi]', list).forEach(n => n.addEventListener('click', () => {
      const o = cfg.options[Number(n.dataset.oi)];
      closeSheet();
      cfg.onPick?.(o.value);
    }));
  } else if (cfg.items) {
    list.innerHTML = cfg.items.map((it, i) => `<div class="action-item${it.danger ? ' danger' : ''}" data-ai="${i}">${icon(it.icon || 'chevronRight')}<span>${esc(it.label)}</span></div>`).join('');
    $$('[data-ai]', list).forEach(n => n.addEventListener('click', () => {
      const it = cfg.items[Number(n.dataset.ai)];
      closeSheet();
      it.fn?.();
    }));
  }
  root.addEventListener('click', e => { if (e.target === root) closeSheet(); }, { once: true });
}
function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false;
  const root = $('#sheet-root');
  root.hidden = true; root.innerHTML = '';
  emitLocal('back.pop', 'sheet');
}
on('sheet.open', openSheet);
on('sheet.close', closeSheet);

/* ---------------- lifecycle ---------------- */
let bgState = false;
function setBackground(bg) {
  if (bgState === bg) return;
  bgState = bg;
  emitLocal(bg ? 'app.background' : 'app.foreground', {});
}
document.addEventListener('visibilitychange', () => setBackground(document.hidden));
on('app.background.native', () => setBackground(true));
on('app.foreground.native', () => setBackground(false));

/* ---------------- boot ---------------- */
function boot() {
  // Tab bar icons.
  const tabIcons = { chat: 'chat', models: 'box', settings: 'sliders' };
  $$('#tabbar .tab').forEach(t => {
    t.querySelector('.tab-ic').innerHTML = icon(tabIcons[t.dataset.tab]);
    t.addEventListener('click', () => nav(t.dataset.tab));
  });

  if (!hasNative()) {
    const b = $('#bridge-banner');
    b.hidden = false;
    b.textContent = 'Web preview — models, voice and downloads activate in the Android APK.';
  }

  // Block Android long-press selection everywhere except message text/code.
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('.msg-text, pre, code, .transcript-text')) e.preventDefault();
  });

  initChat();
  initModels();
  initSettings();
  initLive();
  refreshStatus();
  autoRestore();
  nav('chat');
  console.log('%cVani AI v1.4.0', 'font-weight:bold', hasNative() ? '(Android bridge active)' : '(browser preview)');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
