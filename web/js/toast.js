// Vani AI — singleton toast banner (max 1 visible, 2.5s auto-dismiss).
import { $ } from './util.js';

let timer = null;
export function toast(msg, ms = 2500) {
  const t = $('#toast');
  if (!t) return;
  clearTimeout(timer);
  t.textContent = msg;
  t.hidden = false;
  timer = setTimeout(() => { t.hidden = true; }, ms);
}
