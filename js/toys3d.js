// Avatar Cam's own characters as 3D vinyl-toy heads in three.js.
// They read the same motion as the Blurb characters, as plain numbers (poseAt()).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { NEAR } from './performance.js';

export const TOY_CAST = [
  { id: 'puff', name: 'Puff', kind: 'toy', bg: '#FFD9CC' },
  { id: 'neko', name: 'Neko', kind: 'toy', bg: '#CFD8F6' },
  { id: 'bolt', name: 'Bolt', kind: 'toy', bg: '#CDEFE6' },
];

const D2R = Math.PI / 180;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Scratch objects for posing arms each frame.
const DOWN = new THREE.Vector3(0, -1, 0);
const _e = new THREE.Euler(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _qU = new THREE.Quaternion(), _qL = new THREE.Quaternion(), _qInv = new THREE.Quaternion();
const _qIdleU = new THREE.Quaternion(), _qIdleL = new THREE.Quaternion(), _bodyInv = new THREE.Quaternion();
/** A tracked arm direction in the body's frame; never further back than slightly behind the shoulder. */
function armDir([x, y, z], bodyInv, out) {
  out.set(x, y, Math.max(z, -0.3)).normalize().applyQuaternion(bodyInv);
  return out;
}
// Mouth opening per viseme: width, height (head units at jaw 1).
const MOUTH = { REST: [0.85, 0], MBP: [0.75, 0], FV: [0.85, 0.07], I: [1.1, 0.16], E: [1.15, 0.3], U: [0.55, 0.28], O: [0.7, 0.5], A: [1, 0.62] };

export const vinyl = (color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.35, ...extra });
export const ink = (color = '#231a2e') => new THREE.MeshStandardMaterial({ color, roughness: 0.25 });

export function sphere(r, mat, ws = 48, hs = 32) { return new THREE.Mesh(new THREE.SphereGeometry(r, ws, hs), mat); }

/** Bead eye with a catchlight; returns the group (scale.y = blink). */
export function beadEye(r, mat) {
  const g = new THREE.Group();
  const ball = sphere(r, mat); ball.scale.z = 0.55; g.add(ball);
  const glint = sphere(r * 0.28, new THREE.MeshBasicMaterial({ color: '#ffffff' }), 16, 12);
  glint.position.set(-r * 0.35, r * 0.4, r * 0.5); g.add(glint);
  return g;
}

/** A soft mouth: dark opening + tongue, and a curve for closed / smiling mouths (a "w" for a cat mouth). */
export function makeMouth(scale, lipColor = '#5a2030', { cat = false, inside = null } = {}) {
  const g = new THREE.Group();
  const hole = sphere(0.5, ink(inside || lipColor)); hole.scale.set(1, 1, 0.25); g.add(hole);
  const tongue = sphere(0.3, vinyl('#ff7d8f', { clearcoat: 0.2 })); tongue.position.set(0, -0.25, 0.05); tongue.scale.set(1, 0.6, 0.4);
  hole.add(tongue);
  let curve;
  if (cat) {
    curve = new THREE.Group();
    for (const s of [-1, 1]) {
      const arc = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.055, 12, 24, Math.PI * 0.85), ink(lipColor));
      arc.rotation.z = Math.PI * 1.075; arc.position.x = s * 0.21; curve.add(arc);
    }
  } else {
    curve = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 12, 32, Math.PI * 0.62), ink(lipColor));
    curve.rotation.z = Math.PI * 1.19;
  }
  g.add(curve);
  g.scale.setScalar(scale);
  return { g, hole, curve, cat, w: 0.85, h: 0 };
}

