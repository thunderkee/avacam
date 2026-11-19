// Blurb characters in 3D (three.js), assembled from their Blurb builder config
// (CharacterKit.STARTERS): same palette, skin tone, hair, eyes, mouth, outfit and extras.
// They sit beside the 2D Blurb characters in the cast; each entry carries its own `build`.
/* global CharacterKit */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { vinyl, ink, sphere, beadEye, makeMouth, addArms } from './toys3d.js';

/** Blurb starters with a 3D version. */
export const BLURB_3D = ['blurb', 'pip', 'mochi', 'jill', 'nina', 'marcus', 'rafi'];
export const blurb3DCast = () => BLURB_3D.map((id) => CharacterKit.STARTERS[id]).filter(Boolean)
  .map((cfg) => ({ id: `${cfg.id}-3d`, name: cfg.name, kind: 'toy', bg: cfg.thumbBg, cfg, build: () => buildFromBlurb(cfg) }));

const shade = (hex, k) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
const matte = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
const partSphere = (r, mat, { phiStart = 0, phiLength = Math.PI * 2, thetaStart = 0, thetaLength = Math.PI } = {}) =>
  new THREE.Mesh(new THREE.SphereGeometry(r, 56, 40, phiStart, phiLength, thetaStart, thetaLength), mat);
/** A sphere shell with its front (+z) window cut out, `a` radians either side of centre. */
const shellWithOpening = (r, mat, a, thetaLength = Math.PI) =>
  partSphere(r, mat, { phiStart: Math.PI / 2 + a, phiLength: Math.PI * 2 - a * 2, thetaLength });

/** A soft radial sprite (the Blurb heads' glow, and their floor shadow). */
function softSprite(color, alpha = 1) {
  const cv = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const c = new THREE.Color(color);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  g.addColorStop(0, `rgba(${rgb},${alpha})`); g.addColorStop(0.5, `rgba(${rgb},${alpha * 0.45})`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
}

/** Eyes by Blurb style. Returns a group; `userData.pupil` (if set) is what gaze moves. */
function eye3D(style, { ink: inkColor = '#2A2453', iris = '#111111', size = 1 } = {}) {
  const g = new THREE.Group();
  if (style === 'beads' || style === 'dot') { g.add(beadEye((style === 'dot' ? 0.075 : 0.12) * size, ink(inkColor))); return g; }
  const r = (style === 'doll' ? 0.16 : 0.17) * size;
  const ball = sphere(r, vinyl('#FFFFFF', { clearcoat: 0.8 })); ball.scale.z = 0.55; g.add(ball);
  const look = new THREE.Group(); look.position.z = r * 0.42;
  const irisR = style === 'doll' ? r * 0.78 : style === 'googly' && iris === '#111111' ? r * 0.5 : r * 0.62;
  const irisM = sphere(irisR, vinyl(style === 'doll' ? '#2B1A14' : iris, { roughness: 0.2 })); irisM.scale.z = 0.35; look.add(irisM);
  if (iris !== '#111111' && style !== 'doll') { const pupil = sphere(irisR * 0.5, ink('#111')); pupil.scale.z = 0.3; pupil.position.z = 0.02; look.add(pupil); }
  const glint = sphere(irisR * 0.3, new THREE.MeshBasicMaterial({ color: '#fff' }), 16, 12); glint.position.set(-irisR * 0.35, irisR * 0.4, 0.04); look.add(glint);
  if (style === 'doll') { const g2 = glint.clone(); g2.scale.setScalar(0.5); g2.position.set(irisR * 0.35, -irisR * 0.3, 0.04); look.add(g2); }
  g.add(look); g.userData.pupil = look; g.userData.travel = r * 0.35;
  return g;
}

function browMesh(color, thick = 0.04, len = 0.22) {
  const b = new THREE.Mesh(new THREE.CapsuleGeometry(thick, len, 6, 12), matte(color));
  b.rotation.z = Math.PI / 2;
  return b;
}

/** Rounded hexagon prism, flat top and bottom, facing the camera. */
function hexGeometry(radius = 1, depth = 0.55) {
  const shape = new THREE.Shape();
  const pts = Array.from({ length: 6 }, (_, k) => new THREE.Vector2(Math.cos((k * Math.PI) / 3) * radius, Math.sin((k * Math.PI) / 3) * radius));
  for (let k = 0; k < 6; k++) {
    const p = pts[k], a = p.clone().lerp(pts[(k + 5) % 6], 0.28), b = p.clone().lerp(pts[(k + 1) % 6], 0.28);
    k === 0 ? shape.moveTo(a.x, a.y) : shape.lineTo(a.x, a.y);
    shape.quadraticCurveTo(p.x, p.y, b.x, b.y);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.22, bevelSegments: 10, curveSegments: 16 });
  geo.center();
  return geo;
}

