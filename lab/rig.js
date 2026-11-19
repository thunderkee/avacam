// The character rig: blocks tagged with a role ("Moves as") are driven by a pose.
// A pose is the same plain-numbers object Avatar Cam's poseAt() returns (js/performance.js),
// so a character made here can later be driven by the camera exactly like Puff, Neko and Bolt:
//   yaw / pitch / roll (degrees), blinkL / blinkR 0..1, gazeX / gazeY -1..1, browL / browR,
//   browTiltL / browTiltR, viseme, jaw, smile / laugh / frown, breath,
//   and optionally headX / headY / headScale / bodyRoll / bodyX / bodyY.
// L parts sit at -x, like the toys' first eye (toys3d.js), so blinkL drives the same eye.

const D2R = Math.PI / 180;

/** what each role does, in the order the Rig tab lists them */
export const ROLES = [
  { key: 'head', label: 'HEAD', sub: 'Turns, nods and tilts with the head. Put everything on the face inside it.' },
  { key: 'body', label: 'BODY', sub: 'Shoulders: sways, leans and breathes, and turns a quarter of the head turn.' },
  { key: 'eyeL', label: 'EYE L', sub: 'Closes on blinkL (squashes flat), follows the gaze.' },
  { key: 'eyeR', label: 'EYE R', sub: 'Closes on blinkR, follows the gaze.' },
  { key: 'lidL', label: 'LID L', sub: 'Optional eyelid: slides down over the left eye on a blink.' },
  { key: 'lidR', label: 'LID R', sub: 'Optional eyelid for the right eye.' },
  { key: 'browL', label: 'BROW L', sub: 'Lifts with browL; its inner end drops on a frown.' },
  { key: 'browR', label: 'BROW R', sub: 'Lifts with browR; its inner end drops on a frown.' },
  { key: 'mouth', label: 'MOUTH', sub: 'The lip line: a smile widens and curves it up, a frown flips it down. Model it as a smile.' },
  { key: 'jaw', label: 'MOUTH OPEN', sub: 'The open mouth: grows with talking (visemes) and laughs, hidden when closed. Model it fully open.' },
  { key: 'cheekL', label: 'CHEEK L', sub: 'Rises and puffs a little with a smile.' },
  { key: 'cheekR', label: 'CHEEK R', sub: 'Rises and puffs a little with a smile.' },
];
export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));
/** a copy mirrored to the other side takes the other side's role */
export const MIRROR_ROLE = { eyeL: 'eyeR', eyeR: 'eyeL', lidL: 'lidR', lidR: 'lidL', browL: 'browR', browR: 'browL', cheekL: 'cheekR', cheekR: 'cheekL' };

// Mouth opening per viseme: width, height (1 = the MOUTH OPEN block as modelled). Same table as toys3d.js.
const MOUTH = { REST: [0.85, 0], MBP: [0.75, 0], FV: [0.85, 0.07], I: [1.1, 0.16], E: [1.15, 0.3], U: [0.55, 0.28], O: [0.7, 0.5], A: [1, 0.62] };

export const NEUTRAL = {
  yaw: 0, pitch: 0, roll: 0, blinkL: 0, blinkR: 0, gazeX: 0, gazeY: 0, browL: 0, browR: 0, browTiltL: 0, browTiltR: 0,
  viseme: 'REST', jaw: 1, smile: 0, laugh: 0, frown: 0, breath: 0, headX: 0, headY: 0, headScale: 1, bodyRoll: 0, bodyX: 0, bodyY: 0,
};

const reset = (o) => {
  const r = o.userData.rest;
  if (!r) return;
  o.position.copy(r.p);
  o.rotation.copy(r.r);
  o.scale.copy(r.s);
  o.visible = true;
};

/** put every rigged part back where the design has it */
export function restPose(model) {
  model.root.position.set(0, 0, 0);
  model.root.scale.setScalar(1);
  for (const o of Object.values(model.parts)) reset(o);
}

/**
 * Pose the model. `state` keeps the mouth's smoothed size between frames (like poseMouth in toys3d.js).
 * Head and body follow ToyStage.render's mapping, in this lab's metres (the toys are ~5x bigger).
 */
