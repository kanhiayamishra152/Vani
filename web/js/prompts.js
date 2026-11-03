// Vani AI — System Prompt Studio: create / edit / save / switch personas.
import { $, $$, el, esc, uid } from './util.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { emitLocal } from './bridge.js';
import * as store from './store.js';

export function openPromptStudio() {
  emitLocal('modal.open', {
    title: 'System Prompt Studio',
    wide: true,
    body: `<div id="prompt-studio"></div>`,
    actions: [{ label: 'Done', primary: true }],
    onMount: root => renderList(root.querySelector('#prompt-studio')),
  });
}

function renderList(root) {
  root.innerHTML = `
    <p class="muted small" style="margin-bottom:12px">The active prompt controls the AI's persona and behavior in Chat and Live Talk.</p>
    ${store.prompts.map(p => `
      <div class="prompt-list-item${p.id === store.activePromptId ? ' active' : ''}" data-id="${p.id}">
        <span class="p-name">${esc(p.name)}</span>
        ${p.builtin ? '<span class="p-tag">Preset</span>' : '<span class="p-tag">Custom</span>'}
        <button class="icon-btn" data-edit="${p.id}" style="width:34px;height:34px">${icon('edit')}</button>
        ${p.builtin ? '' : `<button class="icon-btn danger" data-del="${p.id}" style="width:34px;height:34px">${icon('trash')}</button>`}
      </div>`).join('')}
    <button class="btn-secondary btn-block mt8" id="prompt-new">${icon('plus')}<span>New Custom Prompt</span></button>`;

  $$('.prompt-list-item', root).forEach(n => n.addEventListener('click', e => {
    if (e.target.closest('[data-edit],[data-del]')) return;
    store.setActivePrompt(n.dataset.id);
    toast('Active: ' + store.prompts.find(p => p.id === n.dataset.id).name);
    renderList(root);
  }));
  $$('[data-edit]', root).forEach(n => n.addEventListener('click', () => {
    const p = store.prompts.find(x => x.id === n.dataset.edit);
    renderEditor(root, p.builtin ? { ...p, id: uid(), name: p.name + ' (custom)', builtin: false } : p);
  }));
  $$('[data-del]', root).forEach(n => n.addEventListener('click', () => {
    store.deletePrompt(n.dataset.del);
    toast('Prompt deleted');
    renderList(root);
  }));
  root.querySelector('#prompt-new').addEventListener('click', () => renderEditor(root, { id: uid(), name: '', text: '', builtin: false }));
}

function renderEditor(root, p) {
  root.innerHTML = `
    <div class="field"><label>Name</label><input type="text" id="p-name" maxlength="60" value="${esc(p.name)}" placeholder="e.g. Study Buddy"></div>
    <div class="field"><label>System prompt</label><textarea id="p-text" placeholder="You are…">${esc(p.text)}</textarea></div>
    <div style="display:flex;gap:10px">
      <button class="btn-secondary" id="p-back" style="flex:1">${icon('chevronLeft')}<span>Back</span></button>
      <button class="btn-primary" id="p-save" style="flex:1">${icon('check')}<span>Save Prompt</span></button>
    </div>`;
  root.querySelector('#p-back').addEventListener('click', () => renderList(root));
  root.querySelector('#p-save').addEventListener('click', () => {
    const name = root.querySelector('#p-name').value.trim();
    const text = root.querySelector('#p-text').value.trim();
    if (!name || !text) { toast('Name and prompt are required'); return; }
    store.savePrompt({ ...p, name, text });
    store.setActivePrompt(p.id);
    toast('Prompt saved & activated');
    renderList(root);
  });
}
