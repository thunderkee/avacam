// Captions:
//  - after each take, the original (unedited) voice is written down on this device (Whisper, in a
//    background worker: nothing leaves the phone), English or Indonesian found by itself, with a time
//    for every word; the words become short lines;
//  - or the words are typed or pasted, and timed to the voice in the recording.
// Lines are drawn onto the picture and can be saved as .srt.

let worker = null;
/** The recorded voice → { language, lines }. onProgress(stage, value): 'download' (0–1, first time
 *  only) or 'listen'. Throws with a readable message if it can't. */
export async function transcribe(buffer, onProgress = () => {}) {
  const audio = await to16k(buffer);
  worker ||= new Worker(new URL('./caption-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'progress') onProgress(m.stage, m.value);
      else if (m.type === 'done') resolve({ language: m.language, lines: wordsToLines(m.words) });
      else if (m.type === 'error') { worker.terminate(); worker = null; reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker?.terminate(); worker = null; reject(new Error(e.message || "the speech model couldn't start")); };
    worker.postMessage({ audio }, [audio.buffer]);
  });
}

/** An AudioBuffer → 16 kHz mono samples (what Whisper listens to). */
async function to16k(buffer) {
  const sr = 16000, off = new OfflineAudioContext(1, Math.ceil(buffer.duration * sr), sr);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

/** Timed words → caption lines: break after a sentence, after a comma once a line has a few words,
 *  at a pause, and before a line gets long. */
export function wordsToLines(words) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    if (cur && ((cur.text + ' ' + w.word).length > 34 || w.start - cur.end > 0.7)) { lines.push(cur); cur = null; }
    if (cur) { cur.text += ' ' + w.word; cur.end = w.end; } else cur = { text: w.word, start: w.start, end: w.end };
    if (/[.!?]$/.test(w.word) || (/[,;:]$/.test(w.word) && cur.text.length >= 14)) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Text → short caption lines: break after a sentence, after a comma once a line has a few words,
 *  and before a line gets long. (Scripts without spaces, like Chinese or Japanese, break by length.) */
export function splitText(text) {
  const spaced = /\s/.test(text.trim());
  const parts = spaced ? text.trim().split(/\s+/) : [...text.trim()];
  const lines = [];
  let cur = '';
  for (const w of parts) {
    if (cur && (cur + w).length > (spaced ? 34 : 16)) { lines.push(cur); cur = ''; }
    cur += (cur && spaced ? ' ' : '') + w;
    if (/[.!?。！？]$/.test(w) || (/[,，、;:]$/.test(w) && cur.length >= 14)) { lines.push(cur); cur = ''; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Lines over [start, end], each given time in proportion to its length. */
function spread(lines, start, end) {
  const total = lines.reduce((a, l) => a + l.length, 0) || 1;
  let t = start;
  return lines.map((text) => { const d = ((end - start) * text.length) / total; const l = { text, start: t, end: t + d }; t += d; return l; });
}

/** Where the voice is in an AudioBuffer: [[start, end], …] in seconds. */
export function speechSpans(buffer) {
  const x = buffer.getChannelData(0), sr = buffer.sampleRate, hop = Math.round(sr * 0.02);
  const rms = [];
  for (let i = 0; i + hop <= x.length; i += hop) { let s = 0; for (let k = i; k < i + hop; k++) s += x[k] * x[k]; rms.push(Math.sqrt(s / hop)); }
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0, loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const th = Math.max(0.008, floor + (loud - floor) * 0.18);
  const spans = [];
  rms.forEach((v, i) => {
    if (v < th) return;
    const t = i * 0.02, last = spans.at(-1);
    if (last && t - last[1] < 0.35) last[1] = t + 0.02; else spans.push([t, t + 0.02]);
  });
  return spans.filter(([a, b]) => b - a > 0.12);
}

/** Typed words → lines timed to the voice: the lines are laid along the speaking time only (the
 *  pauses are skipped), each taking time in proportion to its length, and a line never spans a long
 *  pause if it can start after it. */
export function timeToVoice(buffer, text) {
  const lines = splitText(text);
  const spans = speechSpans(buffer);
  if (!lines.length) return [];
  if (!spans.length) return spread(lines, 0, buffer.duration);
  const talk = spans.reduce((a, [s, e]) => a + e - s, 0);
  // speaking-time position → recording time
  const at = (u) => {
    for (const [s, e] of spans) { if (u <= e - s + 1e-6) return s + u; u -= e - s; }
    return spans.at(-1)[1];
  };
  const total = lines.reduce((a, l) => a + l.length, 0);
  let u = 0;
  return lines.map((text) => {
    const d = (talk * text.length) / total;
    const l = { text, start: at(u + 1e-3), end: at(u + d) };
    u += d;
    return l;
  });
}

/** The line showing at time t (held a moment after it's said, until the next one starts). */
export function captionAt(lines, t) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], next = lines[i + 1];
    if (t >= l.start - 0.05 && t <= Math.min(l.end + 0.5, next ? next.start - 0.05 : Infinity)) return l.text;
  }
  return '';
}

/** Draw a caption in the lower part of the frame: white bold text on a dark rounded box, its
 *  bottom no lower than maxBottom. */
export function drawCaption(ctx, w, h, text, maxBottom = h) {
  if (!text) return;
  const size = Math.round(Math.min(w, h) * 0.058);
  ctx.save();
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // Wrap to 86% of the width (by word, or by character for scripts without spaces).
  const maxW = w * 0.86, rows = [];
  const parts = text.includes(' ') ? text.split(' ') : [...text];
  const sep = text.includes(' ') ? ' ' : '';
  let row = '';
  for (const p of parts) {
    const tryRow = row ? row + sep + p : p;
    if (row && ctx.measureText(tryRow).width > maxW) { rows.push(row); row = p; } else row = tryRow;
  }
  if (row) rows.push(row);
  const lh = size * 1.3, padX = size * 0.6, padY = size * 0.35;
  const boxW = Math.min(w * 0.94, Math.max(...rows.map((r) => ctx.measureText(r).width)) + padX * 2);
  const boxH = rows.length * lh + padY * 2;
  const cy = Math.min(h * 0.74, maxBottom - boxH / 2 - size * 0.4); // (the preview keeps it above the controls)
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.beginPath(); ctx.roundRect(w / 2 - boxW / 2, cy - boxH / 2, boxW, boxH, size * 0.4); ctx.fill();
  ctx.fillStyle = '#fff';
  rows.forEach((r, i) => ctx.fillText(r, w / 2, cy - boxH / 2 + padY + lh * (i + 0.5)));
  ctx.restore();
}

/** Lines → SubRip (.srt), times relative to `from` (the trim start). */
export function toSrt(lines, from = 0, to = Infinity) {
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (v, n = 2) => String(v).padStart(n, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  // (each held a moment after it's said, as on screen, until the next one starts)
  const shown = lines.map((l, i) => ({ ...l, end: Math.min(l.end + 0.5, lines[i + 1] ? lines[i + 1].start - 0.05 : Infinity, to) }));
  return shown.filter((l) => l.end > from && l.start < to)
    .map((l, i) => `${i + 1}\n${ts(l.start - from)} --> ${ts(l.end - from)}\n${l.text}\n`).join('\n');
}

/** "id" → "Indonesian". */
export const languageName = (code) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
};
