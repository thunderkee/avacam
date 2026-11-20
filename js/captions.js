// Captions: the recorded voice → timed subtitle lines in the spoken language (Whisper in
// caption-worker.js), drawn onto the picture and exportable as .srt.

let worker = null;

/** Transcribe an AudioBuffer. Resolves { language, lines }. onStatus({ stage, value, language }). */
export async function extractCaptions(buffer, { language = '', onStatus = () => {} } = {}) {
  // Whisper listens at 16 kHz mono.
  const n = Math.ceil(buffer.duration * 16000);
  const off = new OfflineAudioContext(1, n, 16000);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start();
  const audio = (await off.startRendering()).getChannelData(0);

  worker ||= new Worker(new URL('./caption-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onerror = (e) => { worker = null; reject(new Error(e.message || 'Speech model failed to load')); };
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'progress') onStatus(m);
      else if (m.type === 'language') onStatus({ stage: 'language', language: m.language });
      else if (m.type === 'error') reject(new Error(m.message));
      else if (m.type === 'done') resolve({ language: m.language, lines: toLines(m.words) });
    };
    worker.postMessage({ audio, language }, [audio.buffer]);
  });
}

/** Words → short caption lines: a new line after a sentence ends, after a comma once the line has a
 *  few words, at a pause, or when one gets long. */
export function toLines(words) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const gap = cur ? w.start - cur.end : 0;
    const long = cur && (cur.text.length + text.length > 34 || w.end - cur.start > 3.5);
    if (!cur || cur.done || (cur.comma && cur.text.length >= 14) || gap > 0.6 || long) { cur = { text: '', start: w.start, end: w.end }; lines.push(cur); }
    // (scripts without spaces, like Chinese and Japanese, come as pieces that join directly)
    cur.text += (cur.text && /^[\p{L}\p{N}]/u.test(text) && !/[　-鿿]$/u.test(cur.text) ? ' ' : '') + text;
    cur.end = w.end;
    cur.done = /[.!?。！？]$/.test(text);
    cur.comma = /[,，、;:]$/.test(text);
  }
  return lines.map(({ text, start, end }) => ({ text, start, end }));
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
