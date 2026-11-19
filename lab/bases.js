// The two waist-up bases new characters start from. Both are plain block trees, so every part
// can be moved, reshaped, recoloured or deleted in the lab. Metres, the waist cut at y = 0,
// facing +z (toward the camera, like Avatar Cam's toys).
//
// Roles wire the parts to the rig (rig.js): HEAD and BODY are siblings under the character,
// as in toys3d.js, and the face parts live inside HEAD so they turn with it.

const PI = Math.PI;
const blk = (shape, size, color, p, extra = {}) => ({
  shape,
  size,
  mat: { kind: 'lambert', color, ...(extra.mat ?? {}) },
  p,
  r: extra.r ?? [0, 0, 0],
  s: extra.s ?? [1, 1, 1],
  ...(extra.name ? { name: extra.name } : {}),
  ...(extra.role ? { role: extra.role } : {}),
});
const grp = (name, p, children, extra = {}) => ({ shape: 'group', name, p, r: extra.r ?? [0, 0, 0], s: extra.s ?? [1, 1, 1], ...(extra.role ? { role: extra.role } : {}), children });
const sph = (r, color, p, extra) => blk('sphere', { radius: r, widthSegments: 32, heightSegments: 20 }, color, p, extra);
const cap = (r, h, color, p, extra) => blk('capsule', { radius: r, height: h, capSegments: 8, radialSegments: 20 }, color, p, extra);
const tube = (rt, rb, h, color, p, extra) => blk('cylinder', { radiusTop: rt, radiusBottom: rb, height: h, radialSegments: 24 }, color, p, extra);
const WHITE = 0xf7f5f0;
const GLINT = 0xffffff;

/** a smile-shaped lip line: a torus arc inside a group centred on the curve, so flipping scale.y frowns */
function mouthLine(r, tube, color, p) {
  const arc = 0.6 * PI;
  return grp('Mouth', p, [blk('torus', { radius: r, tube, radialSegments: 10, tubularSegments: 32, arc }, color, [0, r * 0.8, 0], { r: [0, 0, -PI / 2 - arc / 2], name: 'Lip line' })], { role: 'mouth' });
}