export function applyPose(model, p, t, state) {
  const P = model.parts;
  restPose(model);
  const soft = (v, m) => m * Math.tanh(v / m);
  // Blurb's tracks are in artwork px (400-wide canvas); the toys use 0.006 units per px at ~5x this size
  const PX = 0.0012;
  model.root.position.x = (p.bodyX || 0) * PX;
  model.root.position.y = Math.sin(t * 0.7) * 0.004 - (p.bodyY || 0) * PX;
  model.root.scale.setScalar(p.headScale || 1);
  if (P.head) {
    P.head.rotation.x += soft(p.pitch, 30) * D2R * 0.9;
    P.head.rotation.y += soft(p.yaw, 50) * D2R;
    P.head.rotation.z += -p.roll * D2R;
    P.head.position.x += ((p.headX || 0) - (p.bodyX || 0)) * PX;
    P.head.position.y -= ((p.headY || 0) - (p.bodyY || 0)) * PX;
  }
  if (P.body) {
    P.body.rotation.y += soft(p.yaw, 50) * D2R * 0.25;
    P.body.rotation.z += -(p.bodyRoll || 0) * D2R;
    P.body.scale.multiplyScalar(1 + (-p.breath / 1.6) * 0.015);
  }
  for (const [eye, lid, blink] of [[P.eyeL, P.lidL, p.blinkL], [P.eyeR, P.lidR, p.blinkR]]) {
    if (eye) {
      // with a lid the eye stays round and the lid closes over it; without one the eye squashes shut
      if (!lid) eye.scale.y *= Math.max(0.08, 1 - blink);
      eye.position.x += p.gazeX * 0.006;
      eye.position.y -= p.gazeY * 0.004;
    }
    if (lid) {
      // the lid is modelled open (up); a blink turns it down over the eye
      lid.rotation.x += blink * 1.4;
    }
  }
  [[P.browL, p.browL, p.browTiltL, -1], [P.browR, p.browR, p.browTiltR, 1]].forEach(([b, up, tilt, side]) => {
    if (!b) return;
    b.position.y += (up + p.smile * 0.25 - p.frown * 0.35) * 0.008;
    // the inner end (toward the middle) drops on a frown
    b.rotation.z += -tilt * D2R + side * p.frown * 0.35;
  });

  // mouth width / opening, smoothed (k per 60 fps frame)
  const [bw, bh] = MOUTH[p.viseme] || MOUTH.REST;
  const tw = bw * (1 + p.smile * 0.25 + p.laugh * 0.15 - p.frown * 0.08);
  const th = Math.max(0, bh * p.jaw + p.laugh * 0.35);
  state.w ??= tw;
  state.h ??= th;
  state.w += (tw - state.w) * 0.45;
  state.h += (th - state.h) * 0.45;
  const open = state.h / 0.62;
  if (P.mouth) {
    // modelled as a smile: scale.y < 0 flips the curve into a frown
    P.mouth.scale.x *= state.w / 0.85;
    P.mouth.scale.y *= 0.5 + p.smile * 0.9 - p.frown * 2.1;
    P.mouth.position.y += p.smile * 0.002 - open * 0.004;
  }
  if (P.jaw) {
    P.jaw.visible = open > 0.04;
    P.jaw.scale.x *= state.w;
    P.jaw.scale.y *= Math.max(0.02, open);
    P.jaw.position.y -= open * 0.003;
  }
  for (const c of [P.cheekL, P.cheekR]) {
    if (!c) continue;
    c.position.y += (p.smile + p.laugh * 0.5) * 0.006;
    c.scale.multiplyScalar(1 + (p.smile + p.laugh * 0.5) * 0.18);
  }
}

// ---------- expression preview ----------
const ease = (x) => x * x * (3 - 2 * x);
/** 0 → 1 → 0 over `len` seconds starting at `at`, held flat at 1 in the middle */
const pulse = (t, at, len, edge = 0.25) => {
  const u = (t - at) / len;
  if (u <= 0 || u >= 1) return 0;
  return ease(Math.min(1, u / edge, (1 - u) / edge));
};
/** one natural blink (0.2 s) every `every` seconds */
const blinkAt = (t, every = 3.2) => {
  const u = (t % every) / 0.2;
  return u < 1 ? Math.sin(u * Math.PI) : 0;
};
// a few words' worth of mouth shapes, as Blurb's lip sync would give them (visemes, 0.11 s each)
const TALK = 'A I MBP E O REST FV A U E REST I A MBP O E REST REST'.split(' ');

/** the pose a preview mode shows at time t (seconds since it started) */
export function previewPose(mode, t, manual) {
  const p = { ...NEUTRAL, breath: Math.sin(t * 1.3) * 1.2 };
  if (mode === 'manual') return { ...p, ...manual, blinkR: manual.blinkL };
  const idleBlink = mode === 'blink' ? 0 : blinkAt(t + 1.1, 3.6);
  p.blinkL = p.blinkR = idleBlink;
  if (mode === 'blink') p.blinkL = p.blinkR = blinkAt(t, 1.1);
  if (mode === 'smile') p.smile = ease(Math.min(1, t / 0.35));
  if (mode === 'frown') p.frown = ease(Math.min(1, t / 0.35));
  if (mode === 'talk') {
    p.viseme = TALK[Math.floor(t / 0.11) % TALK.length];
    p.browL = p.browR = Math.max(0, Math.sin(t * 2.1)) * 0.5;
    p.yaw = Math.sin(t * 0.9) * 6;
  }
  if (mode === 'turn') {
    p.yaw = Math.sin(t * 1.1) * 35;
    p.pitch = Math.sin(t * 0.7) * 10;
    p.roll = Math.sin(t * 0.8 + 1) * 8;
    p.gazeX = Math.sin(t * 1.1);
  }
  if (mode === 'loop') {
    // blink, smile, frown, talk, look around: 10 s round
    const k = t % 10;
    p.blinkL = p.blinkR = blinkAt(k, 10) + (k > 0.6 && k < 1.6 ? blinkAt(k - 0.6, 10) : 0);
    p.smile = pulse(k, 1.6, 2.2);
    p.frown = pulse(k, 4, 1.8);
    if (k > 6 && k < 8) p.viseme = TALK[Math.floor(k / 0.11) % TALK.length];
    const look = pulse(k, 8, 2, 0.3);
    p.yaw = Math.sin((k - 8) * Math.PI) * 30 * look;
    p.gazeX = Math.sin((k - 8) * Math.PI) * look;
  }
  return p;
}
