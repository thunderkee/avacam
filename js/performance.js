// Performance → motion tracks, using Blurb's own Face-mode pipeline.
//
// A recording is a list of raw tracker samples { t, bs, m, key } (the same shape
// Blurb's media.js records). FaceSync.samplesToRig turns them into mouth events and
// head / eye / brow / gaze / expression tracks; Rig poses any Blurb character from
// those, and poseAt() reads the same tracks as plain numbers for the 3D characters.
// Blurb's libraries (blurb/*.js) are classic scripts that define these globals.
/* global FaceSync, LipSync, Motion */

export const FPS = 30;

// MediaPipe face-mesh indices Blurb uses for geometric pose and expressions.
const KEY_POINTS = {
  nose: 1, chin: 152, forehead: 10, cheekL: 234, cheekR: 454, eyeOuterL: 33, eyeOuterR: 263,
  browMidL: 105, browInnerL: 107, browMidR: 334, browInnerR: 336,
  lidTopL: 159, lidBotL: 145, lidTopR: 386, lidBotR: 374,
  mouthL: 61, mouthR: 291, lipTop: 0, lipBot: 17,
};

/**
 * Shoulders (landmarks 11 / 12) plus elbows (13 / 14) and wrists (15 / 16) from a MediaPipe
 * Pose Landmarker result, in the same square-pixel units as `key`. L / R are the performer's
 * own sides; an elbow or wrist that isn't clearly in view is null.
 */
export function poseFromResult(res, aspect) {
  const pts = res?.landmarks?.[0];
  if (!pts || !pts[11] || !pts[12] || Math.min(pts[11].visibility ?? 1, pts[12].visibility ?? 1) <= 0.4) return null;
  const at = (i) => (pts[i] && (pts[i].visibility ?? 1) > 0.5 ? [pts[i].x * aspect, pts[i].y] : null);
  // 3D "world" positions (metres, hips at the origin; x as the image, y down, z away from the camera).
  const w = res.worldLandmarks?.[0];
  const wat = (i, min = 0.5) => (w?.[i] && (pts[i]?.visibility ?? 1) > min ? [w[i].x, w[i].y, w[i].z] : null);
  return { shoulderL: at(11) || [pts[11].x * aspect, pts[11].y], shoulderR: at(12) || [pts[12].x * aspect, pts[12].y],
    elbowL: at(13), elbowR: at(14), wristL: at(15), wristR: at(16),
    world: w ? { shoulderL: wat(11, 0.4), shoulderR: wat(12, 0.4), elbowL: wat(13), elbowR: wat(14), wristL: wat(15), wristR: wat(16) } : null };
}

/** One MediaPipe Face Landmarker result (+ latest shoulders) → a Blurb sample (bs null when no face). */
export function sampleFromResult(res, t, aspect, pose = null) {
  const shapes = res.faceBlendshapes?.[0];
  const matrix = res.facialTransformationMatrixes?.[0];
  const points = res.faceLandmarks?.[0];
  const bs = shapes ? Object.fromEntries(shapes.categories.map((c) => [c.categoryName, c.score])) : null;
  const key = points ? Object.fromEntries(Object.entries(KEY_POINTS).map(([name, i]) =>
    [name, [points[i].x * aspect, points[i].y, points[i].z * aspect]])) : null;
  return { t, bs, m: matrix ? Array.from(matrix.data) : null, key, pose };
}

/** Column-major 4×4 for a head pose in degrees (inverse of FaceSync.headPose), at (x, y, z) cm. */
function poseMatrix(yaw, pitch, roll, [x, y, z] = [0, 0, -40]) {
  const r = Math.PI / 180;
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw * r), Math.sin(yaw * r), Math.cos(pitch * r), Math.sin(pitch * r), Math.cos(roll * r), Math.sin(roll * r)];
  // R = Rz(roll) · Ry(yaw) · Rx(pitch)
  const R = [
    [cr * cy, cr * sy * sp - sr * cp, cr * sy * cp + sr * sp],
    [sr * cy, sr * sy * sp + cr * cp, sr * sy * cp - cr * sp],
    [-sy, cy * sp, cy * cp],
  ];
  const m = new Array(16).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) m[col * 4 + row] = R[row][col];
  m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
  return m;
}