/** Floating head (Blurb's "Head" base): cloud, hexagon or bean, with glow. */
function buildHead3D(cfg, rig) {
  const pal = CharacterKit.HEAD_PALETTES[cfg.palette] || CharacterKit.HEAD_PALETTES.sky;
  const { head } = rig;
  const skin = vinyl(pal.base[1], { sheen: 0.4, sheenColor: new THREE.Color(pal.base[0]) });
  let faceZ = 0.85, eyeX = 0.36;
  const eyeY = 0.08, mouthY = -0.28;
  if (cfg.shape === 'hexagon') {
    head.add(new THREE.Mesh(hexGeometry(1.05), skin)); faceZ = 0.58; eyeX = 0.34;
  } else if (cfg.shape === 'bean') {
    const bean = new THREE.Mesh(new THREE.CapsuleGeometry(0.82, 0.5, 16, 40), skin);
    bean.rotation.z = Math.PI / 2; bean.scale.set(1.05, 1, 0.85); head.add(bean); faceZ = 0.68; eyeX = 0.38;
  } else {
    // cloud: one big puff in front, smaller puffs around it
    const main = sphere(1, skin); main.scale.set(1.12, 0.88, 0.85); head.add(main);
    for (const [x, y, r] of [[-0.88, -0.12, 0.58], [0.88, -0.12, 0.58], [-0.45, 0.52, 0.6], [0.42, 0.58, 0.64], [0, -0.42, 0.66]]) {
      const puff = sphere(r, skin); puff.position.set(x, y, -0.05); puff.scale.z = 0.85; head.add(puff);
    }
  }
  const glow = softSprite(pal.glow[0], 0.9); glow.position.set(0, 0, -1.4); glow.scale.set(4.4, 4.4, 1); head.add(glow);
  rig.extra.glow = glow;
  const shadow = softSprite('#000000', 0.22); shadow.position.set(0, -1.45, -0.5); shadow.scale.set(2.4, 0.5, 1); rig.root.add(shadow);

  for (const s of [-1, 1]) {
    const e = eye3D(cfg.eyes, { ink: cfg.inkColor, size: cfg.eyes === 'googly' ? 1.15 : 1 });
    e.position.set(s * eyeX, eyeY, faceZ - 0.02); head.add(e); rig.eyes.push(e);
    if (cfg.brows !== 'none') { const b = browMesh(pal.brow, 0.03, 0.16); b.position.set(s * eyeX, eyeY + 0.3, faceZ - 0.04); head.add(b); rig.brows.push(b); }
    if (cfg.extras?.includes('blush')) {
      const blush = sphere(0.14, new THREE.MeshStandardMaterial({ color: pal.glow[1], transparent: true, opacity: 0.6 }));
      blush.scale.set(1.4, 0.7, 0.2); blush.position.set(s * (eyeX + 0.22), eyeY - 0.24, faceZ - 0.08); head.add(blush);
    }
  }
  rig.mouth = makeMouth(cfg.mouth === 'cat' ? 0.26 : 0.3, cfg.inkColor, { cat: cfg.mouth === 'cat', inside: pal.socket });
  rig.mouth.g.position.set(0, mouthY, faceZ + 0.02); head.add(rig.mouth.g);

  if (cfg.extras?.includes('bow')) {
    const bow = new THREE.Group(); bow.position.set(0.62, 0.72, 0.1); bow.rotation.z = -0.45;
    const fabric = vinyl(cfg.extraColor);
    for (const s of [-1, 1]) { const lobe = sphere(0.24, fabric); lobe.scale.set(1.25, 0.8, 0.5); lobe.position.x = s * 0.24; lobe.rotation.z = s * 0.25; bow.add(lobe); }
    const knot = sphere(0.11, vinyl(shade(cfg.extraColor, 0.85))); knot.position.z = 0.05; bow.add(knot);
    head.add(bow); rig.extra.spring = bow;
  }
  head.position.y = 0;
  head.scale.setScalar(cfg.shape === 'cloud' ? 0.98 : 1.12);
  rig.locked = true; // blob heads stay in the centre of the frame
}

