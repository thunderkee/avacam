// Blocks: a character's design as a tree of simple shapes (box, ball, tube, ...).
// Adapted from the bdafighter Unit Lab (robot.ts blockGeometry / buildBlueprint):
// the same block format, so designs move between the two.
//
// Block: { shape, name?, size?, mat?: { kind, color, opacity?, double? }, p, r, s, role?, mesh?, children? }
// A colour is a palette slot name ('skin', 'hair', ...) or a fixed 0xRRGGBB number.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { meshGeometry } from './meshkit.js';

/** palette slots a block can take its colour from, so recolouring a character is one edit */
export const SLOTS = [
  { key: 'skin', label: 'Skin' },
  { key: 'hair', label: 'Hair' },
  { key: 'top', label: 'Clothes' },
  { key: 'accent', label: 'Accent' },
  { key: 'eye', label: 'Eyes (iris)' },
  { key: 'ink', label: 'Ink (brows, lips)' },
];

/** default size for a freshly added block of each shape (character scale: an adult head is ~0.2 m) */
export const DEFAULT_SIZE = {
  box: { width: 0.08, height: 0.08, depth: 0.08 },
  rbox: { width: 0.08, height: 0.08, depth: 0.08, segments: 3, radius: 0.015 },
  capsule: { radius: 0.03, height: 0.08, capSegments: 6, radialSegments: 16 },
  sphere: { radius: 0.05, widthSegments: 28, heightSegments: 18 },
  cylinder: { radiusTop: 0.03, radiusBottom: 0.03, height: 0.08, radialSegments: 20 },
  cone: { radius: 0.03, height: 0.08, radialSegments: 16 },
  torus: { radius: 0.05, tube: 0.012, radialSegments: 10, tubularSegments: 32 },
  mesh: { bevel: 0, smooth: 0 },
};

/** a tube with its top and bottom rims rounded off by `bevel` */
function bevelledTube(rt, rb, h, sides, bevel, segs) {
  const bv = Math.max(0.001, Math.min(bevel, rt - 0.001, rb - 0.001, h / 2 - 0.001));
  const n = Math.max(1, Math.round(segs));
  const pts = [new THREE.Vector2(0, -h / 2)];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / n);
    pts.push(new THREE.Vector2(rb - bv + bv * Math.cos(a), -h / 2 + bv + bv * Math.sin(a)));
  }
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI / 2) * (i / n);
    pts.push(new THREE.Vector2(rt - bv + bv * Math.cos(a), h / 2 - bv + bv * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(0, h / 2));
  return new THREE.LatheGeometry(pts, Math.max(3, Math.round(sides)));
}

export function blockGeometry(b) {
  const g = { ...(b.shape === 'group' ? {} : DEFAULT_SIZE[b.shape]), ...(b.size ?? {}) };
  switch (b.shape) {
    case 'rbox':
      return new RoundedBoxGeometry(g.width, g.height, g.depth, g.segments ?? 3, Math.min(g.radius ?? 0.015, Math.min(g.width, g.height, g.depth) / 2 - 0.001));
    case 'capsule':
      return new THREE.CapsuleGeometry(g.radius, g.height, g.capSegments ?? 6, g.radialSegments ?? 16);
    case 'sphere':
      return new THREE.SphereGeometry(g.radius, g.widthSegments ?? 28, g.heightSegments ?? 18, g.phiStart ?? 0, g.phiLength ?? Math.PI * 2, g.thetaStart ?? 0, g.thetaLength ?? Math.PI);
    case 'cylinder':
      if ((g.bevel ?? 0) > 0) return bevelledTube(g.radiusTop, g.radiusBottom, g.height, g.radialSegments ?? 20, g.bevel, g.bevelSegments ?? 2);
      return new THREE.CylinderGeometry(g.radiusTop, g.radiusBottom, g.height, g.radialSegments ?? 20, g.heightSegments ?? 1, !!g.openEnded, g.thetaStart ?? 0, g.thetaLength ?? Math.PI * 2);
    case 'mesh':
      return meshGeometry(b.mesh, g.bevel ?? 0, !!g.smooth);
    case 'cone':
      return new THREE.ConeGeometry(g.radius, g.height, g.radialSegments ?? 16, g.heightSegments ?? 1, !!g.openEnded, g.thetaStart ?? 0, g.thetaLength ?? Math.PI * 2);
    case 'torus':
      return new THREE.TorusGeometry(g.radius, g.tube, g.radialSegments ?? 10, g.tubularSegments ?? 32, g.arc ?? Math.PI * 2);
    default:
      return new THREE.BoxGeometry(g.width, g.height, g.depth);
  }
}

/** a block colour: a palette slot follows the character's colours, a number is fixed */
export function resolveColor(c, palette) {
  if (typeof c === 'number') return c;
  return palette[c] ?? 0xff00ff;
}

/**
 * Build the preview model from a design. Every object carries its block path in userData.path
 * ('r', 'r/0', 'r/0/3'), and its rest transform in userData.rest, so a pose can always go back to it.
 * Returns { root, parts } where parts maps each rig role to its object.
 */
export function buildModel(bp, palette) {
  const cache = new Map();
  const material = (m) => {
    const spec = m ?? { kind: 'lambert', color: 'skin' };
    const color = resolveColor(spec.color, palette);
    const key = `${spec.kind}|${color}|${spec.double ? 1 : 0}|${spec.opacity ?? 1}`;
    let mat = cache.get(key);
    if (!mat) {
      const common = {
        color,
        side: spec.double ? THREE.DoubleSide : THREE.FrontSide,
        transparent: (spec.opacity ?? 1) < 1,
        opacity: spec.opacity ?? 1,
        depthWrite: (spec.opacity ?? 1) >= 1,
      };
      // the same three finishes as the Unit Lab, tuned for skin and vinyl rather than armour
      if (spec.kind === 'basic') mat = new THREE.MeshBasicMaterial(common);
      else if (spec.kind === 'phong') mat = new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1 });
      else mat = new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4 });
      cache.set(key, mat);
    }
    return mat;
  };
  const parts = {};
  const make = (b, path) => {
    const o = b.shape === 'group' ? new THREE.Group() : new THREE.Mesh(blockGeometry(b), material(b.mat));
    o.position.fromArray(b.p);
    o.rotation.set(b.r[0], b.r[1], b.r[2]);
    o.scale.fromArray(b.s);
    o.userData.path = path;
    o.userData.rest = { p: o.position.clone(), r: o.rotation.clone(), s: o.scale.clone() };
    if (b.role) parts[b.role] ??= o;
    (b.children ?? []).forEach((c, i) => o.add(make(c, `${path}/${i}`)));
    return o;
  };
  const root = new THREE.Group();
  root.userData.path = 'r';
  root.userData.rest = { p: new THREE.Vector3(), r: new THREE.Euler(), s: new THREE.Vector3(1, 1, 1) };
  (bp.children ?? []).forEach((c, i) => root.add(make(c, `r/${i}`)));
  const dispose = () => {
    root.traverse((o) => o.geometry?.dispose());
    for (const m of cache.values()) m.dispose();
  };
  return { root, parts, dispose };
}