/** A synthetic performer, for trying the app without a camera. */
export function demoSample(t) {
  const talk = Math.max(0, Math.sin(t * 9) * Math.sin(t * 2.3) + Math.sin(t * 13) * 0.3);
  const blink = (t % 3.7) < 0.14 ? 0.95 : 0.05;
  const smile = Math.max(0, Math.sin(t * 0.4)) * 0.5;
  const look = Math.sin(t * 0.5) * 0.4;
  const bs = {
    jawOpen: Math.min(1, talk * 0.55), mouthFunnel: Math.max(0, Math.sin(t * 1.7) - 0.6),
    mouthPucker: Math.max(0, Math.sin(t * 1.3 + 1) - 0.7) * 2, mouthClose: talk < 0.05 ? 0.2 : 0,
    eyeBlinkLeft: blink, eyeBlinkRight: blink,
    mouthSmileLeft: smile, mouthSmileRight: smile,
    browInnerUp: Math.max(0, Math.sin(t * 1.3)) * 0.5, browOuterUpLeft: Math.max(0, Math.sin(t * 1.3)) * 0.4, browOuterUpRight: Math.max(0, Math.sin(t * 1.3)) * 0.4,
    eyeLookOutLeft: Math.max(0, look), eyeLookInRight: Math.max(0, look), eyeLookInLeft: Math.max(0, -look), eyeLookOutRight: Math.max(0, -look),
  };
  // Sway side to side, lean in and out, and tilt the shoulders.
  const pos = [Math.sin(t * 0.45) * 3, Math.sin(t * 0.9) * 1, -40 + Math.sin(t * 0.3) * 6];
  const tilt = Math.sin(t * 0.55) * 0.06, mid = 0.5 + Math.sin(t * 0.45) * 0.03;
  const lean = 40 / Math.abs(pos[2]); // leaning in: shoulders look wider too
  const pose = { shoulderL: [mid + 0.2 * lean, 0.85 + tilt], shoulderR: [mid - 0.2 * lean, 0.85 - tilt] };
  // Arms in 3D, in screen space (x right, y up, z toward the camera): the right arm waves now and
  // then, the left one reaches toward the camera now and then. Written out as world + image points.
  const wave = Math.max(0, Math.sin(t * 0.5 - 1)) ** 0.7;
  const reach = Math.max(0, Math.sin(t * 0.37 + 2)) ** 1.2;
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
  const phiU = 0.15 + wave * 2.0, phiL = phiU + wave * (0.7 + 0.45 * Math.sin(t * 9));
  const dirs = {
    R: [[Math.sin(phiU), -Math.cos(phiU), 0.1 * wave], [Math.sin(phiL), -Math.cos(phiL), 0.15 * wave]],
    L: [norm([-0.15 * (1 - reach), -Math.cos(reach * 1.35), Math.sin(reach * 1.35)]), norm([-0.12 * (1 - reach), -1 + reach * 1.05, reach * 1.6])],
  };
  pose.world = {};
  for (const sd of ['L', 'R']) {
    const sh = [sd === 'L' ? -0.18 : 0.18, 0.45 + tilt * (sd === 'L' ? -1 : 1), 0];   // screen space, metres
    const el = sh.map((c, i) => c + dirs[sd][0][i] * 0.28), wr = el.map((c, i) => c + dirs[sd][1][i] * 0.25);
    const toWorld = (v) => [-v[0], -v[1], -v[2]];                                     // mirror x, y down, z away
    const toImage = (v) => [pose[`shoulder${sd}`][0] - (v[0] - sh[0]) * 0.8, pose[`shoulder${sd}`][1] - (v[1] - sh[1]) * 0.8];
    Object.assign(pose.world, { [`shoulder${sd}`]: toWorld(sh), [`elbow${sd}`]: toWorld(el), [`wrist${sd}`]: toWorld(wr) });
    pose[`elbow${sd}`] = toImage(el); pose[`wrist${sd}`] = toImage(wr);
  }
  return { t, bs, m: poseMatrix(Math.sin(t * 0.8) * 26, Math.sin(t * 1.1) * 8, Math.sin(t * 0.6) * 7, pos), key: null, pose };
}

/** Breathing as a function of absolute time, so it stays continuous across live windows. */
const breathAt = (sec) => -((Math.sin((2 * Math.PI * sec) / 3.8) + 1) / 2) * 1.6;

