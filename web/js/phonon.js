// Vani AI — Phonon Ultra-Light: built-in formant TTS (zero download, ~0 RAM).
// A compact Klatt-style synthesizer: rule-based grapheme→phoneme mapping,
// glottal saw source through three formant bandpasses, noise for fricatives.
// Deliberately robotic — the honest ultra-light fallback voice. Neural
// engines (Pocket TTS / Piper / Kokoro) run natively via sherpa-onnx.

const VOWELS = {
  //        F1    F2    F3   dur
  a:  [730, 1090, 2440, 0.16], e: [530, 1840, 2480, 0.14], i: [390, 1990, 2550, 0.13],
  o:  [570, 840, 2410, 0.15],  u: [440, 1020, 2240, 0.14], ah: [640, 1190, 2390, 0.12],
  ae: [660, 1720, 2410, 0.15], er: [490, 1350, 1690, 0.14], ai: [730, 1090, 2440, 0.2],
  ee: [270, 2290, 3010, 0.15], oo: [300, 870, 2240, 0.15],  oh: [570, 840, 2410, 0.18],
};
const VOICED = { m: [250, 1100, 2200], n: [250, 1700, 2600], l: [350, 1100, 2600], r: [350, 1300, 1600], w: [300, 700, 2200], y: [280, 2200, 3000], v: [300, 1100, 2200], z: [300, 1400, 2600], b: [250, 900, 2200], d: [250, 1700, 2600], g: [250, 1500, 2400] };
const FRIC = { s: [4500, 0.11], sh: [2800, 0.13], f: [3500, 0.1], th: [3000, 0.09], h: [1500, 0.07], ch: [2600, 0.12], j: [2400, 0.1] };
const STOPS = { p: 0.06, t: 0.06, k: 0.07 };

function g2p(word) {
  const w = word.toLowerCase().replace(/[^a-z']/g, '');
  const out = [];
  let i = 0;
  const digraphs = { sh: ['sh'], ch: ['ch'], th: ['th'], ee: ['ee'], oo: ['oo'], ai: ['ai'], ea: ['ee'], ou: ['oo'], ow: ['oh'], oa: ['oh'], ay: ['ai'], ey: ['ee'], oy: ['oh', 'i'], ng: ['n'], ph: ['f'], wh: ['w'], ck: ['k'], qu: ['k', 'w'] };
  while (i < w.length) {
    const two = w.slice(i, i + 2);
    if (digraphs[two]) { out.push(...digraphs[two]); i += 2; continue; }
    const c = w[i];
    if ('aeiou'.includes(c)) {
      const silentE = i + 1 < w.length && !'aeiou'.includes(w[i + 1]) && w[i + 2] === 'e' && i + 3 >= w.length;
      out.push({ a: 'ae', e: 'e', i: silentE ? 'ai' : 'i', o: silentE ? 'oh' : 'o', u: 'u' }[c]);
    } else if (c === 'c') out.push('k');
    else if (c === 'x') out.push('k', 's');
    else if (c === "'") { /* skip */ }
    else if (VOICED[c] || FRIC[c] || STOPS[c] !== undefined) out.push(c);
    i++;
  }
  if (w.endsWith('e') && out.length > 1 && 'aeiou'.includes(out[out.length - 1])) out.pop();
  return out;
}

export class Phonon {
  constructor() { this.ctx = null; this.nodes = []; this.raf = null; this.speaking = false; }

  speak(text, { rate = 1, onLevel, onEnd } = {}) {
    this.stop();
    const clean = String(text).replace(/```[\s\S]*?```/g, ' code block ').replace(/\$[^$]*\$/g, ' formula ').replace(/[*_#`>]/g, '').slice(0, 600);
    const words = clean.split(/\s+/).filter(Boolean);
    if (!words.length) { onEnd?.(); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain(); master.gain.value = 0.5;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    master.connect(analyser); analyser.connect(ctx.destination);
    this.nodes = [master, analyser];
    let t = ctx.currentTime + 0.05;
    const f0base = 205;
    let wordIdx = 0;
    for (const word of words) {
      const ph = g2p(word);
      const decl = 1 - (wordIdx / Math.max(1, words.length)) * 0.12;
      for (const p of ph) {
        if (VOWELS[p]) t = this.voice(t, ctx, master, VOWELS[p], f0base * decl, rate, true);
        else if (VOICED[p]) t = this.voice(t, ctx, master, [...VOICED[p], 0.07], f0base * decl, rate, false);
        else if (FRIC[p]) t = this.noise(t, ctx, master, FRIC[p][0], FRIC[p][1] / rate);
        else if (STOPS[p] !== undefined) { t += 0.03 / rate; t = this.noise(t, ctx, master, 2500, 0.03 / rate, 0.4); }
      }
      t += 0.075 / rate;
      wordIdx++;
    }
    this.speaking = true;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!this.speaking) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 4));
      if (ctx.currentTime > t + 0.1) { this.finish(onEnd); return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  voice(t, ctx, dest, [f1, f2, f3, dur], f0, rate, isVowel) {
    const d = dur / rate;
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * 1.03, t);
    osc.frequency.linearRampToValueAtTime(f0 * 0.97, t + d);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(isVowel ? 0.5 : 0.28, t + 0.02);
    env.gain.setValueAtTime(isVowel ? 0.5 : 0.28, t + d - 0.03);
    env.gain.linearRampToValueAtTime(0, t + d);
    [[f1, 1], [f2, 0.5], [f3, 0.22]].forEach(([f, g]) => {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 7;
      const fg = ctx.createGain(); fg.gain.value = g;
      osc.connect(bp); bp.connect(fg); fg.connect(env);
      this.nodes.push(bp, fg);
    });
    env.connect(dest);
    osc.start(t); osc.stop(t + d + 0.01);
    this.nodes.push(osc, env);
    return t + d;
  }

  noise(t, ctx, dest, freq, dur, gain = 0.22) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.2;
    const env = ctx.createGain(); env.gain.value = gain;
    src.connect(bp); bp.connect(env); env.connect(dest);
    src.start(t);
    this.nodes.push(src, bp, env);
    return t + dur;
  }

  finish(onEnd) {
    this.speaking = false;
    cancelAnimationFrame(this.raf);
    try { this.ctx?.close(); } catch {}
    this.ctx = null; this.nodes = [];
    onEnd?.();
  }

  stop() {
    if (this.ctx || this.speaking) this.finish(null);
  }
}
