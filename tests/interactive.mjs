// Vani AI — mandatory interactive runtime verification (real headless Chromium).
// Simulates the Android native bridge with NO model installed (the exact state
// of the user's fresh install) and clicks every control, asserting real state
// transitions — not DOM existence. Guards against the main-thread freeze that
// shipped in v1.0.0 (synchronous event self-recursion in nav / llm.status).
//
// Run: node tests/interactive.mjs   (needs: npm i --no-save playwright-core @sparticuz/chromium)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'android/app/src/main/assets/www');

/* ---------- ensure bundled Chromium + its shared libs are available ---------- */
async function launchBrowser() {
  const { default: chromium } = await import('@sparticuz/chromium');
  const { chromium: pw } = await import('playwright-core');
  const binDir = path.join(ROOT, 'node_modules/@sparticuz/chromium/bin');
  for (const name of ['al2023', 'swiftshader']) {
    const dest = `/tmp/${name}`;
    if (!fs.existsSync(dest)) {
      const br = path.join(binDir, `${name}.tar.br`);
      if (fs.existsSync(br)) {
        fs.writeFileSync(`/tmp/${name}.tar`, zlib.brotliDecompressSync(fs.readFileSync(br)));
        fs.mkdirSync(dest, { recursive: true });
        try { execSync(`tar -xf /tmp/${name}.tar -C ${dest}`); } catch {}
      }
    }
  }
  process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:/tmp/swiftshader:${process.env.LD_LIBRARY_PATH || ''}`;
  const executablePath = await chromium.executablePath();
  return pw.launch({
    executablePath,
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });
}

/* ---------------------------- static file server ---------------------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.vrm': 'application/octet-stream', '.wasm': 'application/wasm' };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(WWW, p);
      if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ----------------- native bridge mock (no model installed) ----------------- */
const MOCK = `
window.__vaniMock = { downloads: [], models: [], calls: [] };
window.__mockProgress = (id, received, total, speed, state) => {
  const d = window.__vaniMock.downloads.find(x => x.id === id);
  if (d) { d.received = received; d.total = total; d.speed = speed; d.state = state; }
  window.VaniBridge._emit('download.progress', { id, received, total, speed, state });
};
window.__mockInstall = (entry) => {
  window.__vaniMock.models = window.__vaniMock.models.filter(m => m.id !== entry.id);
  window.__vaniMock.models.push(entry);
  window.VaniBridge._emit('models.changed', {});
};
window.VaniNative = {
  invoke(method, argsJson, id) {
    const args = JSON.parse(argsJson || '{}');
    window.__vaniMock.calls.push(method);
    const M = window.__vaniMock;
    const ok = (payload) => setTimeout(() => window.VaniBridge._resolve(id, true, payload), 0);
    switch (method) {
      case 'device.info': ok({ ramTotalBytes: 8 * 1073741824, ramAvailBytes: Math.round(4.6 * 1073741824), cores: 8, gpuHint: 'Adreno 613' }); break;
      case 'llm.status': ok({ state: 'idle' }); break;
      case 'models.list': ok(M.models); break;
      case 'downloads.list': ok(M.downloads); break;
      case 'downloads.start': {
        const d = { id: args.id, modelId: args.modelId, quant: args.quant, name: args.name, kind: args.kind, received: 0, total: args.total, speed: 0, state: 'downloading' };
        M.downloads = M.downloads.filter(x => x.id !== d.id); M.downloads.push(d); ok(null); break;
      }
      case 'downloads.pause': { const d = M.downloads.find(x => x.id === args.id); if (d) d.state = 'paused'; ok(null); setTimeout(() => window.VaniBridge._emit('download.state', { id: args.id }), 0); break; }
      case 'downloads.resume': { const d = M.downloads.find(x => x.id === args.id); if (d) d.state = 'downloading'; ok(null); setTimeout(() => window.VaniBridge._emit('download.state', { id: args.id }), 0); break; }
      case 'downloads.cancel': { M.downloads = M.downloads.filter(x => x.id !== args.id); ok(null); setTimeout(() => window.VaniBridge._emit('download.state', { id: args.id }), 0); break; }
      case 'llm.load': ok({ state: 'ready', modelPath: '/models/mock.gguf', nCtx: 4096 }); break;
      case 'llm.unload': ok({ state: 'idle' }); break;
      case 'llm.generate': { ok(null); const toks = ['Hello', ' from', ' Vani', '!']; let i = 0; const t = setInterval(() => { if (i < toks.length) window.VaniBridge._emit('llm.token', { token: toks[i++] }); else { clearInterval(t); window.VaniBridge._emit('llm.done', {}); } }, 25); break; }
      case 'llm.stop': ok(null); break;
      case 'tts.configure': ok(null); break;
      case 'tts.speak': ok(null); setTimeout(() => window.VaniBridge._emit('tts.end', {}), 40); break;
      case 'tts.stop': case 'asr.start': case 'asr.stop': case 'asr.feed': case 'asr.pttRelease': ok(null); break;
      case 'models.delete': { M.models = M.models.filter(m => m.id !== args.id); ok(null); setTimeout(() => window.VaniBridge._emit('models.changed', {}), 0); break; }
      case 'models.import': ok(null); break;
      case 'models.lastActive': ok({ path: M.lastActive || '' }); break;
      case 'models.setLastActive': M.lastActive = args.path || ''; ok(null); break;
      case 'system.copy': case 'system.openExternal': case 'system.setBackState': case 'system.exit': ok(null); break;
      default: ok(null);
    }
  }
};
`;

/* --------------------------------- harness --------------------------------- */
let passed = 0, failed = 0;
const failures = [];
function check(cond, msg) { if (cond) { passed++; console.log('  PASS  ' + msg); } else { failed++; failures.push(msg); console.log('  FAIL  ' + msg); } }
async function step(name, fn) { console.log('\n== ' + name + ' =='); try { await fn(); } catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + ' threw: ' + e.message); } }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { srv, port } = await serve();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  page.setDefaultTimeout(6000);
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.addInitScript(MOCK);

  const responsive = async (label) => {
    const t0 = Date.now();
    const v = await page.evaluate(() => 6 * 7);
    return v === 42 && (Date.now() - t0) < 4000;
  };
  const activeScreen = () => page.evaluate(() => document.querySelector('.screen.active')?.id || null);

  try {
    await step('Boot (no model installed) — no freeze, no recursion', async () => {
      const t0 = Date.now();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('#screen-chat.active'), null, { timeout: 8000 });
      const bootMs = Date.now() - t0;
      check(await responsive(), 'main thread responsive after boot');
      check(bootMs < 4000, `boot completed in ${bootMs}ms (<4000)`);
      check(await activeScreen() === 'screen-chat', 'Chat screen active on launch');
      const empty = await page.evaluate(() => !!document.querySelector('#empty-browse'));
      check(empty, 'zero-model guard: empty state + Browse Model Hub shown');
      const recursion = [...pageErrors, ...consoleErrors].filter(e => /call stack|runaway|too much recursion/i.test(e));
      check(recursion.length === 0, 'no stack-overflow / runaway-recursion errors (' + recursion.length + ')');
    });

    await step('Native llm.status event does not recurse (regression)', async () => {
      await page.evaluate(() => window.VaniBridge._emit('llm.status', { state: 'idle' }));
      await page.evaluate(() => window.VaniBridge._emit('llm.status', { state: 'idle' }));
      check(await responsive(), 'responsive after native llm.status events');
      const recursion = [...pageErrors, ...consoleErrors].filter(e => /call stack|runaway/i.test(e));
      check(recursion.length === 0, 'no recursion from llm.status');
    });

    await step('Nav stress: Chat→Models→Settings→Models→Chat ×10, each <16ms', async () => {
      const seq = ['models', 'settings', 'models', 'chat'];
      // warmup
      await page.click('#tabbar .tab[data-tab="models"]'); await sleep(120);
      await page.click('#tabbar .tab[data-tab="chat"]'); await sleep(120);
      let worst = 0;
      for (let cycle = 0; cycle < 10; cycle++) {
        for (const tab of seq) {
          const ms = await page.evaluate(t => { const a = performance.now(); document.querySelector(`#tabbar .tab[data-tab="${t}"]`).click(); return performance.now() - a; }, tab);
          worst = Math.max(worst, ms);
          const active = await activeScreen();
          if (active !== 'screen-' + tab) throw new Error(`cycle ${cycle}: expected screen-${tab}, got ${active}`);
          if (!(await responsive())) throw new Error(`cycle ${cycle}: frozen after switching to ${tab}`);
          await sleep(40);
        }
      }
      check(worst < 16, `worst synchronous tab switch ${worst.toFixed(2)}ms (<16ms), 40 switches all responsive`);
      const recursion = [...pageErrors, ...consoleErrors].filter(e => /call stack|runaway/i.test(e));
      check(recursion.length === 0, 'no recursion during 40 nav switches');
    });

    await step('Live Talk opens with NO model, /anime commands, red X closes', async () => {
      await page.click('#tabbar .tab[data-tab="chat"]'); await sleep(100);
      await page.click('#btn-live');
      await page.waitForFunction(() => !document.querySelector('#live-root').hidden, null, { timeout: 5000 });
      check(await page.evaluate(() => !document.querySelector('#live-root').hidden), 'Live Talk full-screen overlay opened (no LLM required)');
      check(await page.evaluate(() => !!document.querySelector('#live-stage')), 'avatar stage mounted');
      check(await page.evaluate(() => !!document.querySelector('#live-close')), 'red X close button present');
      await sleep(400); // let walk-in / fallback settle
      check(await responsive(), 'responsive while Live open');
      // open command sheet and fire all 12 /anime actions
      await page.click('#live-cmds');
      await page.waitForFunction(() => !document.querySelector('#sheet-root').hidden, null, { timeout: 4000 });
      const actions = await page.evaluate(() => [...document.querySelectorAll('#sheet-root .anime-grid button')].map(b => b.dataset.a));
      check(actions.length === 12, `command sheet lists 12 /anime actions (got ${actions.length})`);
      await page.evaluate(() => window.VaniBridge._emit('sheet.close', {}));
      await page.waitForFunction(() => document.querySelector('#sheet-root').hidden, null, { timeout: 3000 });
      for (const a of actions) {
        await page.click('#live-cmds');
        await page.waitForFunction(() => !document.querySelector('#sheet-root').hidden, null, { timeout: 3000 });
        await page.click(`#sheet-root .anime-grid button[data-a="${a}"]`);
        await page.waitForFunction(() => document.querySelector('#sheet-root').hidden, null, { timeout: 3000 });
        if (!(await responsive())) throw new Error('froze on /anime ' + a);
      }
      check(true, 'all 12 /anime commands dispatched + sheet auto-closed without freezing');
      // close via red X
      await page.click('#live-close');
      await page.waitForFunction(() => document.querySelector('#live-root').hidden, null, { timeout: 4000 });
      check(await page.evaluate(() => document.querySelector('#live-root').hidden), 'red X closed Live overlay');
      check(await page.evaluate(() => document.querySelector('#live-root').innerHTML.trim() === ''), 'Live overlay fully unmounted');
      check(await activeScreen() === 'screen-chat', 'returned to Chat after Live close');
      check(await responsive(), 'responsive after Live close');
    });

    await step('Models hub: 6 main cards, filters, quant picker, download progress', async () => {
      await page.click('#tabbar .tab[data-tab="models"]');
      await page.waitForFunction(() => document.querySelectorAll('#screen-models .model-card').length >= 6, null, { timeout: 5000 });
      const mainCount = await page.evaluate(() => document.querySelectorAll('#screen-models .model-card').length);
      check(mainCount >= 6, `main hub renders ${mainCount} model cards (>=6)`);
      // filter pills
      for (const f of ['omni', 'vision', 'text', 'all']) {
        const pill = await page.$(`#hub-pills .pill[data-cat="${f}"]`);
        if (pill) { await page.click(`#hub-pills .pill[data-cat="${f}"]`); await sleep(80); check(await responsive(), `filter pill '${f}' responsive`); }
      }
      // quant picker on LFM3-Omni
      await page.click('#hub-pills .pill[data-cat="all"]').catch(() => {});
      await sleep(80);
      await page.click('[data-quant-btn="lfm3-omni-2b"]');
      await page.waitForFunction(() => !!document.querySelector('.quant-menu'), null, { timeout: 3000 });
      const opts = await page.evaluate(() => [...document.querySelectorAll('.quant-menu .quant-option')].map(o => o.dataset.q));
      check(opts.includes('Q4_K_M') && opts.length >= 3, `quant menu opens with options ${opts.join(',')}`);
      await page.click('.quant-menu .quant-option[data-q="Q4_K_M"]'); await sleep(100);
      check(await page.evaluate(() => !document.querySelector('.quant-menu')), 'quant menu closed after selection');
      // vision/audio projector checkbox toggles
      const mm = await page.$('[data-mmproj="lfm3-omni-2b"]');
      if (mm) { await page.click('[data-mmproj="lfm3-omni-2b"]'); await sleep(40); check(await responsive(), 'projector checkbox toggles'); }
      // start a download on LFM3-Omni and drive progress
      const dlBtn = await page.$('[data-action-slot="lfm3-omni-2b:Q4_K_M"] .btn-primary');
      check(!!dlBtn, 'LFM3-Omni shows a plain Download button (no upgrade gate)');
      if (dlBtn) {
        await page.click('[data-action-slot="lfm3-omni-2b:Q4_K_M"] .btn-primary');
        await page.waitForFunction(() => !!document.querySelector('[data-dl-id="lfm3-omni-2b:Q4_K_M"]'), null, { timeout: 4000 });
        check(true, 'Download click streams a progress card');
        const total = 1099630080;
        await page.evaluate(t => window.__mockProgress('lfm3-omni-2b:Q4_K_M', Math.round(t * 0.42), t, 5242880, 'downloading'), total);
        await sleep(80);
        const pct = await page.evaluate(() => document.querySelector('[data-dl-id="lfm3-omni-2b:Q4_K_M"] [data-dl-pct]').textContent);
        const mb = await page.evaluate(() => document.querySelector('[data-dl-id="lfm3-omni-2b:Q4_K_M"] [data-dl-mb]').textContent);
        const speed = await page.evaluate(() => document.querySelector('[data-dl-id="lfm3-omni-2b:Q4_K_M"] [data-dl-speed]').textContent);
        check(pct.trim() === '42%', `progress percent updates (${pct})`);
        check(/MB/.test(mb) && /MB\/s|KB\/s/.test(speed), `progress shows MB (${mb}) and speed (${speed})`);
        check(await page.evaluate(() => !!document.querySelector('[data-dl-id="lfm3-omni-2b:Q4_K_M"] [data-act="pause"]')), 'Pause button present');
        // pause
        await page.click('[data-dl-id="lfm3-omni-2b:Q4_K_M"] [data-act="pause"]'); await sleep(150);
        check(await page.evaluate(() => { const r = document.querySelector('[data-dl-id="lfm3-omni-2b:Q4_K_M"] [data-act="resume"]'); return r && !r.hidden; }), 'Pause → Resume button shown');
        // cancel via confirm modal
        await page.click('[data-dl-id="lfm3-omni-2b:Q4_K_M"] [data-act="cancel"]');
        await page.waitForFunction(() => !document.querySelector('#modal-root').hidden, null, { timeout: 3000 });
        const confirmBtn = await page.$('#modal-root .btn-danger');
        if (confirmBtn) { await page.click('#modal-root .btn-danger'); await sleep(200); }
        check(await page.evaluate(() => !document.querySelector('[data-dl-id="lfm3-omni-2b:Q4_K_M"]')), 'Cancel removes progress card');
      }
      // supplementary segment
      const suppTab = await page.$('#hub-seg button[data-tab="supp"]');
      if (suppTab) {
        await page.click('#hub-seg button[data-tab="supp"]'); await page.waitForFunction(() => document.querySelectorAll('#screen-models .model-card').length >= 5, null, { timeout: 4000 });
        const suppCount = await page.evaluate(() => document.querySelectorAll('#screen-models .model-card').length);
        check(suppCount >= 5, `supplementary segment renders ${suppCount} cards (>=5)`);
      }
      // scrollable
      const scrollable = await page.evaluate(() => { const n = document.querySelector('#models-scroll'); return n && n.scrollHeight > n.clientHeight; });
      check(scrollable, 'Models screen is vertically scrollable');
    });

    await step('Settings: opens, scrollable, pickers + sliders + toggles + Prompt Studio', async () => {
      await page.click('#tabbar .tab[data-tab="settings"]');
      await page.waitForFunction(() => document.querySelector('#screen-settings.active') && document.querySelectorAll('#settings-scroll .settings-row, #settings-scroll .slider-row').length > 5, null, { timeout: 5000 });
      await sleep(250); // let async renderSettings settle
      check(await activeScreen() === 'screen-settings', 'Settings screen active');
      const scrollable = await page.evaluate(() => { const n = document.querySelector('#settings-scroll'); return n && n.scrollHeight > n.clientHeight; });
      check(scrollable, 'Settings screen is vertically scrollable');
      // n_ctx picker (512–32768)
      await page.click('#sec-inference .value-pill');
      await page.waitForFunction(() => !document.querySelector('#sheet-root').hidden, null, { timeout: 3000 });
      const ctxOpts = await page.evaluate(() => [...document.querySelectorAll('#sheet-root .picker-option')].map(o => o.textContent));
      check(ctxOpts.some(t => /512/.test(t)) && ctxOpts.some(t => /32768/.test(t)), 'n_ctx picker spans 512–32768');
      await page.evaluate(() => { const b = [...document.querySelectorAll('#sheet-root .picker-option')].find(x => /8192/.test(x.textContent)); b && b.click(); });
      await page.waitForFunction(() => document.querySelector('#sheet-root').hidden, null, { timeout: 3000 });
      await sleep(250); // renderSettings rebuild after pick
      // threads picker (1–8)
      await page.locator('#sec-inference .value-pill').nth(1).click();
      await page.waitForFunction(() => !document.querySelector('#sheet-root').hidden, null, { timeout: 3000 });
      const threadOpts = await page.evaluate(() => [...document.querySelectorAll('#sheet-root .picker-option')].map(o => o.textContent));
      check(threadOpts.some(t => /1 thread/.test(t)) && threadOpts.some(t => /8 threads/.test(t)), 'threads picker spans 1–8');
      await page.evaluate(() => window.VaniBridge._emit('sheet.close', {}));
      await page.waitForFunction(() => document.querySelector('#sheet-root').hidden, null, { timeout: 3000 });
      await sleep(150);
      // Battery Saver toggle (no re-render side effects)
      const before = await page.isChecked('#sec-battery .switch input');
      await page.click('#sec-battery .switch'); await sleep(80);
      const after = await page.isChecked('#sec-battery .switch input');
      check(before !== after, 'settings toggle flips state');
      // Temperature slider
      await page.fill('#sec-inference input[type="range"]', '1.2');
      await page.dispatchEvent('#sec-inference input[type="range"]', 'change'); await sleep(80);
      check(await responsive(), 'settings slider adjusts without freeze');
      // Prompt Studio opens
      await page.click('#sec-persona button'); await sleep(200);
      const opened = await page.evaluate(() => !document.querySelector('#modal-root').hidden || !document.querySelector('#sheet-root').hidden);
      check(opened, 'Prompt Studio opens from Settings');
      await page.evaluate(() => { window.VaniBridge._emit('modal.close', {}); window.VaniBridge._emit('sheet.close', {}); });
      await sleep(150);
      check(await responsive(), 'Settings fully responsive');
    });

    await step('Header: menu / Prompt Studio / New Chat open on first tap', async () => {
      await page.click('#tabbar .tab[data-tab="chat"]'); await sleep(100);
      await page.click('#btn-menu'); await sleep(200);
      check(await page.evaluate(() => !document.querySelector('#drawer').hidden), 'hamburger opens history drawer on first tap');
      await page.click('#drawer-scrim', { position: { x: 395, y: 300 } }); await sleep(300);
      await page.click('#btn-prompt-studio'); await sleep(200);
      check(await page.evaluate(() => !document.querySelector('#modal-root').hidden || !document.querySelector('#sheet-root').hidden), 'sparkles opens Prompt Studio on first tap');
      await page.evaluate(() => { const m = document.querySelector('#modal-root'); const s = document.querySelector('#sheet-root'); if (m) m.hidden = true; if (s) s.hidden = true; });
      await page.click('#btn-new-chat-top'); await sleep(150);
      check(await responsive(), 'New Chat responds on first tap');
    });

    await step('v1.2.0: Live singleton re-open (no black screen) + /anime keeps chat clean', async () => {
      await page.click('#tabbar .tab[data-tab="chat"]'); await sleep(120);
      await page.click('#btn-live');
      await page.waitForFunction(() => !document.querySelector('#live-root').hidden, null, { timeout: 5000 });
      await sleep(300);
      // fire an action from the sheet (must NOT write a chat bubble)
      await page.click('#live-cmds');
      await page.waitForFunction(() => !document.querySelector('#sheet-root').hidden, null, { timeout: 4000 });
      await page.click('#sheet-root .anime-grid button[data-a="wave"]');
      await page.waitForFunction(() => document.querySelector('#sheet-root').hidden, null, { timeout: 3000 });
      // close then RE-OPEN: the persistent singleton must remount, not go black
      await page.click('#live-close');
      await page.waitForFunction(() => document.querySelector('#live-root').hidden, null, { timeout: 4000 });
      await page.click('#btn-live');
      await page.waitForFunction(() => !document.querySelector('#live-root').hidden, null, { timeout: 5000 });
      await sleep(300);
      check(await page.evaluate(() => !!document.querySelector('#live-stage')), 'Live re-opened with stage mounted (singleton remount)');
      check(await page.evaluate(() => !!document.querySelector('#live-stage canvas')), 'WebGL canvas re-attached on second open (no context loss / black screen)');
      check(await responsive(), 'responsive after Live re-open');
      await page.click('#live-close');
      await page.waitForFunction(() => document.querySelector('#live-root').hidden, null, { timeout: 4000 });
      const animeBubbles = await page.evaluate(() => [...document.querySelectorAll('#chat-list .msg')].filter(n => /\/anime/.test(n.textContent)).length);
      check(animeBubbles === 0, `tapping /anime sheet wrote NO chat bubbles (${animeBubbles})`);
    });

    await step('v1.2.0: persistence — Installed section, 4-voice picker, 7 ASR, add-by-URL', async () => {
      await page.click('#tabbar .tab[data-tab="models"]');
      await page.waitForFunction(() => document.querySelector('#screen-models.active'), null, { timeout: 4000 });
      await page.evaluate(() => {
        window.__mockInstall({ id: 'inst-llm', modelId: 'lfm25-350m', name: 'LFM2.5-350M (Q4_K_M)', kind: 'llm', quant: 'Q4_K_M', path: '/models/lfm25.gguf', dir: false, sizeBytes: 229312224, engine: 'llm' });
        window.__mockInstall({ id: 'inst-phonon', modelId: 'phonon', name: 'Phonon Voice Pack (INT8)', kind: 'tts', quant: 'INT8', path: '/models/phonon', dir: true, sizeBytes: 23366127, engine: 'vits' });
        window.__mockInstall({ id: 'inst-whisper', modelId: 'whisper-tiny', name: 'Whisper Tiny (INT8)', kind: 'asr', quant: 'INT8', path: '/models/whisper-tiny', dir: true, sizeBytes: 103609903, engine: 'whisper' });
      });
      await page.waitForFunction(() => !!document.querySelector('.installed-section'), null, { timeout: 4000 });
      const instRows = await page.evaluate(() => document.querySelectorAll('.installed-section .installed-row').length);
      check(instRows >= 3, `Downloaded/Installed section lists ${instRows} installed models (>=3)`);
      check(await page.evaluate(() => /Downloaded \/ Installed/.test(document.querySelector('.installed-section').textContent)), 'section titled "Downloaded / Installed"');
      await page.click('#hub-seg button[data-tab="main"]'); await sleep(150);
      check(await page.evaluate(() => !!document.querySelector('[data-model="lfm25-350m"]') && !!document.querySelector('[data-model="lfm25-12b"]')), 'LFM2.5-350M + 1.2B first-class main cards present');
      check(await page.evaluate(() => { const r = [...document.querySelectorAll('.installed-row')].find(x => /LFM2\.5/.test(x.textContent)); return r && /Use|Active/.test(r.textContent); }), 'installed LLM row exposes Use/Active');
      // supplementary segment
      await page.click('#hub-seg button[data-tab="supp"]');
      await page.waitForFunction(() => document.querySelectorAll('#screen-models .model-card').length >= 11, null, { timeout: 4000 });
      const suppCount = await page.evaluate(() => document.querySelectorAll('#screen-models .model-card').length);
      check(suppCount >= 11, `supplementary renders ${suppCount} engine cards (>=11)`);
      await page.waitForFunction(() => !!document.querySelector('[data-voice-sel="phonon"]'), null, { timeout: 4000 });
      const voiceOpts = await page.evaluate(() => [...document.querySelectorAll('[data-voice-sel="phonon"] option')].map(o => o.value));
      check(voiceOpts.length === 4, `Phonon card has a 4-voice selector (${voiceOpts.join(',')})`);
      check(await page.evaluate(() => !!document.querySelector('[data-voice-preview="phonon"]')), 'Phonon card has Preview Voice');
      await page.selectOption('[data-voice-sel="phonon"]', '92'); await sleep(100);
      const sid = await page.evaluate(() => JSON.parse(localStorage.getItem('vani.v1.settings')).ttsSid);
      check(sid === 92, 'choosing a voice persists ttsSid=92 (Orion/Aarav)');
      await page.click('[data-voice-preview="phonon"]'); await sleep(150);
      check(await responsive(), 'Preview Voice click is responsive');
      const titles = await page.evaluate(() => [...document.querySelectorAll('#screen-models .model-card .model-title')].map(n => n.textContent));
      for (const want of ['Whisper Tiny', 'Whisper Base', 'Whisper Small', 'Moonshine Tiny', 'Moonshine Base', 'SenseVoice', 'Zipformer']) {
        check(titles.some(t => t.includes(want)), `ASR engine present: ${want}`);
      }
      // add-by-URL/repo dialog opens with its own fields (no id collision)
      await page.click('#supp-url');
      await page.waitForFunction(() => !document.querySelector('#modal-root').hidden && !!document.querySelector('#supp-add-url'), null, { timeout: 3000 });
      check(await page.evaluate(() => !!document.querySelector('#supp-add-cat') && !!document.querySelector('#supp-add-engine')), 'Add TTS/ASR dialog has type + engine fields');
      await page.evaluate(() => window.VaniBridge._emit('modal.close', {}));
      await page.waitForFunction(() => document.querySelector('#modal-root').hidden, null, { timeout: 3000 });
      check(await responsive(), 'Models hub responsive after persistence checks');
    });

    await step('Final integrity', async () => {
      const recursion = [...pageErrors, ...consoleErrors].filter(e => /call stack|runaway|too much recursion/i.test(e));
      check(recursion.length === 0, 'zero recursion/stack-overflow errors across entire session');
      check(await responsive(), 'main thread responsive at end of session');
      if (pageErrors.length) console.log('  (non-fatal page errors: ' + pageErrors.slice(0, 5).join(' | ') + ')');
    });
  } finally {
    await browser.close();
    srv.close();
  }

  console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
  if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('ALL INTERACTIVE CHECKS PASSED');
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
