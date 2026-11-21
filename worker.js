// AvaCam's Worker: serves the app's files, and writes captions for a take.
// POST /api/captions with a 16 kHz mono WAV of the original (unedited) voice → { language, words: [{ word, start, end }] }.
// Speech is recognised by Whisper on Cloudflare Workers AI; the language is found by itself (English or
// Indonesian; a take heard as another language is written again in whichever of the two is closer).
const MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_BYTES = 6 * 1024 * 1024; // (about 3 minutes of 16 kHz WAV)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/api/captions') return env.ASSETS.fetch(req);
    if (req.method !== 'POST') return json({ error: 'POST a WAV' }, 405);
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_BYTES) return json({ error: 'The take is empty or too long to caption.' }, 413);
    const audio = base64(buf);
    try {
      let out = await env.AI.run(MODEL, { audio, vad_filter: true });
      let language = out.transcription_info?.language || 'en';
      if (language !== 'en' && language !== 'id') {
        // Indonesian is often heard as Malay (or Javanese, Sundanese); anything else is taken as English.
        language = ['ms', 'jw', 'su', 'tl'].includes(language) ? 'id' : 'en';
        out = await env.AI.run(MODEL, { audio, vad_filter: true, language });
      }
      const words = (out.segments || []).flatMap((s) => s.words?.length ? s.words : [{ word: s.text, start: s.start, end: s.end }])
        .map((w) => ({ word: String(w.word).trim(), start: +w.start, end: +w.end })).filter((w) => w.word);
      return json({ language, words });
    } catch (e) {
      return json({ error: String(e?.message || e) }, 502);
    }
  },
};

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
function base64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