// ---------- adult: realistic proportions (head ~1/7.5 of the full height) ----------
function adultEye(side) {
  const L = side < 0;
  return grp(L ? 'Eye L' : 'Eye R', [side * 0.034, 0.135, 0.086], [
    sph(0.0155, WHITE, [0, 0, 0], { s: [1.25, 0.82, 0.55], name: 'White' }),
    sph(0.0085, 'eye', [0, 0, 0.0065], { s: [1, 1, 0.5], name: 'Iris' }),
    sph(0.0042, 0x111111, [0, 0, 0.0095], { s: [1, 1, 0.5], name: 'Pupil' }),
    sph(0.0016, GLINT, [-0.002, 0.0025, 0.011], { name: 'Glint', mat: { kind: 'basic' } }),
  ], { role: L ? 'eyeL' : 'eyeR' });
}
function adultArm(side) {
  return grp(side < 0 ? 'Arm L' : 'Arm R', [side * 0.205, 0.43, 0], [
    cap(0.046, 0.17, 'top', [0, -0.11, 0], { name: 'Sleeve' }),
    cap(0.036, 0.2, 'skin', [0, -0.33, 0.015], { name: 'Forearm', r: [0.12, 0, 0] }),
  ], { r: [0, 0, side * 0.09] });
}
export function adultBase() {
  return grp('Character', [0, 0, 0], [
    grp('Body', [0, 0, 0], [
      tube(0.135, 0.128, 0.2, 'top', [0, 0.1, 0], { s: [1, 1, 0.66], name: 'Waist' }),
      cap(0.14, 0.2, 'top', [0, 0.3, 0], { s: [1.12, 1, 0.62], name: 'Torso' }),
      sph(0.058, 'top', [-0.19, 0.42, 0], { s: [1, 0.9, 0.95], name: 'Shoulder L' }),
      sph(0.058, 'top', [0.19, 0.42, 0], { s: [1, 0.9, 0.95], name: 'Shoulder R' }),
      tube(0.042, 0.047, 0.11, 'skin', [0, 0.515, 0], { name: 'Neck' }),
      tube(0.137, 0.137, 0.022, 'accent', [0, 0.012, 0], { s: [1, 1, 0.67], name: 'Belt' }),
      adultArm(-1),
      adultArm(1),
    ], { role: 'body' }),
    grp('Head', [0, 0.56, 0], [
      sph(0.1, 'skin', [0, 0.13, 0], { s: [0.86, 1.15, 0.98], name: 'Skull' }),
      blk('sphere', { radius: 0.108, widthSegments: 40, heightSegments: 24, thetaLength: 0.52 * PI }, 'hair', [0, 0.136, -0.008], { r: [-0.4, 0, 0], s: [0.93, 1.16, 1.05], name: 'Hair', mat: { double: true } }),
      sph(0.024, 'skin', [-0.088, 0.12, 0], { s: [0.45, 1, 0.75], name: 'Ear L' }),
      sph(0.024, 'skin', [0.088, 0.12, 0], { s: [0.45, 1, 0.75], name: 'Ear R' }),
      cap(0.011, 0.03, 'skin', [0, 0.108, 0.094], { r: [-0.35, 0, 0], name: 'Nose' }),
      adultEye(-1),
      adultEye(1),
      cap(0.0042, 0.026, 'ink', [-0.034, 0.161, 0.09], { r: [0, 0, PI / 2 + 0.06], name: 'Brow L', role: 'browL' }),
      cap(0.0042, 0.026, 'ink', [0.034, 0.161, 0.09], { r: [0, 0, PI / 2 - 0.06], name: 'Brow R', role: 'browR' }),
      sph(0.016, 0x3a1218, [0, 0.07, 0.087], { s: [1.3, 0.75, 0.45], name: 'Mouth open', role: 'jaw' }),
      mouthLine(0.022, 0.0036, 0x9a4848, [0, 0.07, 0.093]),
      sph(0.016, 0xe99a86, [-0.042, 0.09, 0.074], { s: [1.2, 0.8, 0.35], name: 'Cheek L', role: 'cheekL' }),
      sph(0.016, 0xe99a86, [0.042, 0.09, 0.074], { s: [1.2, 0.8, 0.35], name: 'Cheek R', role: 'cheekR' }),
    ], { role: 'head' }),
  ]);
}