const track = (values) => values.map((value, frame) => ({ frame, value }));
const perFrame = (tr, n) => Array.from({ length: n }, (_, f) => Motion.valueAt(tr, f));
/** Extra smoothing on a keyframe track (radius in frames), for the Clean-up slider. */
const smoothTrack = (tr, n, radius) => (tr && radius > 0 ? Motion.decimate(Motion.smooth(perFrame(tr, n), radius), 0.05) : tr);

/**
 * Samples (plus the calibration take, prepended so the medians FaceSync calibrates
 * against are the performer's neutral face) → tracks for every frame.
 *   opts.strength  expression strength (1 = as performed)
 *   opts.smooth    0..1 extra smoothing of head and gaze
 *   opts.timeBase  seconds added to breathing time (keeps live windows continuous)
 */
export function solve(samples, calib = [], { strength = 1, smooth = 0, timeBase = 0 } = {}) {
  const calibDur = calib.length ? calib[calib.length - 1].t - calib[0].t + 1 / FPS : 0;
  const c0 = calib.length ? calib[0].t : 0;
  const s0 = samples.length ? samples[0].t : 0;
  const all = [
    ...calib.map((s) => ({ ...s, t: s.t - c0 })),
    ...samples.map((s) => ({ ...s, t: s.t - s0 + calibDur })),
  ];
  const offset = Math.round(calibDur * FPS);
  const n = Math.max(offset + 1, Math.ceil((all.length ? all[all.length - 1].t : 0) * FPS) + 1);
  const tracked = FaceSync.samplesToRig(all, { fps: FPS, totalFrames: n, strength, mirror: true, shoulders: true });
  const segments = tracked.events.length
    ? LipSync.buildSegments(tracked.events, { set: 'visemes', fps: FPS, totalFrames: n, minHoldFrames: 2 })
    : [{ key: LipSync.REST, start: 0, end: n }];
  const extras = { ...tracked.extras };
  extras.mouthScale = Motion.jawScale(segments, n, FPS, { live: tracked.jaw || null, toViseme: (k) => LipSync.PHONEME_TO_VISEME[k] || k });
  extras.profile = false; // big turns stop at the ¾ drawing, as in Blurb
  extras.breath = track(Array.from({ length: n }, (_, f) => breathAt(timeBase + (f - offset) / FPS)));
  extras.arms = armTracks(all, n);
  extras.near = nearTracks(all, calibDur, n);
  // 2D characters: Blurb's head scale is damped (0.85–1.2); drive it from the stronger closeness instead.
  if (extras.near.head && extras.head) extras.head.scale = Motion.decimate(
    Array.from({ length: n }, (_, f) => Math.min(NEAR.head2D.max, Math.max(NEAR.head2D.min, 1 + (Motion.valueAt(extras.near.head, f) - 1) * NEAR.head2D.amp))), 0.003, 3);
  const radius = Math.round(smooth * 0.3 * FPS);
  if (radius && extras.head) extras.head = Object.fromEntries(Object.entries(extras.head).map(([k, tr]) => [k, smoothTrack(tr, n, radius)]));
  if (radius && extras.gaze) extras.gaze = { x: smoothTrack(extras.gaze.x, n, radius), y: smoothTrack(extras.gaze.y, n, radius) };
  return { n, offset, segments, extras, faceRatio: tracked.faceRatio };
}

// Relaxed arms: a little away from the body (screen angles, radians; + = toward screen right).
export const ARM_REST = { L: { u: -0.14, l: -0.12 }, R: { u: 0.14, l: 0.12 } };

/**
 * Arm angles per frame from the pose samples, in mirrored screen space (like the face):
 *   u  upper arm from straight down, at the shoulder;  l  forearm relative to the upper arm.
 * L / R are screen sides. Frames where an arm isn't in view hold the relaxed pose (vis 0).
 * Returns null when arms are almost never visible.
 */
