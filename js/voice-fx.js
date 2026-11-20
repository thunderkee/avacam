// Voice effects for Post: transform the recorded voice, keeping its timing so lip sync stays on.
//
// 1. Pitch: a two-tap granular pitch shifter (crossfaded delay taps) — changes pitch, not speed.
// 2. Character: a Web Audio chain rendered offline (ring mod, filters, drive, echo…).
// The result is a new AudioBuffer for playback and export; the original take is kept.

export const VOICE_PRESETS = [
  { id: 'none', label: 'Original', icon: '🎙️' },
  { id: 'chipmunk', label: 'Chipmunk', icon: '🐿️', pitch: 7 },
  { id: 'deep', label: 'Deep', icon: '🐻', pitch: -5 },
  { id: 'robot', label: 'Robot', icon: '🤖' },
  { id: 'alien', label: 'Alien', icon: '👽', pitch: 4, vibrato: true },
  { id: 'monster', label: 'Monster', icon: '👹', pitch: -9 },
  { id: 'radio', label: 'Radio', icon: '📻' },
  { id: 'echo', label: 'Echo', icon: '⛰️' },
];

let decodeCtx = null;
/** Recorded audio blob → AudioBuffer. */
export async function decode(blob) {
  decodeCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  return decodeCtx.decodeAudioData(await blob.arrayBuffer());
}

/** Mono mix of a buffer. */
function mono(buffer) {
  const n = buffer.length, out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}

/**
 * Pitch shift without changing duration. `ratio` is a frequency ratio, or a function of time (s)
 * for vibrato. Two read taps half a grain apart slide through a delay line; triangular windows
 * crossfade them so the wrap-around of each tap is silent.
 */
export function pitchShift(x, sr, ratio) {
  const grain = Math.round(sr * 0.045), half = grain / 2;
  const out = new Float32Array(x.length);
  const at = (pos) => {
    if (pos < 0) return 0;
    const i = Math.floor(pos), f = pos - i;
    return (x[i] || 0) * (1 - f) + (x[i + 1] || 0) * f;
  };
  let d = 0;
  for (let i = 0; i < x.length; i++) {
    const r = typeof ratio === 'function' ? ratio(i / sr) : ratio;
    d = (((d + 1 - r) % grain) + grain) % grain;
    const d2 = (d + half) % grain;
    const w1 = 1 - Math.abs(d - half) / half, w2 = 1 - w1;
    out[i] = at(i - d) * w1 + at(i - d2) * w2;
  }
  return out;
}

/** The Alien's wobble: `base` with a 6 Hz vibrato of ±0.6 semitones. */
export const vibrato = (base) => (t) => base * 2 ** ((Math.sin(t * 2 * Math.PI * 6) * 0.6) / 12);

// The heavy loops (pitch shift, WAV encoding) run in a worker, so the player and character keep
// moving while a voice is applied (on a phone they took about a second for a long take).
let worker = null, seq = 0;
const pending = new Map();
function inWorker(msg, transfer, fallback) {
  if (worker === false || typeof Worker === 'undefined') return Promise.resolve(fallback());
  try {
    worker ||= new Worker(new URL('./voice-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); p?.resolve(e.data.result); };
    worker.onerror = () => { worker = false; for (const p of pending.values()) p.resolve(p.fallback()); pending.clear(); };
  } catch { worker = false; return Promise.resolve(fallback()); }
  return new Promise((resolve) => { const id = ++seq; pending.set(id, { resolve, fallback }); worker.postMessage({ ...msg, id }, transfer); });
}

/** Soft-clip curve for drive. */
function driveCurve(amount) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * amount) / Math.tanh(amount); }
  return c;
}