function poseMouth(m, p, k = 0.45) {
  const [bw, bh] = MOUTH[p.viseme] || MOUTH.REST;
  const tw = bw * (1 + p.smile * 0.25 + p.laugh * 0.15);
  const th = Math.max(0, bh * p.jaw + p.laugh * 0.35);
  m.w += (tw - m.w) * k; m.h += (th - m.h) * k;
  const open = m.h > 0.05;
  m.hole.visible = open;
  m.hole.scale.set(m.w, Math.max(0.05, m.h), 0.25);
  m.hole.position.y = -m.h * 0.25;
  m.curve.visible = !open;
  if (m.cat) { m.curve.scale.set(m.w * 1.05, 1 + p.smile * 0.3, 1); return; }
  // Smile curves up (an arc under the centre); frown flips it.
  const bend = p.frown > 0.3 && p.smile < 0.2 ? -1 : 1;
  m.curve.rotation.z = bend > 0 ? Math.PI * 1.19 : Math.PI * 0.19;
  m.curve.position.y = bend > 0 ? 0.32 : -0.3;
  m.curve.scale.set(m.w * 0.9, 0.5 + p.smile * 0.7, 1);
}

/**
 * Two-part arms hanging from the shoulders: shoulder pivot → upper arm → elbow pivot → forearm → hand.
 * Rotations are about z (screen plane), matching poseAt's arm angles; + swings toward screen right.
 */
export function addArms(rig, { x, y, upper, lower, r, mat, hand }) {
  rig.arms = [];
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const shoulder = new THREE.Group(); shoulder.position.set(s * x, y, 0);
    const up = new THREE.Mesh(new THREE.CapsuleGeometry(r, upper, 8, 20), mat); up.position.y = -upper / 2; shoulder.add(up);
    const elbow = new THREE.Group(); elbow.position.y = -upper; shoulder.add(elbow);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(r * 0.9, lower, 8, 20), mat); fore.position.y = -lower / 2; elbow.add(fore);
    const h = hand(s); h.position.y = -lower - r * 0.6; elbow.add(h);
    rig.body.add(shoulder);
    rig.arms.push({ side, shoulder, elbow, hand: h, upper: up, fore, qU: new THREE.Quaternion(), qL: new THREE.Quaternion(), near: 0 });
  }
}