function armTracks(all, n) {
  const posed = all.filter((s) => s.pose && (s.pose.elbowL || s.pose.elbowR));
  if (posed.length < Math.max(3, all.length * 0.15)) return null;
  // Mirror: the performer's left (landmark 11…) is on screen left, image x flips.
  const angle = (a, b) => Math.atan2(-(b[0] - a[0]), b[1] - a[1]);
  const out = {};
  for (const [side, k] of [['L', 'L'], ['R', 'R']]) {
    const u = [], l = [], vis = [], d3 = [];
    let j = 0, has3D = false;
    for (let f = 0; f < n; f++) {
      const t = f / FPS;
      while (j < posed.length - 1 && Math.abs(posed[j + 1].t - t) <= Math.abs(posed[j].t - t)) j++;
      const p = posed[j].pose, near = Math.abs(posed[j].t - t) < 0.35;
      const sh = p[`shoulder${k}`], el = p[`elbow${k}`], wr = p[`wrist${k}`];
      if (near && sh && el) {
        const up = angle(sh, el);
        u.push(up); l.push(wr ? angle(el, wr) - up : ARM_REST[side].l); vis.push(1);
      } else { u.push(null); l.push(null); vis.push(0); }
      // Depth: 3D directions of upper arm and forearm, and how far the wrist reaches toward the camera.
      const W = near ? p.world : null;
      const wsh = W?.[`shoulder${k}`], wel = W?.[`elbow${k}`], wwr = W?.[`wrist${k}`];
      if (wsh && wel) {
        const S = toScreen(wsh), E = toScreen(wel), Wr = wwr ? toScreen(wwr) : null;
        const dU = unit(sub(E, S)), dL = Wr ? unit(sub(Wr, E)) : dU;
        d3.push([...dU, ...dL, Wr ? Wr[2] - S[2] : 0]); has3D = true;
      } else d3.push(null);
    }
    const rest3 = [Math.sin(ARM_REST[side].u), -Math.cos(ARM_REST[side].u), 0];
    const rest3L = [Math.sin(ARM_REST[side].u + ARM_REST[side].l), -Math.cos(ARM_REST[side].u + ARM_REST[side].l), 0];
    const restRow = [...rest3, ...rest3L, 0];
    const comp = (c) => Motion.decimate(Motion.smooth(d3.map((row) => (row ? row[c] : restRow[c])), 2), 0.01, 3);
    // Unwrap (raising an arm overhead crosses ±π), fill gaps with the rest pose, smooth.
    const fill = (arr, rest) => {
      let prev = null;
      return arr.map((v) => {
        if (v == null) { prev = null; return rest; }
        if (prev != null) while (v - prev > Math.PI) v -= Math.PI * 2;
        if (prev != null) while (prev - v > Math.PI) v += Math.PI * 2;
        return (prev = v);
      });
    };
    const sm = (arr) => Motion.decimate(Motion.smooth(arr, 2), 0.01, 3);
    out[side] = { u: sm(fill(u, ARM_REST[side].u)), l: sm(fill(l, ARM_REST[side].l)), vis: Motion.decimate(Motion.smooth(vis, 3), 0.05) };
    if (has3D) out[side].d3 = { ux: comp(0), uy: comp(1), uz: comp(2), lx: comp(3), ly: comp(4), lz: comp(5), reach: comp(6) };
  }
  return out;
}
// How strongly closeness to the camera shows (1 = true to life). Kept here so it's easy to tune.
export const NEAR = {
  head2D: { amp: 2.2, min: 0.6, max: 1.9 },  // 2D characters' head scale
  body: { amp: 2.6, min: 0.55, max: 2.3 },   // 3D: whole character, from shoulder width
  head: { amp: 2.6, min: 0.7, max: 1.9 },    // 3D: head on top of that, when it leans in past the shoulders
  hand: { full: 0.28, grow: 2.2, fore: 0.8, upper: 0.3 }, // 3D: reach (m) for full effect; hand / forearm / upper-arm growth
};

/**
 * Closeness to the camera per frame, as ratios to the calibrated rest (1 = rest, 2 = twice as close):
 *   head  from the face transform's distance (cm)
 *   body  from how wide the shoulders look on camera
 */