/** Half-body person (Blurb's "Character" and "Flat" bases), with sleeved arms. */
function buildPerson3D(cfg, rig) {
  const { head, body } = rig;
  const flat = cfg.base === 'flat';
  const tone = flat ? null : CharacterKit.SKIN_TONES[cfg.skin] || CharacterKit.SKIN_TONES.rose;
  const skinColor = flat ? (CharacterKit.FLAT_SKIN[cfg.skin] || ['#F7D5BE'])[0] : tone.ball[1];
  const skin = vinyl(skinColor, { clearcoat: 0.25, roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color('#ffd9c9') });
  const hairM = matte(cfg.hairColor);
  const hatM = vinyl(cfg.hatColor || cfg.hairColor, { clearcoat: 0.2, roughness: 0.6 });

  // Head and features (head radius ≈ 1, face toward +z)
  let skull;
  if (cfg.face === 'square') skull = new THREE.Mesh(new RoundedBoxGeometry(1.8, 2, 1.7, 8, 0.55), skin);
  else { skull = sphere(1, skin); skull.scale.set(cfg.face === 'oval' ? 0.9 : 0.95, cfg.face === 'oval' ? 1.06 : 1.0, 0.95); }
  head.add(skull);
  const faceZ = 0.9;
  const hijab = cfg.hair === 'fHijab';
  if (!hijab) for (const s of [-1, 1]) {
    const ear = sphere(0.2, vinyl(flat ? shade(skinColor, 0.92) : tone.ear, { clearcoat: 0.2 })); ear.scale.set(0.5, 1, 0.7);
    ear.position.set(s * 0.92, -0.02, -0.05); head.add(ear);
  }
  const noseColor = flat ? shade(skinColor, 0.85) : tone.ball[2];
  if (cfg.nose === 'triangle') { const n = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.2, 3), vinyl(noseColor)); n.position.set(0, -0.12, faceZ + 0.04); n.rotation.x = 0.35; head.add(n); }
  else { const n = sphere(0.12, vinyl(noseColor, { clearcoat: 0.3 })); n.scale.set(1.1, 0.9, 0.9); n.position.set(0, -0.14, faceZ + 0.03); head.add(n); }

  const browColor = shade(cfg.hairColor, cfg.hairColor === '#E2B464' ? 0.7 : 1);
  for (const s of [-1, 1]) {
    const e = eye3D(cfg.eyes, { iris: cfg.irisColor, size: cfg.eyes === 'dot' ? 1.2 : 0.95 });
    e.position.set(s * 0.34, 0.08, faceZ - 0.05); head.add(e); rig.eyes.push(e);
    const b = browMesh(browColor, cfg.brows === 'bold' ? 0.05 : 0.042, 0.2);
    b.position.set(s * 0.34, 0.37, faceZ - 0.02); b.rotation.z += s * -0.08; head.add(b); rig.brows.push(b);
  }
  const lip = cfg.lipColor || '#B8645F';
  rig.mouth = makeMouth(cfg.mouth === 'small' ? 0.2 : 0.26, shade(lip, 0.8), { inside: '#4A1A1F' });
  rig.mouth.g.position.set(0, -0.44, faceZ - 0.06); head.add(rig.mouth.g);

  // Hair / headwear
  if (cfg.hair === 'fWavy') {
    head.add(partSphere(1.07, hairM, { thetaLength: Math.PI * 0.3 }));
    const back = sphere(1.12, hairM); back.scale.set(1.08, 1.3, 0.75); back.position.set(0, -0.35, -0.35); head.add(back);
    for (const s of [-1, 1]) { const side = sphere(0.42, hairM); side.scale.set(0.62, 1.75, 0.85); side.position.set(s * 0.93, -0.55, 0.0); head.add(side); }
    const bangs = sphere(0.5, hairM); bangs.scale.set(1.35, 0.38, 0.55); bangs.position.set(-0.22, 0.76, 0.6); bangs.rotation.z = 0.28; head.add(bangs);
    const bangs2 = sphere(0.4, hairM); bangs2.scale.set(1.1, 0.35, 0.5); bangs2.position.set(0.42, 0.78, 0.55); bangs2.rotation.z = -0.35; head.add(bangs2);
  } else if (hijab) {
    const wrap = shellWithOpening(1.16, hatM, 0.92); wrap.scale.set(1, 1.06, 1); wrap.material.side = THREE.DoubleSide; head.add(wrap);
    const crown = partSphere(1.17, hatM, { thetaLength: Math.PI * 0.27 }); crown.scale.set(1, 1.06, 1); head.add(crown);
    const chin = partSphere(1.17, hatM, { thetaStart: Math.PI * 0.8, thetaLength: Math.PI * 0.2 }); chin.scale.set(1, 1.06, 1); head.add(chin);
    // A shawl turned from a profile: snug at the neck, flaring over the shoulders.
    const profile = [[0.5, 0.42], [0.58, 0.15], [0.78, -0.12], [1.12, -0.38], [1.38, -0.58], [1.42, -0.7], [1.3, -0.74]].map(([x, y]) => new THREE.Vector2(x, y));
    const drape = new THREE.Mesh(new THREE.LatheGeometry(profile, 64), hatM);
    drape.scale.set(1, 1, 0.8); drape.position.y = -1.18; body.add(drape);
  } else if (cfg.hair === 'fQuiff') {
    head.add(partSphere(1.05, hairM, { thetaLength: Math.PI * 0.34 }));
    head.add(shellWithOpening(1.03, hairM, 1.25, Math.PI * 0.55));
    const quiff = sphere(0.45, hairM); quiff.scale.set(1.35, 0.6, 0.85); quiff.position.set(0.1, 0.9, 0.42); quiff.rotation.x = -0.5; head.add(quiff);
  } else if (cfg.hair === 'baseball') {
    const capY = cfg.face === 'square' ? 0.36 : 0.22;
    const dome = partSphere(1.08, hatM, { thetaLength: Math.PI * 0.5 }); dome.position.y = capY;
    if (cfg.face === 'square') dome.scale.set(1.16, 0.98, 1.14); else dome.scale.set(1, 0.95, 1);
    head.add(dome);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.07, 48, 1, false, -Math.PI / 2, Math.PI), hatM);
    brim.scale.set(1.35, 1, 1); brim.position.set(0, capY + 0.02, cfg.face === 'square' ? 0.98 : 0.9); brim.rotation.x = 0.12; head.add(brim);
    const button = sphere(0.08, hatM); button.position.y = capY + 1.05; head.add(button);
    for (const s of [-1, 1]) { const burn = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.35, 0.3, 3, 0.06), hairM); burn.position.set(s * 0.9, -0.05, 0.25); head.add(burn); }
  }

  // Extras
  if (cfg.extras?.includes('beard')) {
    const beard = partSphere(1.05, hairM, { thetaStart: Math.PI * 0.69, thetaLength: Math.PI * 0.31 }); beard.scale.set(0.98, 1.05, 1); head.add(beard);
    head.add(partSphere(1.03, hairM, { phiStart: Math.PI / 2 + 0.95, phiLength: Math.PI * 2 - 1.9, thetaStart: Math.PI * 0.45, thetaLength: Math.PI * 0.3 }));
  }
  if (cfg.extras?.includes('mustache')) {
    const m = new THREE.Group(); m.position.set(0, -0.31, faceZ + 0.05);
    for (const s of [-1, 1]) { const half = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.18, 6, 12), matte(cfg.extraColor)); half.rotation.z = Math.PI / 2 + s * 0.35; half.position.set(s * 0.12, -0.02, 0); m.add(half); }
    head.add(m);
  }
  if (cfg.extras?.includes('glasses')) {
    const frame = new THREE.MeshStandardMaterial({ color: cfg.extraColor, roughness: 0.3, metalness: 0.2 });
    for (const s of [-1, 1]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.028, 12, 40), frame); rim.position.set(s * 0.34, 0.08, faceZ + 0.08); head.add(rim);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.85), frame); arm.rotation.x = Math.PI / 2; arm.position.set(s * 0.6, 0.1, 0.5); arm.rotation.y = s * 0.25; head.add(arm);
    }
    const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.22), frame); bridge.rotation.z = Math.PI / 2; bridge.position.set(0, 0.12, faceZ + 0.1); head.add(bridge);
  }

  // Neck, outfit and arms (sleeves in the outfit colour, hands in skin)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.38, 0.8, 32), skin); neck.position.y = -1.05; body.add(neck); rig.neckY = -0.7;
  const cloth = vinyl(cfg.outfitColor, { clearcoat: 0.15, roughness: 0.7 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.7, 1.6, 16, 40), cloth); torso.scale.set(1.9, 1, 0.78); torso.position.y = -2.85; body.add(torso);
  const front = 0.7 * 0.78;
  if (cfg.outfit === 'cardigan') {
    const inner = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.2, 8, 20), vinyl('#F6F0E6', { roughness: 0.8 })); inner.scale.z = 0.3; inner.position.set(0, -1.95, front - 0.02); body.add(inner);
    for (let i = 0; i < 3; i++) { const btn = sphere(0.045, vinyl(shade(cfg.outfitColor, 0.7))); btn.position.set(0.25, -1.75 - i * 0.28, front + 0.02); body.add(btn); }
  } else if (cfg.outfit === 'hoodie') {
    const hood = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.2, 16, 40), cloth); hood.rotation.x = Math.PI / 2 - 0.25; hood.position.set(0, -1.32, -0.12); body.add(hood);
    for (const s of [-1, 1]) { const str = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5), vinyl('#F6F0E6')); str.position.set(s * 0.18, -1.7, front + 0.03); body.add(str); }
  } else if (cfg.outfit === 'bomber') {
    const rib = vinyl(cfg.outfitColor2 || '#F4F1EC', { roughness: 0.8 });
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.1, 12, 40), rib); collar.rotation.x = Math.PI / 2; collar.position.y = -1.32; body.add(collar);
    const zip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.2, 0.03), new THREE.MeshStandardMaterial({ color: '#C9C9C9', metalness: 0.6, roughness: 0.3 })); zip.position.set(0, -2.0, front + 0.02); body.add(zip);
  }
  addArms(rig, { x: 1.12, y: -1.55, upper: 0.95, lower: 0.88, r: 0.17, mat: cloth,
    hand: () => { const h = sphere(0.2, skin); h.scale.set(0.95, 1.05, 0.8); return h; } });
  head.position.y = 0.2;
}

function buildFromBlurb(cfg) {
  const root = new THREE.Group(), head = new THREE.Group(), body = new THREE.Group();
  root.add(body, head);
  const rig = { root, head, body, eyes: [], brows: [], ears: [], mouth: null, extra: {} };
  if (cfg.base === 'head') buildHead3D(cfg, rig);
  else buildPerson3D(cfg, rig);
  return rig;
}