function build(id) {
  const root = new THREE.Group();
  const head = new THREE.Group();
  const body = new THREE.Group();
  root.add(body, head);
  head.position.y = 0.15;
  const rig = { root, head, body, eyes: [], brows: [], ears: [], mouth: null, extra: {} };

  if (id === 'puff') {
    const skin = vinyl('#FFB8A0');
    const skull = sphere(1, skin); skull.scale.set(1.05, 0.95, 0.9); head.add(skull);
    const shirt = vinyl('#FF9A86');
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.58, 1.0, 12, 32), shirt); torso.scale.set(1.12, 1, 0.8); torso.position.y = -1.76; body.add(torso);
    const neckP = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.3, 32), skin); neckP.position.y = -0.72; body.add(neckP); rig.neckY = -0.6;
    const belly = sphere(0.42, vinyl('#FFE1D6')); belly.scale.set(1, 1.1, 0.4); belly.position.set(0, -1.52, 0.38); body.add(belly);
    addArms(rig, { x: 0.66, y: -0.98, upper: 0.78, lower: 0.72, r: 0.13, mat: shirt,
      hand: () => { const m = sphere(0.17, skin); m.scale.set(1, 0.9, 0.85); return m; } });
    for (const s of [-1, 1]) {
      const e = beadEye(0.13, ink()); e.position.set(s * 0.36, 0.08, 0.86); head.add(e); rig.eyes.push(e);
      const blush = sphere(0.14, new THREE.MeshStandardMaterial({ color: '#ff7a8a', transparent: true, opacity: 0.45 })); blush.scale.set(1.3, 0.7, 0.2);
      blush.position.set(s * 0.6, -0.15, 0.78); head.add(blush);
      const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.2, 6, 12), ink()); brow.rotation.z = Math.PI / 2;
      brow.position.set(s * 0.36, 0.36, 0.86); head.add(brow); rig.brows.push(brow);
    }
    rig.mouth = makeMouth(0.32); rig.mouth.g.position.set(0, -0.25, 0.9); head.add(rig.mouth.g);
    // a sprout that springs with head movement
    const sprout = new THREE.Group(); sprout.position.set(0, 0.93, 0);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.3), vinyl('#4CAF7A')); stem.position.y = 0.15; sprout.add(stem);
    const leaf = sphere(0.12, vinyl('#6FD49A')); leaf.scale.set(1.4, 0.5, 0.8); leaf.position.set(0.12, 0.3, 0); sprout.add(leaf);
    head.add(sprout); rig.extra.spring = sprout;
  }

  if (id === 'neko') {
    const fur = vinyl('#4B5170');
    const skull = sphere(1, fur); skull.scale.set(1.1, 0.92, 0.9); head.add(skull);
    const coat = vinyl('#3A3F58');
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 1.0, 12, 32), coat); torso.scale.set(1.1, 1, 0.78); torso.position.y = -1.76; body.add(torso);
    const neckN = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.3, 32), fur); neckN.position.y = -0.7; body.add(neckN); rig.neckY = -0.58;
    const chest = sphere(0.36, vinyl('#EEEAF5')); chest.scale.set(1, 1.3, 0.4); chest.position.set(0, -1.32, 0.36); body.add(chest);
    addArms(rig, { x: 0.62, y: -1.0, upper: 0.76, lower: 0.7, r: 0.115, mat: coat,
      hand: () => {
        const paw = new THREE.Group();
        const pad = sphere(0.16, vinyl('#EEEAF5')); pad.scale.set(1, 0.85, 0.9); paw.add(pad);
        const bean = sphere(0.06, vinyl('#F7A8C0')); bean.scale.set(1, 0.8, 0.5); bean.position.set(0, -0.02, 0.13); paw.add(bean);
        return paw;
      } });
    const muzzle = sphere(0.36, vinyl('#EEEAF5')); muzzle.scale.set(1.25, 0.8, 0.7); muzzle.position.set(0, -0.28, 0.72); head.add(muzzle);
    const nose = sphere(0.07, vinyl('#F07AA0')); nose.scale.set(1.3, 0.8, 0.8); nose.position.set(0, -0.12, 0.98); head.add(nose);
    for (const s of [-1, 1]) {
      const ear = new THREE.Group(); ear.position.set(s * 0.58, 0.62, 0); ear.rotation.z = -s * 0.35;
      const outer = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.6, 24), fur); outer.position.y = 0.25; outer.scale.z = 0.5; ear.add(outer);
      const inner = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 24), vinyl('#F7A8C0')); inner.position.set(0, 0.2, 0.1); inner.scale.z = 0.3; ear.add(inner);
      head.add(ear); rig.ears.push(ear);
      const eye = new THREE.Group();
      const white = sphere(0.17, vinyl('#FFF7D6')); white.scale.z = 0.5; eye.add(white);
      const iris = beadEye(0.11, vinyl('#62C454', { roughness: 0.2 })); iris.position.z = 0.06; eye.add(iris);
      const pupil = sphere(0.05, ink('#111')); pupil.scale.set(0.6, 1.3, 0.4); pupil.position.z = 0.12; eye.add(pupil);
      eye.position.set(s * 0.37, 0.12, 0.8); head.add(eye); rig.eyes.push(eye);
      const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.14, 6, 12), ink('#1c1f33')); brow.rotation.z = Math.PI / 2;
      brow.position.set(s * 0.37, 0.38, 0.85); head.add(brow); rig.brows.push(brow);
      for (const dy of [-0.04, 0.05]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.5), ink('#1c1f33'));
        w.rotation.z = Math.PI / 2 + s * (dy * 3); w.position.set(s * 0.6, -0.25 + dy, 0.85); head.add(w);
      }
    }
    rig.mouth = makeMouth(0.22, '#4a1f33'); rig.mouth.g.position.set(0, -0.36, 0.97); head.add(rig.mouth.g);
  }

  if (id === 'bolt') {
    const shell = vinyl('#E4E9EE', { metalness: 0.15 });
    const skull = new THREE.Mesh(new RoundedBoxGeometry(1.9, 1.6, 1.5, 6, 0.32), shell); head.add(skull);
    const plate = vinyl('#AEB8C2', { metalness: 0.2 });
    const metal = vinyl('#8B96A3', { metalness: 0.5 });
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.3, 24), metal); neck.position.y = -0.74; body.add(neck); rig.neckY = -0.62;
    const torso = new THREE.Mesh(new RoundedBoxGeometry(1.45, 1.9, 1.05, 6, 0.28), plate); torso.position.y = -1.8; body.add(torso);
    const panel = new THREE.Mesh(new RoundedBoxGeometry(0.7, 0.45, 0.06, 3, 0.05), new THREE.MeshStandardMaterial({ color: '#10141a', roughness: 0.2 }));
    panel.position.set(0, -1.35, 0.53); body.add(panel);
    const light = sphere(0.07, new THREE.MeshBasicMaterial({ color: '#5EF0FF' })); light.position.set(-0.18, -1.35, 0.57); body.add(light);
    for (const sd of [-1, 1]) { const joint = sphere(0.2, metal); joint.position.set(sd * 0.8, -1.07, 0); body.add(joint); }
    addArms(rig, { x: 0.8, y: -1.07, upper: 0.72, lower: 0.66, r: 0.095, mat: metal,
      hand: (sd) => {
        const claw = new THREE.Group();
        const palm = sphere(0.12, plate); claw.add(palm);
        for (const f of [-1, 1]) { const finger = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.2, 0.08, 2, 0.025), metal); finger.position.set(f * 0.07, -0.12, 0); finger.rotation.z = f * 0.25; claw.add(finger); }
        return claw;
      } });
    const screen = new THREE.Mesh(new RoundedBoxGeometry(1.45, 1.05, 0.1, 4, 0.05), new THREE.MeshStandardMaterial({ color: '#10141a', roughness: 0.15 }));
    screen.position.set(0, 0, 0.74); head.add(screen);
    const glow = new THREE.MeshBasicMaterial({ color: '#5EF0FF' });
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.28, 0.04, 3, 0.02), glow); eye.position.set(s * 0.32, 0.14, 0.8); head.add(eye); rig.eyes.push(eye);
      const brow = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.05, 0.04, 2, 0.01), glow); brow.position.set(s * 0.32, 0.38, 0.8); head.add(brow); rig.brows.push(brow);
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 20), vinyl('#8B96A3', { metalness: 0.5 })); bolt.rotation.z = Math.PI / 2; bolt.position.set(s * 1.0, 0, 0); head.add(bolt);
    }
    const bars = [];
    for (let i = 0; i < 7; i++) { const b = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.2, 0.03, 2, 0.02), glow); b.position.set((i - 3) * 0.1, -0.25, 0.8); head.add(b); bars.push(b); }
    rig.extra.bars = bars;
    const antenna = new THREE.Group(); antenna.position.set(0, 0.8, 0);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.4), vinyl('#8B96A3', { metalness: 0.5 })); rod.position.y = 0.2; antenna.add(rod);
    const tip = sphere(0.09, new THREE.MeshBasicMaterial({ color: '#FFB020' })); tip.position.y = 0.42; antenna.add(tip);
    head.add(antenna); rig.extra.spring = antenna; rig.extra.tip = tip;
  }
  return rig;
}

