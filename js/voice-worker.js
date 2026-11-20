// Runs voice-fx's heavy loops off the main thread (see inWorker in voice-fx.js).
import { pitchShift, vibrato, encodeWav } from './voice-fx.js';

self.onmessage = ({ data: m }) => {
  if (m.op === 'pitch') {
    const out = pitchShift(m.x, m.sr, m.vibrato ? vibrato(m.base, m.vibrato) : m.base);
    self.postMessage({ id: m.id, result: out }, [out.buffer]);
  } else if (m.op === 'wav') {
    const bytes = encodeWav(m.chans, m.sr);
    self.postMessage({ id: m.id, result: bytes }, [bytes]);
  }
};
