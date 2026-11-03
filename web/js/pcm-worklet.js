// Vani AI — AudioWorklet: 16 kHz mono Int16 PCM capture (100 ms chunks).
// Released immediately when Live Talk closes or the app backgrounds.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(1600);
    this.n = 0;
    this.alive = true;
    this.port.onmessage = e => { if (e.data === 'stop') this.alive = false; };
  }
  process(inputs) {
    if (!this.alive) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.chunk[this.n++] = ch[i];
        if (this.n === 1600) {
          const out = new Int16Array(1600);
          let peak = 0;
          for (let j = 0; j < 1600; j++) {
            const s = Math.max(-1, Math.min(1, this.chunk[j]));
            out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
            const a = Math.abs(s); if (a > peak) peak = a;
          }
          this.port.postMessage({ pcm: out.buffer, peak }, [out.buffer]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
