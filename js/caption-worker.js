// Speech to captions, on this device, off the main thread: Whisper (multilingual, tiny size, 8-bit)
// via transformers.js on WebAssembly. Nothing is sent anywhere; only the model itself is downloaded
// (about 40 MB, the first time; the browser keeps it). Finds whether the take is English or
// Indonesian, then writes it down with a time for every word.
import { pipeline, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

const MODEL = 'onnx-community/whisper-tiny_timestamped';
const LANGS = ['en', 'id'];
let asr = null;

const send = (m) => self.postMessage(m);

async function load() {
  if (asr) return asr;
  const files = {};
  asr = await pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'q8', device: 'wasm',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      send({ type: 'progress', stage: 'download', value: l / t });
    },
  });
  return asr;
}

/** English or Indonesian? Whisper's first guess after <|startoftranscript|>, between those two only. */
async function detectLanguage(audio) {
  const { model, processor } = asr;
  const { input_features } = await processor(audio.subarray(0, 16000 * 30));
  const g = model.generation_config;
  const out = await model({ input_features, decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(g.decoder_start_token_id)]), [1, 1]) });
  const logits = out.logits.data, V = out.logits.dims.at(-1), base = logits.length - V;
  const score = (l) => logits[base + g.lang_to_id[`<|${l}|>`]];
  return LANGS.reduce((a, b) => (score(b) > score(a) ? b : a));
}

async function words(audio, language) {
  const opts = { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 };
  try {
    const out = await asr(audio, { ...opts, return_timestamps: 'word' });
    return (out.chunks || []).map((c) => ({ word: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }));
  } catch {
    // (if word timing fails, phrase timing: each phrase's words share its time by length)
    const out = await asr(audio, { ...opts, return_timestamps: true });
    return (out.chunks || []).flatMap((c) => {
      const ws = c.text.trim().split(/\s+/).filter(Boolean), [s, e = s + 2] = c.timestamp;
      const total = ws.reduce((a, w) => a + w.length, 0) || 1;
      let t = s;
      return ws.map((w) => { const d = ((e - s) * w.length) / total; const r = { word: w, start: t, end: t + d }; t += d; return r; });
    });
  }
}

self.onmessage = async ({ data: m }) => {
  try {
    await load();
    send({ type: 'progress', stage: 'listen', value: 0 });
    const language = await detectLanguage(m.audio);
    send({ type: 'done', language, words: (await words(m.audio, language)).filter((w) => w.word) });
  } catch (e) {
    send({ type: 'error', message: String(e?.message || e) });
  }
};
