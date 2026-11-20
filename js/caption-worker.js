// Speech to captions, off the main thread: Whisper (multilingual, base size, 8-bit) via
// transformers.js. Detects the spoken language, then transcribes with timestamps.
// The model (about 75 MB) downloads the first time and is kept in the browser's cache.
import { pipeline, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

const MODEL = 'onnx-community/whisper-base_timestamped';
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

/** The language Whisper hears in the first 30 s: its first guess after <|startoftranscript|>. */
async function detectLanguage(audio) {
  const { model, processor } = asr;
  const { input_features } = await processor(audio.subarray(0, 16000 * 30));
  const g = model.generation_config;
  const sot = g.decoder_start_token_id;
  const out = await model({ input_features, decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]) });
  const logits = out.logits.data, V = out.logits.dims.at(-1), base = logits.length - V;
  let best = null, bestV = -Infinity;
  for (const [tok, id] of Object.entries(g.lang_to_id)) if (logits[base + id] > bestV) { bestV = logits[base + id]; best = tok; }
  return best.slice(2, -2); // "<|id|>" → "id"
}

self.onmessage = async ({ data: m }) => {
  try {
    await load();
    send({ type: 'progress', stage: 'listen', value: 0 });
    const language = m.language || await detectLanguage(m.audio);
    send({ type: 'language', language });
    // Word timings, so captions can be cut into short lines that change as each one is said.
    const out = await asr(m.audio, { language, task: 'transcribe', return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    const words = (out.chunks || []).map((c) => ({ text: c.text, start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }));
    send({ type: 'done', language, words });
  } catch (e) {
    send({ type: 'error', message: String(e?.message || e) });
  }
};