export class ToyStage {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 9 / 16, 0.1, 50);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#8a7f99', 1.6));
    const key = new THREE.DirectionalLight('#ffffff', 2.2); key.position.set(-2, 3, 4); this.scene.add(key);
    const rim = new THREE.DirectionalLight('#ffd8ff', 1.2); rim.position.set(3, 1, -2); this.scene.add(rim);
    this.rigs = {};
    this.current = null;
    this.spring = { a: 0, v: 0, lastYaw: 0 };
  }

  /** entry: a cast entry; entries that bring their own `build` (the 3D Blurb cast) use it. */
  setCharacter(entry) {
    const id = entry.id;
    if (this.current && this.current === this.rigs[id]) return;
    if (this.current) this.scene.remove(this.current.root);
    this.current = this.rigs[id] || (this.rigs[id] = entry.build ? entry.build() : build(id));
    this.scene.add(this.current.root);
  }

  /** Render pose p (see poseAt) at time t seconds into a w×h transparent canvas; returns it. */
  render(p, t, w, h) {
    const r = this.current;
    if (!r) return null;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) { this.renderer.setSize(w, h, false); this.camera.aspect = w / h; }
    // Frame head and shoulders like the Blurb characters: head in the upper half, body off the bottom.
    const fit = Math.max(1, (9 / 16) / (w / h));
    this.camera.position.set(0, -0.35, 9.5 * fit);
    this.camera.lookAt(0, -0.35, 0);
    this.camera.updateProjectionMatrix();

    const soft = (v, m) => m * Math.tanh(v / m);
    // A model built facing away and turned round (r.faceBack) nods and tilts the other way in its own axes.
    const fb = r.faceBack ? -1 : 1;
    r.head.rotation.set(fb * soft(p.pitch, 30) * D2R * 0.9, soft(p.yaw, 50) * D2R, -fb * p.roll * D2R);
    r.body.rotation.y = soft(p.yaw, 50) * D2R * 0.25;
    r.body.scale.setScalar(1 + (-p.breath / 1.6) * 0.015);
    // Shoulders tilt and sway; the head rides on them and moves on its own a little.
    // Blurb's tracks are in artwork px (400-wide canvas): ~0.006 units per px here.
    const PX = 0.006;
    r.body.rotation.z = -(p.bodyRoll || 0) * D2R;
    r.root.position.x = (p.bodyX || 0) * PX;
    r.root.position.y = Math.sin(t * 0.7) * 0.03 - (p.bodyY || 0) * PX;
    // Blob heads are locked to the centre of the frame (where the camera aims): no drift, sway or bob.
    if (r.locked) r.root.position.set(0, -0.35, 0);
    // Closeness: leaning in brings the whole character closer, like the camera; the head may grow a
    // little more when it leans in past the shoulders, but stays in proportion (NEAR.head).
    const range = (v, { amp, min, max }) => Math.min(max, Math.max(min, 1 + (v - 1) * amp));
    const nb = p.nearBody ?? 1, nh = p.nearHead ?? nb;
    r.root.scale.setScalar(range(nb, NEAR.body));
    // A locked body (the bdafighter fighters) stays put: no turn, tilt, sway, drift or lean-in.
    // Only the head and face move.
    if (r.bodyStill) { r.body.rotation.set(0, 0, 0); r.body.scale.setScalar(1); r.root.position.set(0, 0, 0); r.root.scale.setScalar(1); }
    const hd = r.head.userData;
    hd.p0 ??= r.head.position.clone();
    hd.s0 ??= r.head.scale.x; // a head built at its own size keeps it
    const grow = range(nh / nb, NEAR.head);
    r.head.scale.setScalar(hd.s0 * grow);
    if (r.neckY != null) {
      // The head turns, nods, tilts and grows about the top of the neck, which follows the shoulders'
      // tilt, so the head never comes off the neck. (It moves with the body, not on its own.)
      const pivot = _v1.set(0, r.neckY, 0).applyQuaternion(r.body.quaternion);
      const arm = _v2.set(hd.p0.x, (hd.p0.y - r.neckY) * grow, hd.p0.z).applyEuler(r.head.rotation);
      r.head.position.copy(pivot).add(arm);
    } else {
      // Floating heads have no neck: they turn about their centre and (unless locked) drift a little.
      if (r.locked || r.headStill) r.head.position.copy(hd.p0);
      else {
        r.head.position.x = hd.p0.x + ((p.headX || 0) - (p.bodyX || 0)) * PX;
        r.head.position.y = hd.p0.y - ((p.headY || 0) - (p.bodyY || 0)) * PX;
      }
    }

    r.eyes.forEach((e, i) => {
      const blink = i === 0 ? p.blinkL : p.blinkR;
      if (e.userData.lid) {
        // Eyes with a lid (the bdafighter fighters): swap to the closed-eye line while blinking.
        // Their side (screen left/right) is measured at load; an eye in the middle takes both.
        const side = e.userData.side ?? (i === 0 ? -1 : 1);
        const pick = (l, rr) => (side < 0 ? l : side > 0 ? rr : (l + rr) / 2);
        const bl = pick(p.blinkL, p.blinkR), up = pick(p.browL, p.browR), tilt = pick(p.browTiltL, p.browTiltR);
        const shut = bl > 0.5;
        e.visible = !shut; e.userData.lid.visible = shut;
        // Expression: raised brows open the eyes wide and lift them; a smile or laugh squeezes them
        // into a happy squint pushed up by the cheeks; a frown narrows and lowers them; a half blink
        // narrows them; the brows' tilt tilts them hard (angry, worried).
        const s0 = (e.userData.s0 ??= e.scale.clone()); e.userData.rz0 ??= e.rotation.z;
        const lift = Math.max(0, up), drop = Math.max(0, -up), h = e.userData.h || 0;
        const open = Math.min(1.9, Math.max(0.3, 1 + lift * 0.8 - drop * 0.3 - p.smile * 0.55 - (p.laugh || 0) * 0.6 - p.frown * 0.25 - bl * 0.7));
        e.scale.set(s0.x * (1 + lift * 0.25 + p.smile * 0.08), s0.y * open, s0.z);
        e.rotation.z = e.userData.rz0 + fb * Math.max(-38, Math.min(38, tilt * 2.2)) * D2R;
        e.userData.lift = h * (lift * 0.3 + p.smile * 0.2 - drop * 0.15 - p.frown * 0.12);
      } else e.scale.y = Math.max(0.08, 1 - blink);
      // Googly / doll eyes move the iris (userData.pupil); bead eyes move the whole eye.
      const look = e.userData.pupil || e, travel = e.userData.travel || 0.05;
      look.userData.x0 ??= look.position.x; look.userData.y0 ??= look.position.y;
      look.position.x = look.userData.x0 + p.gazeX * travel;
      look.position.y = look.userData.y0 - p.gazeY * travel * 0.8 + (look.userData.lift || 0);
    });
    r.brows.forEach((b, i) => {
      b.userData.y0 ??= b.position.y; b.userData.r0 ??= b.rotation.z;
      const up = i === 0 ? p.browL : p.browR, tilt = i === 0 ? p.browTiltL : p.browTiltR;
      b.position.y = b.userData.y0 + up * 0.1;
      b.rotation.z = b.userData.r0 - tilt * D2R;
    });
    r.ears.forEach((e, i) => {
      e.userData.r0 ??= e.rotation.z;
      e.rotation.z = e.userData.r0 + (i === 0 ? 1 : -1) * (i === 0 ? p.browL : p.browR) * 0.25;
    });

    if (r.mouth) poseMouth(r.mouth, p);
    // A hinged jaw (the bdafighter beasts) opens with the mouth, the way the game opens it (+x):
    // wide on open vowels, wider when laughing, a little agape when surprised; it narrows on round
    // vowels (O, U) and widens with a smile.
    const [, bh] = MOUTH[p.viseme] || MOUTH.REST;
    const round = p.viseme === 'O' || p.viseme === 'U';
    const surprise = Math.max(0, ((p.browL || 0) + (p.browR || 0)) / 2);
    if (r.extra.jaw) {
      const open = clamp01(bh * p.jaw * 1.2 + p.laugh * 0.45 + surprise * 0.1);
      const j = r.extra.jaw; j.userData.open = (j.userData.open || 0) + (open - (j.userData.open || 0)) * 0.55;
      j.rotation.x = j.userData.rest + (j.userData.sign ?? 1) * j.userData.open * 0.5;
      j.userData.s0 ??= j.scale.clone();
      j.scale.x = j.userData.s0.x * (1 + p.smile * 0.04 - (round ? 0.05 : 0));
    }
    if (r.talkScale) {
      // Fighters with no mouth on their head talk with the whole head: it stretches up as the mouth opens (about
      // its base, so it stays on the body), slims on round vowels and squashes wide with a smile.
      const open = clamp01(bh * p.jaw * 1.6 + p.laugh * 0.6);
      hd.talk = (hd.talk || 0) + (open - (hd.talk || 0)) * 0.55;
      const sx = 1 - hd.talk * 0.015 + p.smile * 0.02 - (round ? hd.talk * 0.015 : 0);
      const sy = 1 + hd.talk * 0.06 + surprise * 0.015 - p.smile * 0.01 - p.frown * 0.01;
      r.head.scale.set(r.head.scale.x * sx, r.head.scale.y * sy, r.head.scale.z * sx);
    }
    // Blurb heads' glow breathes, a little brighter while talking.
    if (r.extra.glow) r.extra.glow.material.opacity = 0.6 + 0.25 * Math.sin(t * 1.7) + Math.min(0.15, r.mouth.h * 0.3);
    // Arms follow the performer's in 3D when in view (depth included: reaching toward the camera
    // points the arm at it and the hand grows); otherwise a relaxed idle sway.
    if (r.arms) {
      _bodyInv.copy(r.body.quaternion).invert();
      for (const a of r.arms) {
        const s = a.side === 'L' ? -1 : 1;
        const tracked = p.arms?.[a.side];
        const vis = tracked ? clamp01(tracked.vis) : 0;
        const idleU = s * (0.14 + 0.03 * Math.sin(t * 1.3 + s)) + (-p.breath / 1.6) * 0.02 * s;
        const idleL = s * (0.12 + 0.03 * Math.sin(t * 1.1 + s * 2));
        _qIdleU.setFromEuler(_e.set(0, 0, idleU)); _qIdleL.setFromEuler(_e.set(0, 0, idleL));
        let reach = 0;
        if (tracked && vis > 0.01) {
          if (tracked.d3) {
            // Directions are in screen space; bring them into the body's frame, and keep arms in front of the torso.
            const dirU = armDir(tracked.d3.u, _bodyInv, _v1), dirL = armDir(tracked.d3.l, _bodyInv, _v2);
            _qU.setFromUnitVectors(DOWN, dirU);
            _qL.setFromUnitVectors(DOWN, dirL).premultiply(_qInv.copy(_qU).invert()); // forearm relative to upper arm
            reach = tracked.d3.reach;
          } else {
            _qU.setFromEuler(_e.set(0, 0, tracked.u)); _qL.setFromEuler(_e.set(0, 0, tracked.l));
          }
          _qU.slerp(_qIdleU, 1 - vis); _qL.slerp(_qIdleL, 1 - vis); // ease back to idle as the arm leaves view
        } else { _qU.copy(_qIdleU); _qL.copy(_qIdleL); }
        a.qU.slerp(_qU, 0.5); a.qL.slerp(_qL, 0.5);
        a.shoulder.quaternion.copy(a.qU); a.elbow.quaternion.copy(a.qL);
        // Closeness: reaching toward the camera makes the hand much bigger and the arm thicker
        // (well beyond what perspective gives at this scale).
        const k = clamp01(reach / NEAR.hand.full) * vis;
        a.near += (k - a.near) * 0.4;
        a.hand.scale.setScalar(1 + a.near * NEAR.hand.grow);
        a.fore.scale.set(1 + a.near * NEAR.hand.fore, 1, 1 + a.near * NEAR.hand.fore);
        a.upper.scale.set(1 + a.near * NEAR.hand.upper, 1, 1 + a.near * NEAR.hand.upper);
      }
    }
    if (r.extra.bars) {
      const round = p.viseme === 'O' || p.viseme === 'U';
      const [, bh] = MOUTH[p.viseme] || MOUTH.REST;
      const open = Math.max(0, bh * p.jaw + p.laugh * 0.3);
      r.extra.bars.forEach((b, i) => {
        const u = (i - 3) / 3;
        const env = 1 - u * u * (round ? 0.9 : 0.5);
        b.scale.y = 0.15 + open * 4 * env * (0.85 + 0.15 * Math.sin(t * 20 + i));
        b.position.x = u * 0.3 * (1 + p.smile * 0.2 - (round ? 0.35 : 0));
        b.position.y = -0.25 + p.smile * 0.04 * u * u;
      });
      r.extra.tip.material.color.set(open > 0.15 ? '#FF5A4E' : '#FFB020');
    }
    // Damped spring on head turn for the sprout / antenna.
    if (r.extra.spring) {
      const s = this.spring;
      const vel = p.yaw - s.lastYaw; s.lastYaw = p.yaw;
      s.v += (-s.a * 0.12 - s.v * 0.18) - vel * 0.02;
      s.a += s.v;
      r.extra.spring.rotation.z = Math.max(-0.6, Math.min(0.6, s.a));
    }

    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
  }
}