function nearTracks(all, calibDur, n) {
  const median = (vals) => { const v = vals.slice().sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  const series = (fn, invert) => {
    const pts = all.map((smp) => ({ t: smp.t, v: fn(smp) })).filter((x) => Number.isFinite(x.v) && x.v > 0);
    if (pts.length < 4) return null;
    const calib = pts.filter((x) => x.t < calibDur);
    const rest = median((calib.length > 5 ? calib : pts).map((x) => x.v));
    const vals = [];
    let j = 0;
    for (let f = 0; f < n; f++) {
      const t = f / FPS;
      while (j < pts.length - 1 && Math.abs(pts[j + 1].t - t) <= Math.abs(pts[j].t - t)) j++;
      vals.push(invert ? rest / pts[j].v : pts[j].v / rest);
    }
    return Motion.decimate(Motion.smooth(vals, 3), 0.004, 3);
  };
  return {
    head: series((smp) => (smp.m ? Math.abs(smp.m[14]) : NaN), true),
    body: series((smp) => (smp.pose ? Math.hypot(smp.pose.shoulderL[0] - smp.pose.shoulderR[0], smp.pose.shoulderL[1] - smp.pose.shoulderR[1]) : NaN), false),
  };
}

// World landmarks → screen space (x right as you see it in the mirror, y up, z toward the camera).
const toScreen = (v) => [-v[0], -v[1], -v[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Which mouth key is showing at frame f. */
function keyAt(segments, f) {
  for (const s of segments) if (f >= s.start && f < s.end) return s.key;
  return LipSync.REST;
}

/** Plain-number pose at frame f, for the 3D characters (same tracks the Blurb rig reads). */
export function poseAt(tracks, f) {
  const e = tracks.extras;
  const v = (tr) => (tr && tr.length ? Motion.valueAt(tr, f) : 0);
  const key = keyAt(tracks.segments, f);
  return {
    yaw: v(e.head?.yaw), pitch: v(e.head?.pitch), roll: v(e.head?.roll),         // degrees
    blinkL: v(e.eyes?.left) / 100, blinkR: v(e.eyes?.right) / 100,               // 0..1
    gazeX: v(e.gaze?.x), gazeY: v(e.gaze?.y),                                    // -1..1
    browL: -v(e.brows?.left?.y) / 10, browR: -v(e.brows?.right?.y) / 10,          // up = +
    browTiltL: v(e.brows?.left?.rotation), browTiltR: v(e.brows?.right?.rotation),
    viseme: LipSync.PHONEME_TO_VISEME[key] || key,
    jaw: e.mouthScale?.length ? Motion.valueAt(e.mouthScale, f) : 1,
    smile: v(e.expression?.smile), laugh: v(e.expression?.laugh), frown: v(e.expression?.frown),
    breath: v(e.breath),
    // Movement and closeness (artwork px / scale factor), shoulders (degrees, artwork px)
    headX: v(e.head?.x), headY: v(e.head?.y), headScale: e.head?.scale?.length ? Motion.valueAt(e.head.scale, f) : 1,
    bodyRoll: v(e.body?.roll), bodyX: v(e.body?.x), bodyY: v(e.body?.y),
    // Closeness ratios (1 = calibrated rest); body falls back to the head's when shoulders aren't seen.
    nearHead: e.near?.head ? Motion.valueAt(e.near.head, f) : 1,
    nearBody: e.near?.body ? Motion.valueAt(e.near.body, f) : (e.near?.head ? Motion.valueAt(e.near.head, f) : 1),
    // Arms (radians, screen space; see armTracks). Null when arms aren't tracked.
    arms: e.arms ? Object.fromEntries(['L', 'R'].map((sd) => {
      const a = e.arms[sd], d = a.d3;
      return [sd, { u: v(a.u), l: v(a.l), vis: v(a.vis),
        // 3D: unit directions (screen space, z toward the camera) and wrist reach in metres
        d3: d ? { u: [v(d.ux), v(d.uy), v(d.uz)], l: [v(d.lx), v(d.ly), v(d.lz)], reach: v(d.reach) } : null }];
    })) : null,
  };
}

/**
 * Live: solve a short rolling window each frame (calibration + the last ~1.5 s),
 * and pose the newest frame. Blurb's pipeline is batch; a window keeps its
 * blink baselines, anticipation and springs working in real time.
 */
export class LiveSolver {
  constructor(windowSec = 1.5) { this.windowSec = windowSec; this.buf = []; this.calib = []; }
  setCalibration(samples) {
    // Keep ~1 s of the neutral take: enough for stable medians, cheap to re-solve.
    const step = Math.max(1, Math.floor(samples.length / FPS));
    this.calib = samples.filter((_, i) => i % step === 0);
  }
  push(sample) {
    this.buf.push(sample);
    const cut = sample.t - this.windowSec;
    while (this.buf.length && this.buf[0].t < cut) this.buf.shift();
  }
  clear() { this.buf = []; }
  /** → { tracks, frame } for the newest sample, or null without a recent face. */
  solve(now) {
    if (!this.buf.some((s) => s.bs)) return null;
    const tracks = solve(this.buf, this.calib, { timeBase: this.buf[0].t });
    return { tracks, frame: tracks.n - 1 };
  }
}