// ---------- chibi: big head, small body, big joined eyes (a stylised mascot) ----------
function chibiEye(side) {
  const L = side < 0;
  return grp(L ? 'Eye L' : 'Eye R', [side * 0.058, 0.235, 0.158], [
    sph(0.05, WHITE, [0, 0, 0], { s: [0.78, 1.15, 0.42], name: 'White' }),
    sph(0.029, 'eye', [-side * 0.008, -0.004, 0.016], { s: [0.8, 1.1, 0.5], name: 'Iris' }),
    sph(0.015, 0x111111, [-side * 0.009, -0.004, 0.026], { s: [0.8, 1.1, 0.5], name: 'Pupil' }),
    sph(0.0065, GLINT, [-side * 0.002, 0.014, 0.03], { name: 'Glint', mat: { kind: 'basic' } }),
  ], { r: [0, side * 0.32, 0], role: L ? 'eyeL' : 'eyeR' });
}
function chibiArm(side) {
  return grp(side < 0 ? 'Arm L' : 'Arm R', [side * 0.095, 0.17, 0], [
    cap(0.024, 0.08, 'skin', [0, -0.055, 0], { name: 'Arm' }),
    sph(0.038, WHITE, [0, -0.125, 0.006], { s: [1, 0.95, 0.9], name: 'Mitten' }),
  ], { r: [0, 0, side * 0.55] });
}
export function chibiBase() {
  return grp('Character', [0, 0, 0], [
    grp('Body', [0, 0, 0], [
      tube(0.085, 0.1, 0.16, 'top', [0, 0.08, 0], { s: [1, 1, 0.82], name: 'Torso' }),
      sph(0.086, 'top', [0, 0.16, 0], { s: [1.05, 0.62, 0.85], name: 'Shoulders' }),
      sph(0.06, 'accent', [0, 0.09, 0.052], { s: [1, 1.15, 0.45], name: 'Belly' }),
      tube(0.035, 0.04, 0.05, 'skin', [0, 0.2, 0], { name: 'Neck' }),
      chibiArm(-1),
      chibiArm(1),
    ], { role: 'body' }),
    grp('Head', [0, 0.21, 0], [
      sph(0.19, 'hair', [0, 0.2, 0], { s: [1.06, 1, 0.96], name: 'Head' }),
      sph(0.135, 'skin', [0, 0.155, 0.075], { s: [1.15, 0.82, 0.78], name: 'Face' }),
      sph(0.075, 'skin', [0, 0.25, 0.115], { s: [1.5, 0.95, 0.6], name: 'Brow ridge' }),
      blk('cone', { radius: 0.058, height: 0.13, radialSegments: 20 }, 'hair', [-0.12, 0.37, -0.02], { r: [0, 0, 0.55], s: [1, 1, 0.55], name: 'Ear L' }),
      blk('cone', { radius: 0.058, height: 0.13, radialSegments: 20 }, 'hair', [0.12, 0.37, -0.02], { r: [0, 0, -0.55], s: [1, 1, 0.55], name: 'Ear R' }),
      blk('cone', { radius: 0.034, height: 0.085, radialSegments: 20 }, 'accent', [-0.116, 0.36, 0.003], { r: [0, 0, 0.55], s: [1, 1, 0.3], name: 'Ear inner L' }),
      blk('cone', { radius: 0.034, height: 0.085, radialSegments: 20 }, 'accent', [0.116, 0.36, 0.003], { r: [0, 0, -0.55], s: [1, 1, 0.3], name: 'Ear inner R' }),
      chibiEye(-1),
      chibiEye(1),
      cap(0.0065, 0.036, 'ink', [-0.06, 0.31, 0.162], { r: [0, -0.3, PI / 2 + 0.12], name: 'Brow L', role: 'browL' }),
      cap(0.0065, 0.036, 'ink', [0.06, 0.31, 0.162], { r: [0, 0.3, PI / 2 - 0.12], name: 'Brow R', role: 'browR' }),
      sph(0.019, 'ink', [0, 0.178, 0.205], { s: [1.3, 0.9, 0.9], name: 'Nose' }),
      sph(0.03, 0x3a1218, [0, 0.122, 0.19], { s: [1.25, 0.8, 0.45], name: 'Mouth open', role: 'jaw' }),
      mouthLine(0.034, 0.0055, 'ink', [0, 0.124, 0.198]),
      sph(0.026, 0xff8fa0, [-0.092, 0.15, 0.15], { s: [1.2, 0.75, 0.4], name: 'Cheek L', role: 'cheekL' }),
      sph(0.026, 0xff8fa0, [0.092, 0.15, 0.15], { s: [1.2, 0.75, 0.4], name: 'Cheek R', role: 'cheekR' }),
    ], { role: 'head' }),
  ]);
}

/** the built-in bases: a fresh copy of each every time */
export const BASES = [
  {
    id: 'adult',
    name: 'Adult',
    sub: 'Realistic proportions',
    palette: { skin: 0xe0a882, hair: 0x3b2a20, top: 0x3f6fb5, accent: 0xf2c14e, eye: 0x5a3b26, ink: 0x3a2620 },
    blueprint: adultBase,
  },
  {
    id: 'chibi',
    name: 'Chibi',
    sub: 'Big head, small body',
    palette: { skin: 0xffd9b8, hair: 0x6f5cff, top: 0xff6b6b, accent: 0xffd166, eye: 0x2f8f6f, ink: 0x22183a },
    blueprint: chibiBase,
  },
];