/** The character chain for a preset, from `src` to `out`, in an OfflineAudioContext. */
function chain(ctx, preset, src, out) {
  const filter = (type, freq, q = 0.7, gain = 0) => {
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain; return f;
  };
  const shaper = (amount) => { const w = ctx.createWaveShaper(); w.curve = driveCurve(amount); w.oversample = '2x'; return w; };
  const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };

  switch (preset.id) {
    case 'robot': {
      // Ring modulation (the classic robot buzz) into a short metallic comb.
      const ring = gain(0);
      const osc = ctx.createOscillator(); osc.frequency.value = 55; osc.connect(ring.gain); osc.start();
      const comb = ctx.createDelay(0.05); comb.delayTime.value = 0.009;
      const fb = gain(0.55);
      src.connect(ring); ring.connect(comb); comb.connect(fb); fb.connect(comb);
      const hp = filter('highpass', 180);
      const mix = gain(1);
      ring.connect(mix); comb.connect(gain(0.6)).connect(mix);
      mix.connect(hp).connect(out);
      break;
    }
    case 'radio': {
      src.connect(filter('highpass', 450, 0.9)).connect(filter('lowpass', 3200, 0.9)).connect(filter('peaking', 1800, 1.2, 6)).connect(shaper(3)).connect(gain(0.8)).connect(out);
      break;
    }
    case 'echo': {
      const delay = ctx.createDelay(1); delay.delayTime.value = 0.26;
      const fb = gain(0.42), damp = filter('lowpass', 2800);
      src.connect(out);
      src.connect(delay); delay.connect(damp); damp.connect(fb); fb.connect(delay);
      damp.connect(gain(0.55)).connect(out);
      break;
    }
    case 'monster': {
      src.connect(filter('lowshelf', 200, 0.7, 6)).connect(shaper(4)).connect(filter('lowpass', 2600)).connect(gain(0.85)).connect(out);
      break;
    }
    case 'deep': {
      src.connect(filter('lowshelf', 220, 0.7, 4)).connect(out);
      break;
    }
    case 'chipmunk': case 'alien': {
      src.connect(filter('highshelf', 3000, 0.7, preset.id === 'alien' ? 3 : 2)).connect(out);
      break;
    }
    default: src.connect(out);
  }
}

/**
 * Apply a preset (plus extra semitones) to a recorded take → new AudioBuffer.
 * Returns the original buffer for "Original" with no pitch change.
 */
export async function applyVoice(buffer, { preset = 'none', semitones = 0 } = {}) {
  const p = VOICE_PRESETS.find((v) => v.id === preset) || VOICE_PRESETS[0];
  const semis = (p.pitch || 0) + semitones;
  if (p.id === 'none' && !semis) return buffer;
  const sr = buffer.sampleRate;
  let x = mono(buffer);
  if (semis || p.vibrato) {
    const base = 2 ** (semis / 12), src = x;
    x = await inWorker({ op: 'pitch', x: src.slice(), sr, base, vibrato: !!p.vibrato }, [],
      () => pitchShift(src, sr, p.vibrato ? vibrato(base) : base));
  }
  const tail = p.id === 'echo' ? Math.round(sr * 1.2) : 0;
  const ctx = new OfflineAudioContext(1, x.length + tail, sr);
  const inBuf = ctx.createBuffer(1, x.length, sr); inBuf.copyToChannel(x, 0);
  const src = ctx.createBufferSource(); src.buffer = inBuf;
  chain(ctx, p, src, ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  // Normalise to a safe peak so effects with gain don't clip.
  const d = out.getChannelData(0);
  let peak = 0; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0.95) { const k = 0.95 / peak; for (let i = 0; i < d.length; i++) d[i] *= k; }
  return out;
}

/** AudioBuffer → 16-bit PCM WAV blob (for the <audio> player), encoded in the worker. */
export async function toWav(buffer) {
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  const bytes = await inWorker({ op: 'wav', chans, sr: buffer.sampleRate }, chans.map((c) => c.buffer), () => encodeWav(chans, buffer.sampleRate));
  return new Blob([bytes], { type: 'audio/wav' });
}

/** Channel data → 16-bit PCM WAV bytes. */
export function encodeWav(chans, sr) {
  const ch = chans.length, n = chans[0].length;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return data.buffer;
}
