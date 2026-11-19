import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DEFAULT_SIZE, SLOTS, blockGeometry, buildModel, resolveColor } from './blocks.js';
import { BASES } from './bases.js';
import { MIRROR_ROLE, NEUTRAL, ROLES, ROLE_LABEL, applyPose, previewPose, restPose } from './rig.js';
import { edgesOf, extrudeFaces, fromGeometry, meshGeometry, prism, triangulate } from './meshkit.js';

// Character Lab: build waist-up characters for Avatar Cam out of simple shapes, on an adult or a
// chibi base, and preview them blinking, smiling, frowning and talking.
//
// Adapted from the bdafighter Unit Lab (marble-fighter/src/lab.ts): the same block tree, layers,
// gizmo and free-drag editing, shape edit mode, draw tool, palette and undo. Units became
// characters, gameplay traits gave way to the rig, and the animate toggle to the expression preview.

const $ = (id) => document.getElementById(id);
const clone = (v) => JSON.parse(JSON.stringify(v));
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const r2 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const DEG = 180 / Math.PI;

// ---------- state ----------
/** this device's characters: edits to the bases, and new characters */
const STORE_KEY = 'avatar-cam:lab:v1';
const LAST_KEY = 'avatar-cam:lab:last';
function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? '');
    if (parsed && typeof parsed.chars === 'object') return parsed;
  } catch {
    // nothing saved yet, or storage is blocked
  }
  return { chars: {} };
}
function saveStore(data) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
const roster = loadStore();
const isBase = (id) => BASES.some((b) => b.id === id);
const baseOf = (id) => BASES.find((b) => b.id === id) ?? BASES[0];

/** a character as the lab shows it: its base, with this device's edits on top */
function charById(id) {
  const e = roster.chars[id];
  const base = baseOf(e?.base ?? id);
  return {
    id: e || isBase(id) ? id : base.id,
    base: base.id,
    name: e?.name ?? base.name,
    palette: { ...base.palette, ...(e?.palette ?? {}) },
    blueprint: e?.blueprint,
  };
}
const allChars = () => [...BASES.map((b) => charById(b.id)), ...Object.keys(roster.chars).filter((id) => !isBase(id)).map(charById)];

let currentId = (() => {
  try {
    const id = localStorage.getItem(LAST_KEY);
    if (id && (isBase(id) || roster.chars[id])) return id;
  } catch {
    // start on the first base
  }
  return BASES[0].id;
})();
/** working design for the current character; linked into the roster on the first edit */
let draft = { shape: 'group', p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
/** the block the form shows (the last one picked) */
let selected = null;
/** every selected block, `selected` included */
let selection = [];
let undo = [];
let redo = [];
/** shape edit mode: picking and moving one mesh block's points, edges or faces ({ path, mode, sel }) */
let edit = null;

const def = () => charById(currentId);
const entry = () => (roster.chars[currentId] ??= { id: currentId, base: def().base });

/** a fresh design for the current character: its saved one, or its base's */
function loadDraft() {
  const d = def();
  draft = d.blueprint ?? baseOf(d.base).blueprint();
}

// ---------- save + undo ----------
let saveTimer = 0;
const status = $('status');
function scheduleSave() {
  status.textContent = 'Saving…';
  status.classList.add('dirty');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 300);
}
/** each character as this page last read or wrote it, so a save only touches the ones edited here */
const savedAs = new Map(Object.entries(roster.chars).map(([id, c]) => [id, JSON.stringify(c)]));
/**
 * the device's characters with this page's edits merged in: characters this page changed (or
 * removed) are written, everything else is kept as storage has it now, so a Lab left open in
 * another tab can't write old copies back over newer work
 */
function mergedStore() {
  const fresh = loadStore();
  for (const id of new Set([...Object.keys(roster.chars), ...savedAs.keys()])) {
    const now = roster.chars[id] ? JSON.stringify(roster.chars[id]) : undefined;
    if (now === savedAs.get(id)) continue;
    if (now) fresh.chars[id] = roster.chars[id];
    else delete fresh.chars[id];
    if (now) savedAs.set(id, now);
    else savedAs.delete(id);
  }
  return fresh;
}
function flushSave() {
  clearTimeout(saveTimer);
  const ok = saveStore(mergedStore());
  try {
    localStorage.setItem(LAST_KEY, currentId);
  } catch {
    // not remembered
  }
  status.textContent = ok ? 'Saved' : 'Storage full!';
  status.classList.toggle('dirty', !ok);
}

const snapshot = () => JSON.stringify({ char: roster.chars[currentId] ?? null, draft, selected, selection, edit });
let lastUndoKey = '';
let lastUndoAt = 0;
/** remember the state before a change; rapid edits to one field count as one step */
function pushUndo(key = '') {
  const now = performance.now();
  if (key && key === lastUndoKey && now - lastUndoAt < 900) {
    lastUndoAt = now;
    return;
  }
  undo.push(snapshot());
  if (undo.length > 120) undo.shift();
  redo = [];
  lastUndoKey = key;
  lastUndoAt = now;
  syncUndoButtons();
}
function restore(snap) {
  const s = JSON.parse(snap);
  if (s.char) roster.chars[currentId] = s.char;
  else delete roster.chars[currentId];
  // keep the draft and the saved design the same object once linked
  draft = s.char?.blueprint ?? s.draft;
  selected = s.selected;
  selection = s.selection ?? (s.selected ? [s.selected] : []);
  const e = s.edit ?? null;
  edit = e && getBlock(e.path)?.shape === 'mesh' ? e : null;
  lastUndoKey = '';
  syncEditBar();
  commit(true);
}
function stepHistory(from, to) {
  const snap = from.pop();
  if (!snap) return;
  to.push(snapshot());
  restore(snap);
  syncUndoButtons();
}
/** undo / redo live in the top bar and on the canvas toolbar; both pairs stay in sync */
const undoBtns = ['undo', 'canvas-undo'].map($);
const redoBtns = ['redo', 'canvas-redo'].map($);
function syncUndoButtons() {
  undoBtns.forEach((b) => (b.disabled = !undo.length));
  redoBtns.forEach((b) => (b.disabled = !redo.length));
}
undoBtns.forEach((b) => b.addEventListener('click', () => stepHistory(undo, redo)));
redoBtns.forEach((b) => b.addEventListener('click', () => stepHistory(redo, undo)));

/** apply edits everywhere: preview, lists, and (optionally) the open form */
function commit(full = false) {
  scheduleSave();
  rebuildPreview();
  renderRoster();
  renderTree();
  renderRig();
  if (full) {
    renderProfile();
    renderPalette();
    renderForm();
  }
}

/** the design changed: make sure the character owns it, then refresh */
function designChanged(full = false) {
  entry().blueprint = draft;
  commit(full);
}

// ---------- block paths ('r', 'r/0', 'r/0/3') ----------
const getBlock = (path) => {
  let b = draft;
  for (const i of path.split('/').slice(1).map(Number)) b = b?.children?.[i];
  return b ?? null;
};
const parentPath = (path) => path.slice(0, path.lastIndexOf('/'));
const indexIn = (path) => Number(path.slice(path.lastIndexOf('/') + 1));
/** the path a block lives at now (after a move) */
function pathOf(target) {
  const walk = (b, path) => {
    if (b === target) return path;
    for (let i = 0; i < (b.children?.length ?? 0); i++) {
      const hit = walk(b.children[i], `${path}/${i}`);
      if (hit) return hit;
    }
    return null;
  };
  return walk(draft, 'r');
}
/** the path of the block with this rig role, if the design has one */
function rolePath(role) {
  const find = (b, path) => {
    if (b.role === role) return path;
    for (let i = 0; i < (b.children?.length ?? 0); i++) {
      const hit = find(b.children[i], `${path}/${i}`);
      if (hit) return hit;
    }
    return null;
  };
  return find(draft, 'r');
}
/** selected blocks without the ones already inside another selected block */
const topLevel = (paths) => paths.filter((p) => p !== 'r' && !paths.some((q) => q !== p && (q === 'r' || p.startsWith(q + '/'))));
/** sort deepest / last first, so removing one never shifts the paths of the rest */
const removalOrder = (paths) =>
  [...paths].sort((a, b) => {
    const pa = a.split('/').map(Number);
    const pb = b.split('/').map(Number);
    for (let i = 1; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return pb.length - pa.length;
  });
/** a block's transform in the character's space, from the design itself (never the posed preview) */
function blockMatrix(path) {
  const m = new THREE.Matrix4();
  let b = draft;
  for (const i of path.split('/').slice(1).map(Number)) {
    b = b.children[i];
    m.multiply(new THREE.Matrix4().compose(new THREE.Vector3().fromArray(b.p), new THREE.Quaternion().setFromEuler(new THREE.Euler(b.r[0], b.r[1], b.r[2])), new THREE.Vector3().fromArray(b.s)));
  }
  return m;
}

// ---------- 3D preview ----------
const viewEl = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewEl.appendChild(renderer.domElement);
const scene = new THREE.Scene();
{
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
}
scene.environmentIntensity = 0.55;
// the same key + rim as Avatar Cam's toy stage, so characters look here as they will there
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f99, 1.3));
const key = new THREE.DirectionalLight(0xffffff, 2);
key.position.set(-2, 3, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0xffd8ff, 1.1);
rim.position.set(3, 1, -2);
scene.add(rim);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 30);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.4, 0);
controls.enableDamping = true;
controls.minDistance = 0.25;
controls.maxDistance = 6;
// the waist cut: a disc under the character
const pad = new THREE.Mesh(new THREE.CircleGeometry(0.42, 48), new THREE.MeshLambertMaterial({ color: 0x14254a }));
pad.rotation.x = -Math.PI / 2;
pad.position.y = -0.002;
scene.add(pad);
const grid = new THREE.GridHelper(0.84, 21, 0x3ef0ff, 0x1d3a66);
grid.material.opacity = 0.35;
grid.material.transparent = true;
scene.add(grid);
// a marker for the character's front (it faces the camera, +z)
const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.003, 0.3), 0.12, 0xffc23d, 0.045, 0.03);
scene.add(arrow);

/** directions to look from; the distance fits the character (or its head) to the view */
const CAMS = {
  front: [0, 0.12, 1],
  side: [1, 0.12, 0],
  back: [0, 0.2, -1],
  angle: [0.62, 0.28, 0.82],
  face: [0.18, 0.06, 1],
};
let camName = 'angle';
function setCam(name) {
  camName = name;
  let c = new THREE.Vector3(0, 0.4, 0);
  let half = 0.45;
  if (model) {
    restPose(model);
    const target = name === 'face' && model.parts.head ? model.parts.head : model.root;
    const box = new THREE.Box3().setFromObject(target);
    if (!box.isEmpty()) {
      c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      // narrow viewports need the camera further back to fit the width
      // (with room for the toolbars over the top and bottom of the view)
      half = Math.max(size.y / 2, Math.max(size.x, size.z) / 2 / Math.max(0.3, camera.aspect)) * (name === 'face' ? 2.1 : 1.45);
      c.y += half * 0.06;
    }
  }
  const dist = half / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.copy(c).addScaledVector(new THREE.Vector3(...CAMS[name]).normalize(), dist);
  controls.target.copy(c);
  controls.update();
}
document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam)));
document.querySelectorAll('[data-gizmo]').forEach((b) => b.addEventListener('click', () => setGizmoMode(b.dataset.gizmo)));

// ---------- expression preview ----------
/** which preview runs: neutral (still), blink, smile, frown, talk, turn, loop, or manual (the Rig sliders) */
let expr = 'neutral';
let exprT = 0;
const manual = { smile: 0, frown: 0, blinkL: 0, jaw: 0, viseme: 'A', yaw: 0, pitch: 0, browL: 0, browR: 0 };
const mouthState = {};
function setExpr(mode) {
  // pressing the running preview again stops it
  expr = mode === expr && mode !== 'neutral' && mode !== 'manual' ? 'neutral' : mode;
  exprT = 0;
  document.querySelectorAll('[data-expr]').forEach((b) => b.classList.toggle('on', b.dataset.expr === expr));
}
document.querySelectorAll('[data-expr]').forEach((b) => b.addEventListener('click', () => setExpr(b.dataset.expr)));

let model = null;
let helpers = [];
function rebuildPreview() {
  if (model) {
    scene.remove(model.root);
    model.dispose();
  }
  model = buildModel(draft, def().palette);
  scene.add(model.root);
  updateHelper();
}

/** the preview object built from the block at `path` */
function objOf(path) {
  if (!model) return null;
  let hit = null;
  model.root.traverse((o) => {
    if (!hit && o.userData.path === path) hit = o;
  });
  return hit;
}

// on-canvas gizmo: drag the arrows / rings / boxes to move, rotate or scale the selected block(s)
const gizmo = new TransformControls(camera, renderer.domElement);
// bigger handles for fingers
gizmo.setSize(window.matchMedia('(pointer: coarse)').matches ? 1.5 : 1.1);
gizmo.setSpace('local');
// no free 'trackball' sphere over the block: dragging the block itself rotates it predictably
gizmo.showXYZE = false;
// the rings turn fast, so snap to clean steps: 5 degrees, and scale in 0.05s
// (snap is applied before slowing the rings to 40%, so 12.5 here lands on 5-degree steps)
gizmo.setRotationSnap(THREE.MathUtils.degToRad(12.5));
gizmo.setScaleSnap(0.05);
scene.add(gizmo.getHelper());
/** with several blocks selected the gizmo drives this stand-in at their centre */
const pivot = new THREE.Object3D();
scene.add(pivot);
/** in edit mode the gizmo drives this stand-in at the picked points' centre (a child of the mesh) */
const editPivot = new THREE.Object3D();
let gizmoUsed = false;
function setGizmoMode(mode) {
  gizmo.setMode(mode);
  // the two-axis squares would catch drags on the block in scale mode and stretch it unevenly
  const planes = mode === 'translate';
  gizmo.showXY = gizmo.showYZ = gizmo.showXZ = planes;
  document.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('on', b.dataset.gizmo === mode));
}
gizmo.addEventListener('dragging-changed', (e) => {
  const dragging = !!e.value;
  controls.enabled = !dragging;
  if (dragging) {
    gizmoUsed = true;
    pushUndo();
  } else {
    // the drag is done: rebuild from the edited block(s) and refresh the form
    designChanged(true);
    updateHelper();
  }
});
/** copy a dragged object's transform into its block */
function writeBlockAt(path, o) {
  const b = path ? getBlock(path) : null;
  if (!b || !o) return;
  b.p = [r2(o.position.x), r2(o.position.y), r2(o.position.z)];
  b.r = [r2(o.rotation.x), r2(o.rotation.y), r2(o.rotation.z)];
  b.s = [r2(o.scale.x), r2(o.scale.y), r2(o.scale.z)];
}

// moving several blocks: remember where each one and the pivot started, then carry them along
let multi = null;
// moving points: remember the mesh's points and the edit pivot at the start
let editStart = null;
function beginDrag() {
  multi = null;
  editStart = null;
  const o = gizmo.object;
  if (o === pivot) {
    pivot.updateMatrixWorld();
    multi = {
      pivotInv: pivot.matrixWorld.clone().invert(),
      items: topLevel(selection)
        .map((path) => ({ path, obj: objOf(path) }))
        .filter((i) => !!i.obj)
        .map((i) => ({ ...i, world: i.obj.matrixWorld.clone() })),
    };
  } else if (o === editPivot && edit) {
    const b = getBlock(edit.path);
    if (!b?.mesh) return;
    editPivot.updateMatrix();
    editStart = { v: [...b.mesh.v], inv: editPivot.matrix.clone().invert(), verts: editVerts() };
  }
}
/** write whatever the gizmo (or a free drag) just moved back into the design */
function applyDrag(o) {
  if (o === pivot && multi) {
    pivot.updateMatrixWorld();
    const delta = pivot.matrixWorld.clone().multiply(multi.pivotInv);
    for (const it of multi.items) {
      const w = delta.clone().multiply(it.world);
      const local = it.obj.parent ? it.obj.parent.matrixWorld.clone().invert().multiply(w) : w;
      local.decompose(it.obj.position, it.obj.quaternion, it.obj.scale);
      writeBlockAt(it.path, it.obj);
    }
  } else if (o === editPivot && edit && editStart) {
    const b = getBlock(edit.path);
    if (!b?.mesh) return;
    editPivot.updateMatrix();
    const delta = editPivot.matrix.clone().multiply(editStart.inv);
    const p = new THREE.Vector3();
    for (const i of editStart.verts) {
      p.fromArray(editStart.v, i * 3).applyMatrix4(delta);
      b.mesh.v[i * 3] = r4(p.x);
      b.mesh.v[i * 3 + 1] = r4(p.y);
      b.mesh.v[i * 3 + 2] = r4(p.z);
    }
    // reshape the live mesh without rebuilding the whole character
    const mesh = objOf(edit.path);
    if (mesh?.isMesh) {
      mesh.geometry.dispose();
      mesh.geometry = blockGeometry(b);
    }
    drawEditOverlay();
  } else writeBlockAt(selected, o);
}
// the stock rings turn very fast: keep 40% of each drag's turn, measured from where it started
const RING_SPEED = 0.4;
let ringStart = null;
gizmo.addEventListener('mouseDown', () => {
  ringStart = gizmo.getMode() === 'rotate' && gizmo.object ? gizmo.object.quaternion.clone() : null;
  beginDrag();
});
gizmo.addEventListener('mouseUp', () => (ringStart = null));
gizmo.addEventListener('objectChange', () => {
  const o = gizmo.object;
  if (!o) return;
  if (ringStart && gizmo.getMode() === 'rotate') {
    const delta = ringStart.clone().invert().multiply(o.quaternion);
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    const angle = 2 * Math.acos(Math.min(1, delta.w));
    const sin = Math.sqrt(Math.max(0, 1 - delta.w * delta.w));
    if (angle > 1e-6 && sin > 1e-6) {
      const axis = new THREE.Vector3(delta.x / sin, delta.y / sin, delta.z / sin);
      o.quaternion.copy(ringStart).multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle * RING_SPEED));
    }
  }
  applyDrag(o);
});

function updateHelper() {
  for (const h of helpers) {
    scene.remove(h);
    h.dispose();
  }
  helpers = [];
  gizmo.detach();
  if (!model || draw) return;
  if (edit) {
    attachEdit();
    return;
  }
  const objs = selection.filter((p) => p !== 'r').map(objOf).filter((o) => !!o);
  for (const o of objs) {
    const h = new THREE.BoxHelper(o, 0xffd23e);
    scene.add(h);
    helpers.push(h);
  }
  if (objs.length === 1) gizmo.attach(objs[0]);
  else if (objs.length > 1) {
    const box = new THREE.Box3();
    objs.forEach((o) => box.expandByObject(o));
    pivot.position.copy(box.getCenter(new THREE.Vector3()));
    pivot.quaternion.identity();
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld();
    gizmo.attach(pivot);
  }
}

// click (not drag) on a block selects it; dragging a selected block itself
// moves / rotates / scales the selection with the active tool (no need to hit a handle)
let downAt = null;
/** a press on the canvas: the character goes back to its modelled pose until it ends, so edits land on the design */
let holding = false;
const ray = new THREE.Raycaster();
const ndcAt = (x, y) => {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
};
const shown = (o) => {
  for (let n = o; n; n = n.parent) if (!n.visible) return false;
  return true;
};
const pick = (x, y) => {
  if (!model) return null;
  ray.setFromCamera(ndcAt(x, y), camera);
  return ray.intersectObject(model.root, true).find((h) => h.object.isMesh && h.object.userData.path && shown(h.object)) ?? null;
};
let free = null;
const isInside = (o, root) => {
  for (let n = o; n; n = n.parent) if (n === root) return true;
  return false;
};

// (capture: runs before the gizmo reads the selected block's transform)
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.target !== renderer.domElement || !model || !selection.length) return;
    holding = true;
    restPose(model);
    model.root.updateMatrixWorld(true);
  },
  true,
);
renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  gizmoUsed = false;
  if (edit || draw) return;
  const obj = gizmo.object;
  if (!obj || !selection.length) return;
  const hit = pick(e.clientX, e.clientY);
  if (!hit) return;
  const grabbed = selection.some((p) => {
    const o = p !== 'r' ? objOf(p) : null;
    return !!o && isInside(hit.object, o);
  });
  if (!grabbed) return;
  // grabbed a selected block: this drag edits the selection instead of orbiting
  controls.enabled = false;
  const world = obj.getWorldPosition(new THREE.Vector3());
  const normal = camera.getWorldDirection(new THREE.Vector3());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world);
  free = { id: e.pointerId, x: e.clientX, y: e.clientY, obj, p: obj.position.clone(), q: obj.quaternion.clone(), s: obj.scale.clone(), world, plane, grab: hit.point.clone(), moved: false };
  ray.ray.intersectPlane(plane, free.grab);
});

window.addEventListener('pointermove', (e) => {
  if (draw && e.target === renderer.domElement) drawHover(e.clientX, e.clientY);
  if (!free || e.pointerId !== free.id) return;
  // a handle took this press after all
  if (gizmo.dragging) {
    free = null;
    return;
  }
  const dx = e.clientX - free.x;
  const dy = e.clientY - free.y;
  if (!free.moved) {
    if (Math.hypot(dx, dy) < 4) return;
    free.moved = true;
    pushUndo();
    beginDrag();
  }
  const o = free.obj;
  const mode = gizmo.getMode();
  if (mode === 'translate') {
    // slide in the plane facing the camera
    ray.setFromCamera(ndcAt(e.clientX, e.clientY), camera);
    const at = new THREE.Vector3();
    if (!ray.ray.intersectPlane(free.plane, at)) return;
    const target = free.world.clone().add(at.sub(free.grab));
    o.position.copy(o.parent ? o.parent.worldToLocal(target) : target);
  } else if (mode === 'rotate') {
    // sideways turns it, up/down tilts it toward you
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const step = THREE.MathUtils.degToRad(5);
    const snap = (a) => Math.round(a / step) * step;
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), snap(dx * 0.012));
    const tilt = new THREE.Quaternion().setFromAxisAngle(right, snap(dy * 0.012));
    const worldRot = turn.multiply(tilt);
    const parentQ = o.parent ? o.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    o.quaternion.copy(parentQ.clone().invert().multiply(worldRot).multiply(parentQ).multiply(free.q));
  } else {
    // drag up or right to grow, down or left to shrink
    const f = Math.max(0.05, Math.exp((dx - dy) * 0.006));
    o.scale.copy(free.s).multiplyScalar(f);
  }
  applyDrag(o);
});

const endFree = (e) => {
  if (!free || e.pointerId !== free.id) return false;
  const moved = free.moved;
  free = null;
  controls.enabled = true;
  if (moved) {
    designChanged(true);
    updateHelper();
  }
  return moved;
};
window.addEventListener('pointercancel', (e) => {
  holding = false;
  endFree(e);
});

window.addEventListener('pointerup', (e) => {
  holding = false;
  const dragged = endFree(e);
  // a press that worked the gizmo or dragged a block never changes the selection
  if (gizmoUsed || dragged) {
    downAt = null;
    return;
  }
  if (!downAt || !model || e.target !== renderer.domElement) {
    downAt = null;
    return;
  }
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 5) return;
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  if (draw) {
    drawClick(e.clientX, e.clientY);
    return;
  }
  if (edit) {
    pickElement(e.clientX, e.clientY, additive);
    return;
  }
  const hit = pick(e.clientX, e.clientY);
  if (hit) showTab('blocks');
  if (!hit && additive) return;
  select(hit ? hit.object.userData.path : null, additive);
});
renderer.domElement.addEventListener('dblclick', () => {
  if (draw) finishDraw();
});

function resize() {
  const w = viewEl.clientWidth;
  const h = viewEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
let userMoved = false;
new ResizeObserver(() => {
  resize();
  if (!userMoved) setCam(camName);
}).observe(viewEl);
controls.addEventListener('start', () => (userMoved = true));

let t = 0;
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t += dt;
  exprT += dt;
  if (model) {
    // shape editing, drawing and dragging hold the character in its modelled pose
    const still = !!edit || !!draw || holding || gizmo.dragging || !!free?.moved;
    if (still) restPose(model);
    else {
      const p = expr === 'neutral' ? { ...NEUTRAL } : previewPose(expr, exprT, manual);
      applyPose(model, p, expr === 'neutral' ? 0 : t, mouthState);
      // a picked part the pose hides (a closed mouth) stays visible while it's selected
      for (const path of selection) for (let o = objOf(path); o; o = o.parent) o.visible = true;
    }
  }
  helpers.forEach((h) => h.update());
  controls.update();
  renderer.render(scene, camera);
});

// ---------- shape edit mode: points, edges, faces ----------
let editOverlay = null;
let editCage = null;
const OVERLAY = 0x3ef0ff;
const PICKED = 0xffb020;

const editBar = $('edit-tools');
function syncEditBar() {
  editBar.classList.toggle('hidden', !edit);
  document.querySelectorAll('[data-edit]').forEach((b) => b.classList.toggle('on', !!edit && b.dataset.edit === edit.mode));
  $('extrude').disabled = !edit || edit.mode !== 'face' || !edit.sel.length;
  $('edit-shape').classList.toggle('on', !!edit);
}

/** start editing the selected block's shape; primitives become editable meshes first */
function enterEdit() {
  if (draw) cancelDraw();
  if (selection.length !== 1 || !selected || selected === 'r') return;
  const b = getBlock(selected);
  if (!b || b.shape === 'group') return;
  if (b.shape !== 'mesh') {
    pushUndo();
    const geo = blockGeometry(b);
    b.mesh = fromGeometry(geo);
    geo.dispose();
    // round shapes keep their smooth look as meshes
    const round = ['sphere', 'capsule', 'cylinder', 'cone', 'torus'].includes(b.shape);
    b.shape = 'mesh';
    b.size = { bevel: 0, smooth: round ? 1 : 0 };
    designChanged();
  }
  edit = { path: selected, mode: edit?.mode ?? 'face', sel: [] };
  syncEditBar();
  renderForm();
  updateHelper();
}
function exitEdit() {
  if (!edit) return;
  edit = null;
  editOverlay?.removeFromParent();
  editPivot.removeFromParent();
  editOverlay = null;
  editCage = null;
  syncEditBar();
  renderForm();
  updateHelper();
}
function setEditMode(mode) {
  if (!edit) return;
  edit.mode = mode;
  edit.sel = [];
  syncEditBar();
  updateHelper();
}
document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => setEditMode(b.dataset.edit)));
$('edit-done').addEventListener('click', exitEdit);
$('edit-shape').addEventListener('click', () => (edit ? exitEdit() : enterEdit()));
$('edit-all').addEventListener('click', selectAllElements);

/** the points the current pick covers */
function editVerts() {
  const b = edit ? getBlock(edit.path) : null;
  if (!edit || !b?.mesh) return [];
  const out = new Set();
  if (edit.mode === 'vertex') edit.sel.forEach((i) => out.add(i));
  else if (edit.mode === 'edge') {
    const edges = edgesOf(b.mesh);
    edit.sel.forEach((i) => edges[i]?.forEach((v) => out.add(v)));
  } else edit.sel.forEach((i) => b.mesh.f[i]?.forEach((v) => out.add(v)));
  return [...out].filter((i) => i * 3 < b.mesh.v.length);
}

/** draw the points / edges / faces over the mesh, with the picked ones lit */
function drawEditOverlay() {
  if (!edit) return;
  const obj = objOf(edit.path);
  const b = getBlock(edit.path);
  if (!obj || !b?.mesh) return;
  editOverlay?.removeFromParent();
  const g = new THREE.Group();
  g.renderOrder = 10;
  const d = b.mesh;
  const edges = edgesOf(d);
  const onTop = { depthTest: false, transparent: true };
  const ptsGeo = new THREE.BufferGeometry();
  ptsGeo.setAttribute('position', new THREE.Float32BufferAttribute(d.v, 3));
  if (edit.mode === 'vertex') g.add(new THREE.Points(ptsGeo, new THREE.PointsMaterial({ color: OVERLAY, size: 7, sizeAttenuation: false, ...onTop })));
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(d.v, 3));
  lineGeo.setIndex(edges.flat());
  g.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: OVERLAY, opacity: 0.7, ...onTop })));
  // the picked elements
  if (edit.mode === 'vertex' && edit.sel.length) {
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(edit.sel.flatMap((i) => [d.v[i * 3], d.v[i * 3 + 1], d.v[i * 3 + 2]]), 3));
    g.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: PICKED, size: 11, sizeAttenuation: false, ...onTop })));
  } else if (edit.mode === 'edge' && edit.sel.length) {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(d.v, 3));
    lg.setIndex(edit.sel.flatMap((i) => edges[i] ?? []));
    g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: PICKED, ...onTop })));
  } else if (edit.mode === 'face' && edit.sel.length) {
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(d.v, 3));
    fg.setIndex(edit.sel.flatMap((i) => (d.f[i] ? triangulate(d, d.f[i]).flat() : [])));
    g.add(new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: PICKED, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, ...onTop })));
  }
  // an invisible copy of the bare shape for picking faces
  editCage = new THREE.Mesh(meshGeometry(d), new THREE.MeshBasicMaterial({ visible: false }));
  g.add(editCage);
  g.traverse((o) => (o.renderOrder = 10));
  obj.add(g);
  editOverlay = g;
}

function attachEdit() {
  if (!edit) return;
  const obj = objOf(edit.path);
  const b = getBlock(edit.path);
  if (!obj || !b?.mesh) {
    edit = null;
    syncEditBar();
    return;
  }
  const count = edit.mode === 'vertex' ? b.mesh.v.length / 3 : edit.mode === 'edge' ? edgesOf(b.mesh).length : b.mesh.f.length;
  edit.sel = edit.sel.filter((i) => i < count);
  drawEditOverlay();
  const verts = editVerts();
  obj.add(editPivot);
  if (verts.length) {
    const c = new THREE.Vector3();
    for (const i of verts) c.add(new THREE.Vector3().fromArray(b.mesh.v, i * 3));
    editPivot.position.copy(c.divideScalar(verts.length));
    editPivot.quaternion.identity();
    editPivot.scale.set(1, 1, 1);
    gizmo.attach(editPivot);
  }
  syncEditBar();
}

function pickElement(x, y, additive) {
  if (!edit) return;
  const obj = objOf(edit.path);
  const b = getBlock(edit.path);
  if (!obj || !b?.mesh) return;
  obj.updateMatrixWorld();
  const rect = renderer.domElement.getBoundingClientRect();
  const screen = (i) => {
    const p = new THREE.Vector3().fromArray(b.mesh.v, i * 3).applyMatrix4(obj.matrixWorld).project(camera);
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, z: p.z };
  };
  let hit = -1;
  if (edit.mode === 'vertex') {
    let best = 14;
    for (let i = 0; i < b.mesh.v.length / 3; i++) {
      const s = screen(i);
      const dist = Math.hypot(s.x - x, s.y - y) + s.z * 0.5;
      if (dist < best) {
        best = dist;
        hit = i;
      }
    }
  } else if (edit.mode === 'edge') {
    let best = 10;
    edgesOf(b.mesh).forEach(([a, c], i) => {
      const p = screen(a);
      const q = screen(c);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len2 = dx * dx + dy * dy || 1;
      const k = Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / len2));
      const dist = Math.hypot(p.x + dx * k - x, p.y + dy * k - y) + (p.z + q.z) * 0.25;
      if (dist < best) {
        best = dist;
        hit = i;
      }
    });
  } else if (editCage) {
    ray.setFromCamera(ndcAt(x, y), camera);
    const h = ray.intersectObject(editCage, false)[0];
    const triFace = editCage.geometry.userData.triFace;
    if (h && h.faceIndex != null && triFace) hit = triFace[h.faceIndex] ?? -1;
  }
  if (hit < 0) {
    if (!additive) edit.sel = [];
  } else if (additive) edit.sel = edit.sel.includes(hit) ? edit.sel.filter((i) => i !== hit) : [...edit.sel, hit];
  else edit.sel = [hit];
  updateHelper();
}

function selectAllElements() {
  if (!edit) return;
  const b = getBlock(edit.path);
  if (!b?.mesh) return;
  const n = edit.mode === 'vertex' ? b.mesh.v.length / 3 : edit.mode === 'edge' ? edgesOf(b.mesh).length : b.mesh.f.length;
  edit.sel = edit.sel.length === n ? [] : Array.from({ length: n }, (_, i) => i);
  updateHelper();
}

/** pull the picked faces out of the shape, then leave them picked to drag further */
function extrudeSelected() {
  if (!edit || edit.mode !== 'face' || !edit.sel.length) return;
  const b = getBlock(edit.path);
  if (!b?.mesh) return;
  pushUndo();
  edit.sel = extrudeFaces(b.mesh, edit.sel, 0.015);
  setGizmoMode('translate');
  designChanged(true);
}
$('extrude').addEventListener('click', extrudeSelected);

// ---------- draw a shape: click an outline on a plane facing the camera, then extrude it ----------
let draw = null;
const drawBar = $('draw-bar');
const SNAP = 0.005;

function startDraw() {
  exitEdit();
  // the plane faces whichever side the camera mostly looks from, through the character's middle
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const ax = [Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)];
  const axis = ax.indexOf(Math.max(...ax));
  const n = new THREE.Vector3().setComponent(axis, -Math.sign(dir.getComponent(axis)) || 1);
  const w = axis === 1 ? new THREE.Vector3(0, 0, -Math.sign(n.y)) : new THREE.Vector3(0, 1, 0);
  const u = w.clone().cross(n);
  const origin = controls.target.clone();
  const layer = new THREE.Group();
  // a faint sheet so the plane is visible
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({ color: 0x3ef0ff, opacity: 0.06, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  sheet.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, w, n));
  sheet.position.copy(origin);
  layer.add(sheet);
  scene.add(layer);
  draw = { origin, u, w, n, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin), pts: [], cursor: null, layer };
  drawBar.classList.remove('hidden');
  updateHelper();
  refreshDraw();
}
const toWorld = (p) => draw.origin.clone().addScaledVector(draw.u, p.x).addScaledVector(draw.w, p.y);
function planeAt(x, y) {
  if (!draw) return null;
  ray.setFromCamera(ndcAt(x, y), camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(draw.plane, hit)) return null;
  hit.sub(draw.origin);
  const snap = (v) => Math.round(v / SNAP) * SNAP;
  return new THREE.Vector2(snap(hit.dot(draw.u)), snap(hit.dot(draw.w)));
}
function refreshDraw() {
  if (!draw) return;
  const keep = draw.layer.children[0];
  draw.layer.clear();
  draw.layer.add(keep);
  const path = [...draw.pts, ...(draw.cursor ? [draw.cursor] : [])].map(toWorld);
  if (path.length >= 2) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path), new THREE.LineBasicMaterial({ color: 0xffd23e, depthTest: false }));
    line.renderOrder = 11;
    draw.layer.add(line);
  }
  if (draw.pts.length) {
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(draw.pts.map(toWorld)), new THREE.PointsMaterial({ color: 0xffd23e, size: 9, sizeAttenuation: false, depthTest: false }));
    dots.renderOrder = 11;
    draw.layer.add(dots);
  }
  $('draw-hint').textContent = draw.pts.length < 3 ? `Click to place points on the grid plane (${draw.pts.length} so far, at least 3).` : 'Click the first point, double-click or press Enter to close the shape.';
  $('draw-finish').disabled = draw.pts.length < 3;
  $('draw-undo').disabled = !draw.pts.length;
}
function drawHover(x, y) {
  if (!draw) return;
  draw.cursor = planeAt(x, y);
  refreshDraw();
}
function drawClick(x, y) {
  if (!draw) return;
  const p = planeAt(x, y);
  if (!p) return;
  // clicking near the first point closes the outline
  if (draw.pts.length >= 3) {
    const first = toWorld(draw.pts[0]).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    if (Math.hypot(rect.left + ((first.x + 1) / 2) * rect.width - x, rect.top + ((1 - first.y) / 2) * rect.height - y) < 12) {
      finishDraw();
      return;
    }
  }
  const lastPt = draw.pts[draw.pts.length - 1];
  if (!lastPt || lastPt.distanceTo(p) > 1e-6) draw.pts.push(p);
  refreshDraw();
}
function cancelDraw() {
  if (!draw) return;
  scene.remove(draw.layer);
  draw = null;
  drawBar.classList.add('hidden');
  updateHelper();
}
function finishDraw() {
  if (!draw || draw.pts.length < 3) return;
  const { u, w, n } = draw;
  let pts = draw.pts.map((p) => p.clone());
  // counter-clockwise, so the faces point outward
  let area = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  });
  if (area < 0) pts = pts.reverse();
  const c = pts.reduce((s, p) => s.add(p), new THREE.Vector2()).divideScalar(pts.length);
  const local = pts.map((p) => [r4(p.x - c.x), r4(p.y - c.y)]);
  // place it: centred on the outline, facing the camera side it was drawn from, inside the selected group
  const parentP = selected && getBlock(selected)?.shape === 'group' ? selected : 'r';
  const world = new THREE.Matrix4().makeBasis(u, w, n).setPosition(toWorld(c));
  // in the character's own space (it stands at the origin in its modelled pose while drawing)
  const parentM = parentP === 'r' ? new THREE.Matrix4() : blockMatrix(parentP);
  const m = parentM.invert().multiply(world);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  m.decompose(pos, quat, scl);
  const e = new THREE.Euler().setFromQuaternion(quat);
  pushUndo();
  const block = {
    shape: 'mesh',
    name: 'Drawn shape',
    mesh: prism(local, 0.03),
    size: { bevel: 0, smooth: 0 },
    mat: { kind: 'lambert', color: 'accent' },
    p: [r2(pos.x), r2(pos.y), r2(pos.z)],
    r: [r2(e.x), r2(e.y), r2(e.z)],
    s: [r2(scl.x), r2(scl.y), r2(scl.z)],
  };
  const i = insertInto(getBlock(parentP), block);
  scene.remove(draw.layer);
  draw = null;
  drawBar.classList.add('hidden');
  selected = `${parentP}/${i}`;
  selection = [selected];
  designChanged(true);
  showTab('blocks');
  // straight into face editing, front face picked, ready to extrude deeper
  enterEdit();
  if (edit) {
    edit.mode = 'face';
    edit.sel = [0];
    syncEditBar();
    updateHelper();
  }
}
$('draw').addEventListener('click', () => (draw ? cancelDraw() : startDraw()));
$('draw-cancel').addEventListener('click', cancelDraw);
$('draw-finish').addEventListener('click', finishDraw);
$('draw-undo').addEventListener('click', () => {
  draw?.pts.pop();
  refreshDraw();
});

// ---------- character list ----------
function renderRoster() {
  const list = $('unit-list');
  list.innerHTML = '';
  const groups = [
    ['Bases', allChars().filter((c) => isBase(c.id))],
    ['My characters', allChars().filter((c) => !isBase(c.id))],
  ];
  for (const [label, chars] of groups) {
    if (!chars.length) continue;
    const h = document.createElement('div');
    h.className = 'unit-group';
    h.textContent = label;
    list.appendChild(h);
    for (const c of chars) {
      const b = document.createElement('button');
      b.className = 'unit' + (c.id === currentId ? ' on' : '');
      const tag = !isBase(c.id) ? baseOf(c.base).name.toUpperCase() : roster.chars[c.id] ? 'EDITED' : '';
      b.innerHTML = `<i style="background:linear-gradient(135deg, ${hex(c.palette.skin)} 0 50%, ${hex(c.palette.hair)} 50% 78%, ${hex(c.palette.top)} 78%)"></i><span></span>${tag ? `<em>${tag}</em>` : ''}`;
      b.querySelector('span').textContent = c.name;
      b.title = c.name;
      b.addEventListener('click', () => switchUnit(c.id));
      list.appendChild(b);
    }
  }
  $('delete-unit').disabled = isBase(currentId);
  $('reset-unit').disabled = !isBase(currentId) || !roster.chars[currentId];
}

function switchUnit(id) {
  flushSave();
  cancelDraw();
  edit = null;
  syncEditBar();
  currentId = id;
  selected = null;
  selection = [];
  undo = [];
  redo = [];
  syncUndoButtons();
  loadDraft();
  rebuildPreview();
  if (!userMoved) setCam(camName);
  renderRoster();
  renderProfile();
  renderPalette();
  renderTree();
  renderForm();
  renderRig();
  flushSave();
}

$('new-unit').addEventListener('click', () => {
  const d = def();
  const id = 'c' + Date.now().toString(36);
  roster.chars[id] = { id, base: d.base, name: `${d.name} II`.slice(0, 22), palette: { ...d.palette }, blueprint: clone(draft) };
  scheduleSave();
  switchUnit(id);
});

$('delete-unit').addEventListener('click', () => {
  if (isBase(currentId)) return;
  if (!confirm(`Delete ${def().name}? This can't be undone.`)) return;
  const base = def().base;
  delete roster.chars[currentId];
  flushSave();
  switchUnit(base);
});

$('reset-unit').addEventListener('click', () => {
  if (!isBase(currentId) || !roster.chars[currentId]) return;
  if (!confirm(`Reset ${def().name} to its original name, colours and design?`)) return;
  pushUndo();
  edit = null;
  syncEditBar();
  delete roster.chars[currentId];
  loadDraft();
  selected = null;
  selection = [];
  commit(true);
});

/** save a file to the device */
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileName = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';
// one character, complete (base design included even if it was never edited), for Avatar Cam or to share
$('export-one').addEventListener('click', () => {
  flushSave();
  const d = def();
  download(`${fileName(d.name)}.character.json`, { format: 'avatar-cam-character', version: 1, character: { ...d, blueprint: clone(draft) } });
});
// every edited and new character as a file, to back up or to share the designs
$('export-roster').addEventListener('click', () => {
  flushSave();
  download('avatar-cam-characters.json', { format: 'avatar-cam-characters', version: 1, chars: roster.chars });
});
$('import-roster').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files?.[0];
  $('import-file').value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert("That file isn't a character export.");
    return;
  }
  const chars = data?.character ? { [data.character.id]: data.character } : data?.chars;
  const valid = Object.values(chars ?? {}).filter((c) => c && typeof c.id === 'string' && (!c.blueprint || c.blueprint.shape === 'group'));
  if (!valid.length) {
    alert("That file has no characters in it.");
    return;
  }
  if (!confirm(`Import ${valid.length} character${valid.length > 1 ? 's' : ''}?\n\n${valid.map((c) => c.name ?? c.id).join(', ')}\n\nThey replace this device's copies of the same characters.`)) return;
  for (const c of valid) roster.chars[c.id] = { id: c.id, base: isBase(c.base) ? c.base : BASES[0].id, name: c.name, palette: c.palette, blueprint: c.blueprint };
  for (const c of valid) savedAs.set(c.id, '');
  flushSave();
  switchUnit(valid[0].id);
});

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
}
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- profile ----------
const nameInput = $('unit-name');
nameInput.addEventListener('input', () => {
  pushUndo('name');
  entry().name = nameInput.value;
  commit();
});

function renderProfile() {
  const d = def();
  nameInput.value = d.name;
  const base = baseOf(d.base);
  $('unit-base').textContent = `${base.name}: ${base.sub.toLowerCase()}.${isBase(d.id) ? ' Edits here change this base on this device; + NEW copies it into a character of your own.' : ''}`;
}

// ---------- colours ----------
function renderPalette() {
  const box = $('palette');
  box.innerHTML = '';
  for (const s of SLOTS) {
    const row = document.createElement('label');
    row.className = 'swatch';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = hex(def().palette[s.key]);
    const small = document.createElement('small');
    small.textContent = input.value;
    input.addEventListener('input', () => {
      pushUndo('color-' + s.key);
      const e = entry();
      e.palette = { ...e.palette, [s.key]: parseInt(input.value.slice(1), 16) };
      small.textContent = input.value;
      commit();
    });
    const span = document.createElement('span');
    span.textContent = s.label;
    row.append(input, span, small);
    box.appendChild(row);
  }
}

// ---------- block tree (layers) ----------
const SHAPE_LABEL = { group: 'Group', box: 'Box', rbox: 'Rounded', capsule: 'Capsule', sphere: 'Ball', cylinder: 'Tube', cone: 'Cone', torus: 'Ring', mesh: 'Mesh' };
const blockColor = (b) => (b.mat ? resolveColor(b.mat.color, def().palette) : null);

/** the layers being dragged, and where they'd land ('before' | 'after' | 'inside') */
let dragPaths = [];

function renderTree() {
  const tree = $('tree');
  const scroll = tree.scrollTop;
  tree.innerHTML = '';
  const add = (b, path, depth) => {
    const row = document.createElement('div');
    row.className = 'node' + (path === selected ? ' on' : selection.includes(path) ? ' sel' : '');
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const col = blockColor(b);
    const label = path === 'r' ? 'Character' : b.name || SHAPE_LABEL[b.shape];
    row.innerHTML = `<i class="${col === null ? '' : 'paint'}" title="${col === null ? '' : 'Change colour'}" style="background:${col === null ? 'transparent;border:1px solid #3ef0ff55' : hex(col)}"></i><span></span>${b.role ? `<b class="role">${ROLE_LABEL[b.role] ?? b.role}</b>` : ''}${b.name ? `<span class="kind">${SHAPE_LABEL[b.shape]}</span>` : ''}`;
    row.querySelector('span').textContent = label;
    row.addEventListener('click', (e) => select(path, e.shiftKey || e.metaKey || e.ctrlKey));
    const swatch = row.querySelector('i');
    if (col !== null)
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        pickLayerColor(path, swatch);
      });
    if (path !== 'r') {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        dragPaths = selection.includes(path) ? topLevel(selection) : [path];
        e.dataTransfer?.setData('text/plain', path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => {
        dragPaths = [];
        renderTree();
      });
    }
    const zone = (e) => {
      if (path === 'r') return 'inside';
      const r = row.getBoundingClientRect();
      const k = (e.clientY - r.top) / r.height;
      if (b.shape === 'group') return k < 0.28 ? 'before' : k > 0.72 ? 'after' : 'inside';
      return k < 0.5 ? 'before' : 'after';
    };
    row.addEventListener('dragover', (e) => {
      if (!dragPaths.length || dragPaths.some((p) => path === p || path.startsWith(p + '/'))) return;
      e.preventDefault();
      const z = zone(e);
      row.classList.toggle('drop-before', z === 'before');
      row.classList.toggle('drop-after', z === 'after');
      row.classList.toggle('drop-inside', z === 'inside');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragPaths.length) return;
      moveLayers(dragPaths, path, zone(e));
      dragPaths = [];
    });
    tree.appendChild(row);
    (b.children ?? []).forEach((c, i) => add(c, `${path}/${i}`, depth + 1));
  };
  add(draft, 'r', 0);
  tree.scrollTop = scroll;
}

/** take blocks out of their groups and put them into another, keeping where they are in the character */
function reparent(paths, place) {
  const moving = paths.map((p) => ({ block: getBlock(p), world: blockMatrix(p) }));
  for (const p of removalOrder(paths)) getBlock(parentPath(p)).children.splice(indexIn(p), 1);
  place(moving.map((m) => m.block));
  for (const { block, world } of moving) {
    const newParent = parentPath(pathOf(block));
    const local = (newParent === 'r' ? new THREE.Matrix4() : blockMatrix(newParent)).invert().multiply(world);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    local.decompose(pos, quat, scl);
    const e = new THREE.Euler().setFromQuaternion(quat);
    block.p = [r2(pos.x), r2(pos.y), r2(pos.z)];
    block.r = [r2(e.x), r2(e.y), r2(e.z)];
    block.s = [r2(scl.x), r2(scl.y), r2(scl.z)];
  }
  return moving.map((m) => m.block);
}

/** move layers before / after / into another layer, keeping them selected and where they are */
function moveLayers(paths, target, where) {
  paths = topLevel(paths).filter((p) => target !== p && !target.startsWith(p + '/'));
  if (!paths.length) return;
  const targetBlock = getBlock(target);
  if (!targetBlock) return;
  pushUndo();
  const moved = reparent(paths, (blocks) => {
    if (where === 'inside') (targetBlock.children ??= []).push(...blocks);
    else {
      const parent = getBlock(parentPath(pathOf(targetBlock)));
      const i = parent.children.indexOf(targetBlock) + (where === 'after' ? 1 : 0);
      parent.children.splice(i, 0, ...blocks);
    }
  });
  selection = moved.map((b) => pathOf(b)).filter(Boolean);
  selected = selection[selection.length - 1] ?? null;
  exitEditQuiet();
  designChanged(true);
}

/** nudge the picked layer one place up or down its list */
function shiftLayer(by) {
  if (!selected || selected === 'r') return;
  const pp = parentPath(selected);
  const list = getBlock(pp)?.children;
  const i = indexIn(selected);
  const j = i + by;
  if (!list || j < 0 || j >= list.length) return;
  pushUndo();
  const b = list[i];
  [list[i], list[j]] = [list[j], list[i]];
  const keep = selection.map((p) => getBlock(p));
  selection = keep.map((k) => (k ? pathOf(k) : null)).filter((p) => !!p);
  selected = pathOf(b);
  exitEditQuiet();
  designChanged(true);
}
$('move-up').addEventListener('click', () => shiftLayer(-1));
$('move-down').addEventListener('click', () => shiftLayer(1));

/** click a layer's colour dot: paint it (and the rest of the selection, if it's part of it) */
function pickLayerColor(path, anchor) {
  const targets = (selection.includes(path) ? selection : [path]).map(getBlock).filter((b) => !!b?.mat);
  if (!targets.length) return;
  const input = document.createElement('input');
  input.type = 'color';
  input.value = hex(blockColor(getBlock(path)) ?? 0xffffff);
  const r = anchor.getBoundingClientRect();
  Object.assign(input.style, { position: 'fixed', left: `${r.left}px`, top: `${r.bottom}px`, width: '1px', height: '1px', opacity: '0', border: '0', padding: '0' });
  document.body.appendChild(input);
  input.addEventListener('input', () => {
    pushUndo('layer-color');
    const v = parseInt(input.value.slice(1), 16);
    for (const b of targets) b.mat.color = v;
    designChanged();
  });
  const done = () => {
    input.remove();
    renderForm();
  };
  input.addEventListener('change', done);
  input.addEventListener('blur', () => setTimeout(done, 200));
  if (typeof input.showPicker === 'function') {
    try {
      input.showPicker();
      return;
    } catch {
      // fall back to a click
    }
  }
  input.click();
}

/** leave shape editing without re-rendering (the caller refreshes) */
function exitEditQuiet() {
  if (!edit) return;
  edit = null;
  editOverlay?.removeFromParent();
  editPivot.removeFromParent();
  editOverlay = null;
  editCage = null;
  syncEditBar();
}

function select(path, additive = false) {
  if (edit && path !== edit.path) exitEditQuiet();
  if (additive && path && path !== 'r') {
    const rest = selection.filter((p) => p !== 'r');
    if (rest.includes(path)) {
      selection = rest.filter((p) => p !== path);
      selected = selection[selection.length - 1] ?? null;
    } else {
      selection = [...rest, path];
      selected = path;
    }
  } else {
    selection = path ? [path] : [];
    selected = path;
  }
  renderTree();
  renderForm();
  renderRig();
  updateHelper();
  const row = document.querySelector('.node.on');
  row?.scrollIntoView({ block: 'nearest' });
}
/** jump to the part with this role */
function selectRole(role) {
  const path = rolePath(role);
  if (!path) return;
  showTab('blocks');
  select(path);
}
$('pick-head').addEventListener('click', () => selectRole('head'));
$('pick-body').addEventListener('click', () => selectRole('body'));

// ---------- block form ----------
const SIZE_FIELDS = {
  box: [
    ['width', 'W'],
    ['height', 'H'],
    ['depth', 'D'],
  ],
  rbox: [
    ['width', 'W'],
    ['height', 'H'],
    ['depth', 'D'],
  ],
  capsule: [
    ['radius', 'R'],
    ['height', 'L'],
  ],
  sphere: [['radius', 'R']],
  cylinder: [
    ['radiusTop', 'Top'],
    ['radiusBottom', 'Bot'],
    ['height', 'H'],
    ['radialSegments', 'Sides'],
  ],
  cone: [
    ['radius', 'R'],
    ['height', 'H'],
    ['radialSegments', 'Sides'],
  ],
  torus: [
    ['radius', 'R'],
    ['tube', 'Tube'],
  ],
  mesh: [],
};

function numberInput(value, step, onChange, key, full = false) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(r2(value));
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    pushUndo(key);
    onChange(v);
    designChanged();
  });
  // a change that swaps the shape needs the form rebuilt once typing is done
  if (full) input.addEventListener('change', () => renderForm());
  return input;
}

/** which part a block follows: the nearest HEAD or BODY around it */
function attachedTo(path) {
  let follows = 'r';
  let b = draft;
  let p = 'r';
  for (const i of path.split('/').slice(1).map(Number)) {
    if (b.role === 'head' || b.role === 'body') follows = p;
    b = b.children[i];
    p = `${p}/${i}`;
  }
  return follows;
}

function renderForm() {
  const form = $('block-form');
  form.innerHTML = '';
  const b = selected ? getBlock(selected) : null;
  const many = topLevel(selection).length > 1;
  const single = !!b && selected !== 'r' && !many;
  $('dup').disabled = !topLevel(selection).length;
  $('mirror').disabled = !topLevel(selection).length;
  $('del').disabled = !topLevel(selection).length;
  $('group-sel').disabled = !topLevel(selection).length;
  $('move-up').disabled = !single || indexIn(selected) === 0;
  $('move-down').disabled = !single || indexIn(selected) >= (getBlock(parentPath(selected))?.children?.length ?? 1) - 1;
  $('edit-shape').disabled = !single || b.shape === 'group';
  const section = (title) => {
    const h = document.createElement('div');
    h.className = 'form-title';
    h.textContent = title;
    form.appendChild(h);
  };
  const row2 = (label, el) => {
    const row = document.createElement('div');
    row.className = 'row2';
    const span = document.createElement('span');
    span.textContent = label;
    row.append(span, el);
    form.appendChild(row);
  };
  /** colour + finish controls for one or more blocks */
  const paint = (blocks, key) => {
    const mats = blocks.map((x) => x.mat).filter((m) => !!m);
    if (!mats.length) return;
    section('PAINT');
    const first = mats[0];
    const same = mats.every((m) => m.color === first.color);
    const pick = document.createElement('select');
    if (!same) pick.add(new Option('Mixed', 'mixed', true, true));
    for (const s of SLOTS) pick.add(new Option(s.label, s.key, false, same && first.color === s.key));
    pick.add(new Option('Custom…', 'custom', false, same && typeof first.color === 'number'));
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.value = hex(resolveColor(first.color, def().palette));
    custom.classList.toggle('hidden', !(same && typeof first.color === 'number'));
    pick.addEventListener('change', () => {
      if (pick.value === 'mixed') return;
      pushUndo();
      for (const m of mats) m.color = pick.value === 'custom' ? parseInt(custom.value.slice(1), 16) : pick.value;
      custom.classList.toggle('hidden', pick.value !== 'custom');
      custom.value = hex(resolveColor(mats[0].color, def().palette));
      designChanged();
    });
    custom.addEventListener('input', () => {
      pushUndo(key + '-custom');
      for (const m of mats) m.color = parseInt(custom.value.slice(1), 16);
      designChanged();
    });
    const inline = document.createElement('div');
    inline.className = 'inline';
    inline.append(pick, custom);
    row2('Colour', inline);

    const finish = document.createElement('select');
    const kinds = new Set(mats.map((m) => m.kind));
    if (kinds.size > 1) finish.add(new Option('Mixed', 'mixed', true, true));
    for (const [k, label] of [
      ['lambert', 'Soft (skin, cloth)'],
      ['phong', 'Glossy (vinyl, eyes)'],
      ['basic', 'Glow (unlit)'],
    ])
      finish.add(new Option(label, k, false, kinds.size === 1 && first.kind === k));
    finish.addEventListener('change', () => {
      if (finish.value === 'mixed') return;
      pushUndo();
      for (const m of mats) m.kind = finish.value;
      designChanged();
    });
    row2('Finish', finish);

    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '0.1';
    opacity.max = '1';
    opacity.step = '0.05';
    opacity.value = String(first.opacity ?? 1);
    opacity.addEventListener('input', () => {
      pushUndo(key + '-opacity');
      const v = parseFloat(opacity.value);
      for (const m of mats) {
        if (v >= 1) delete m.opacity;
        else m.opacity = v;
      }
      designChanged();
    });
    row2('Opacity', opacity);
  };

  if (many) {
    const n = topLevel(selection).length;
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = `${n} blocks selected. Drag the gizmo (or one of them) to move, turn or scale them together; Group, Duplicate, Mirror and Delete work on all of them.`;
    form.appendChild(p);
    paint(selection.map(getBlock).filter((x) => !!x), 'multi');
    return;
  }
  if (!b || !selected) {
    form.innerHTML = '<p class="empty">Select a block in the list or click one on the model (Shift / ⌘ to pick several). Add blocks with the buttons above, or draw your own shape: with nothing selected they go on the head; otherwise inside the selected group, or next to the selected block.</p>';
    return;
  }
  if (selected === 'r') {
    form.innerHTML = '<p class="empty">The whole character. Blocks here stay still; put them inside HEAD or BODY (or use <b>Follows</b> on a block) to move with the face tracking.</p>';
    return;
  }
  const path = selected;
  const row3 = (label, values, step, toShow, fromShow, set, key) => {
    const row = document.createElement('div');
    row.className = 'row3';
    const span = document.createElement('span');
    span.textContent = label;
    row.appendChild(span);
    ['x', 'y', 'z'].forEach((axis, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'axis';
      wrap.dataset.axis = axis;
      wrap.appendChild(numberInput(toShow(values[i]), step, (v) => set(i, fromShow(v)), `${path}-${key}-${i}`));
      row.appendChild(wrap);
    });
    form.appendChild(row);
  };
  const fieldRow = (fields) => {
    const row = document.createElement('div');
    row.className = 'row3';
    row.style.gridTemplateColumns = `repeat(${fields.length}, 1fr)`;
    for (const f of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'axis';
      wrap.dataset.axis = f.label;
      const input = numberInput(f.value, f.step, f.set, `${path}-${f.key}`, f.full);
      input.style.paddingLeft = `${10 + f.label.length * 7}px`;
      wrap.appendChild(input);
      row.appendChild(wrap);
    }
    form.appendChild(row);
  };

  section('BLOCK');
  const name = document.createElement('input');
  name.type = 'text';
  name.value = b.name ?? '';
  name.placeholder = SHAPE_LABEL[b.shape];
  name.addEventListener('input', () => {
    pushUndo(path + '-name');
    b.name = name.value || undefined;
    designChanged();
  });
  row2('Name', name);

  const shape = document.createElement('select');
  for (const s of Object.keys(SHAPE_LABEL)) {
    // a mesh comes from Edit shape or Draw; it can't be picked from scratch
    if (s === 'mesh' && b.shape !== 'mesh') continue;
    shape.add(new Option(SHAPE_LABEL[s], s, false, s === b.shape));
  }
  shape.addEventListener('change', () => {
    pushUndo();
    const next = shape.value;
    exitEditQuiet();
    b.shape = next;
    delete b.mesh;
    if (next === 'group') {
      delete b.size;
      delete b.mat;
    } else {
      b.size = { ...DEFAULT_SIZE[next] };
      b.mat ??= { kind: 'lambert', color: 'skin' };
    }
    designChanged(true);
  });
  row2('Shape', shape);

  // which part it follows: move it into the head or the body, staying where it is
  if (b.role !== 'head' && b.role !== 'body') {
    const follows = document.createElement('select');
    const now = attachedTo(path);
    const targets = [
      ['head', 'Head (turns with it)'],
      ['body', 'Body (sways with it)'],
    ];
    for (const [role, label] of targets) {
      const rp = rolePath(role);
      if (rp) follows.add(new Option(label, rp, false, now === rp));
    }
    follows.add(new Option('Nothing (stays still)', 'r', false, now === 'r'));
    follows.addEventListener('change', () => {
      const target = follows.value;
      if (target === attachedTo(path) || target === path || target.startsWith(path + '/')) return;
      pushUndo();
      exitEditQuiet();
      const [moved] = reparent([path], ([blk]) => (getBlock(target).children ??= []).push(blk));
      selected = pathOf(moved);
      selection = [selected];
      designChanged(true);
    });
    row2('Follows', follows);
  }

  const role = document.createElement('select');
  role.add(new Option('— none —', ''));
  for (const r of ROLES) role.add(new Option(r.label.charAt(0) + r.label.slice(1).toLowerCase(), r.key, false, b.role === r.key));
  role.addEventListener('change', () => {
    pushUndo();
    // every role is one-per-character: move the tag here
    const r = role.value;
    if (r) {
      const strip = (n) => {
        if (n.role === r) delete n.role;
        n.children?.forEach(strip);
      };
      strip(draft);
    }
    if (r) b.role = r;
    else delete b.role;
    designChanged(true);
  });
  row2('Moves as', role);
  if (b.role) {
    const note = document.createElement('p');
    note.className = 'empty';
    note.textContent = ROLES.find((r) => r.key === b.role)?.sub ?? '';
    form.appendChild(note);
  }

  if (b.shape !== 'group') {
    const size = (b.size ??= { ...DEFAULT_SIZE[b.shape] });
    const fields = SIZE_FIELDS[b.shape];
    if (fields.length) {
      section('SIZE');
      fieldRow(
        fields.map(([k, label]) => {
          const integer = k.endsWith('Segments');
          return {
            label,
            value: Number(size[k] ?? DEFAULT_SIZE[b.shape][k] ?? 0.05),
            step: integer ? 1 : 0.002,
            set: (v) => (size[k] = integer ? Math.max(3, Math.round(v)) : Math.max(0.001, v)),
            key: `size-${k}`,
          };
        }),
      );
    }
    if (b.shape === 'mesh' && b.mesh) {
      section('SHAPE');
      const info = document.createElement('p');
      info.className = 'empty';
      info.textContent = `${b.mesh.v.length / 3} points · ${edgesOf(b.mesh).length} edges · ${b.mesh.f.length} faces. ${edit ? 'Pick points, edges or faces on the canvas and drag the gizmo; Extrude pulls faces out.' : 'Press Edit shape (Tab) to move its points, edges and faces.'}`;
      form.appendChild(info);
    }
    // bevel: rounds or chamfers the edges of boxes, tubes and editable meshes
    const bevelable = b.shape === 'box' || b.shape === 'rbox' || b.shape === 'cylinder' || b.shape === 'mesh';
    if (bevelable) {
      section('BEVEL');
      if (b.shape === 'box' || b.shape === 'rbox') {
        fieldRow([
          {
            label: 'Bevel',
            value: b.shape === 'rbox' ? Number(size.radius ?? 0.015) : 0,
            step: 0.002,
            key: 'bevel',
            full: true,
            set: (v) => {
              if (v <= 0) {
                b.shape = 'box';
                delete size.radius;
                delete size.segments;
              } else {
                b.shape = 'rbox';
                size.radius = v;
                size.segments ??= 3;
              }
            },
          },
          { label: 'Steps', value: Number(size.segments ?? 3), step: 1, key: 'bevel-steps', set: (v) => (size.segments = Math.max(1, Math.min(8, Math.round(v)))) },
        ]);
      } else if (b.shape === 'cylinder') {
        fieldRow([
          { label: 'Bevel', value: Number(size.bevel ?? 0), step: 0.002, key: 'bevel', set: (v) => (size.bevel = Math.max(0, v)) },
          { label: 'Steps', value: Number(size.bevelSegments ?? 2), step: 1, key: 'bevel-steps', set: (v) => (size.bevelSegments = Math.max(1, Math.min(8, Math.round(v)))) },
        ]);
      } else {
        fieldRow([{ label: 'Bevel', value: Number(size.bevel ?? 0), step: 0.002, key: 'bevel', set: (v) => (size.bevel = Math.max(0, v)) }]);
        const smooth = document.createElement('input');
        smooth.type = 'checkbox';
        smooth.checked = !!size.smooth;
        smooth.addEventListener('change', () => {
          pushUndo();
          size.smooth = smooth.checked ? 1 : 0;
          designChanged();
        });
        const lab = document.createElement('label');
        lab.className = 'inline';
        lab.append(smooth, document.createTextNode(' Smooth shading'));
        row2('Surface', lab);
      }
    }
  }

  section('PLACE');
  row3('Position', b.p, 0.005, (v) => v, (v) => v, (i, v) => (b.p[i] = v), 'p');
  row3('Rotate °', b.r, 1, (v) => Math.round(v * DEG * 10) / 10, (v) => v / DEG, (i, v) => (b.r[i] = v), 'r');
  row3('Scale', b.s, 0.05, (v) => v, (v) => v, (i, v) => (b.s[i] = v), 's');

  paint([b], path);
}

// ---------- rig tab: which parts move, and a pose to try ----------
function renderRig() {
  const list = $('rig-list');
  list.innerHTML = '';
  for (const r of ROLES) {
    const path = rolePath(r.key);
    const row = document.createElement('button');
    row.className = 'rig-row' + (path ? '' : ' missing') + (path && selection.includes(path) ? ' on' : '');
    row.innerHTML = `<b>${r.label}</b><span></span><em>${path ? getBlock(path).name || SHAPE_LABEL[getBlock(path).shape] : 'not set'}</em>`;
    row.querySelector('span').textContent = r.sub;
    row.disabled = !path;
    row.addEventListener('click', () => selectRole(r.key));
    list.appendChild(row);
  }
}

const SLIDERS = [
  { key: 'smile', label: 'Smile', min: 0, max: 1 },
  { key: 'frown', label: 'Frown', min: 0, max: 1 },
  { key: 'blinkL', label: 'Blink', min: 0, max: 1 },
  { key: 'jaw', label: 'Mouth open', min: 0, max: 1 },
  { key: 'brow', label: 'Brows up', min: -1, max: 1 },
  { key: 'yaw', label: 'Turn °', min: -45, max: 45 },
  { key: 'pitch', label: 'Nod °', min: -30, max: 30 },
];
function renderSliders() {
  const box = $('pose-sliders');
  box.innerHTML = '';
  for (const s of SLIDERS) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String((s.max - s.min) / 100);
    input.value = String(s.key === 'brow' ? manual.browL : manual[s.key]);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (s.key === 'brow') manual.browL = manual.browR = v;
      else manual[s.key] = v;
      if (expr !== 'manual') setExpr('manual');
    });
    const row = document.createElement('div');
    row.className = 'row2';
    const span = document.createElement('span');
    span.textContent = s.label;
    row.append(span, input);
    box.appendChild(row);
  }
  const zero = document.createElement('button');
  zero.className = 'ghost';
  zero.textContent = 'Reset pose';
  zero.addEventListener('click', () => {
    Object.assign(manual, { smile: 0, frown: 0, blinkL: 0, jaw: 0, yaw: 0, pitch: 0, browL: 0, browR: 0 });
    renderSliders();
    setExpr('neutral');
  });
  box.appendChild(zero);
}

// ---------- add / duplicate / mirror / group / delete ----------
function insertInto(parent, block, at) {
  parent.children ??= [];
  const i = at ?? parent.children.length;
  parent.children.splice(i, 0, block);
  return i;
}

document.querySelectorAll('[data-add]').forEach((btn) =>
  btn.addEventListener('click', () => {
    pushUndo();
    exitEditQuiet();
    cancelDraw();
    const shape = btn.dataset.add;
    // inside the selected group, or next to the selected block; on the head when nothing is picked
    let parentP = rolePath('head') ?? 'r';
    if (selected) {
      const sb = getBlock(selected);
      parentP = sb && sb.shape === 'group' ? selected : selected === 'r' ? 'r' : parentPath(selected);
    }
    const parent = getBlock(parentP);
    const block = {
      shape,
      // out in front of the face (or beside the character), where it's easy to see and grab
      p: parentP === 'r' ? [0.3, 0.4, 0] : parentP === rolePath('head') ? [0, 0.15, 0.16] : [0, 0.05, 0.1],
      r: [0, 0, 0],
      s: [1, 1, 1],
      ...(shape === 'group' ? {} : { size: { ...DEFAULT_SIZE[shape] }, mat: { kind: 'lambert', color: 'accent' } }),
    };
    const i = insertInto(parent, block);
    selected = `${parentP}/${i}`;
    selection = [selected];
    designChanged(true);
    updateHelper();
    showTab('blocks');
    document.querySelector('.node.on')?.scrollIntoView({ block: 'nearest' });
  }),
);

/** reflect a block (and everything inside it) across the character's centre line; L parts become R */
function mirrorBlock(b) {
  b.p[0] = -b.p[0];
  b.r[1] = -b.r[1];
  b.r[2] = -b.r[2];
  if (b.role && MIRROR_ROLE[b.role]) b.role = MIRROR_ROLE[b.role];
  if (b.name) b.name = b.name.replace(/ ([LR])$/, (_, s) => (s === 'L' ? ' R' : ' L'));
  if (b.mesh) {
    // flip the points, and turn each face around so it still faces out
    for (let i = 0; i < b.mesh.v.length; i += 3) b.mesh.v[i] = -b.mesh.v[i];
    b.mesh.f = b.mesh.f.map((f) => [...f].reverse());
  }
  b.children?.forEach(mirrorBlock);
}

function copySelected(mirror) {
  const paths = topLevel(selection);
  if (!paths.length) return;
  pushUndo();
  exitEditQuiet();
  const copies = [];
  // later siblings first, so earlier insert points stay valid
  for (const p of removalOrder(paths)) {
    const b = getBlock(p);
    if (!b) continue;
    const copy = clone(b);
    if (mirror) mirrorBlock(copy);
    else copy.p[0] += 0.02;
    // roles are one-per-character: the copy keeps one only if the original's other side is free
    const strip = (n) => {
      if (n.role && rolePath(n.role)) delete n.role;
      n.children?.forEach(strip);
    };
    strip(copy);
    insertInto(getBlock(parentPath(p)), copy, indexIn(p) + 1);
    copies.push(copy);
  }
  selection = copies.map((c) => pathOf(c)).filter(Boolean);
  selected = selection[selection.length - 1] ?? null;
  designChanged(true);
  updateHelper();
}
$('dup').addEventListener('click', () => copySelected(false));
$('mirror').addEventListener('click', () => copySelected(true));

/** wrap the selected blocks in a new group, placed where the first of them sat */
function groupSelected() {
  const paths = topLevel(selection);
  if (!paths.length) return;
  pushUndo();
  exitEditQuiet();
  // the group goes where the first selected block sat
  const ordered = removalOrder(paths).reverse();
  const parent = getBlock(parentPath(ordered[0]));
  const moving = ordered.map((p) => ({ block: getBlock(p), from: getBlock(parentPath(p)) }));
  const group = { shape: 'group', name: 'Group', p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1], children: [] };
  parent.children.splice(parent.children.indexOf(moving[0].block), 0, group);
  for (const { block, from } of moving) from.children.splice(from.children.indexOf(block), 1);
  group.children = moving.map((m) => m.block);
  selected = pathOf(group);
  selection = selected ? [selected] : [];
  designChanged(true);
  updateHelper();
}
$('group-sel').addEventListener('click', groupSelected);

$('del').addEventListener('click', () => {
  const paths = topLevel(selection);
  if (!paths.length) return;
  pushUndo();
  exitEditQuiet();
  const pp = parentPath(paths[0]);
  for (const p of removalOrder(paths)) getBlock(parentPath(p))?.children?.splice(indexIn(p), 1);
  selected = getBlock(pp) ? pp : 'r';
  selection = [selected];
  designChanged(true);
  updateHelper();
});

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (typing && e.target.type === 'text') return;
    e.preventDefault();
    if (e.shiftKey) stepHistory(redo, undo);
    else stepHistory(undo, redo);
    return;
  }
  if (typing) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    groupSelected();
    return;
  }
  // drawing
  if (draw) {
    if (e.key === 'Escape') cancelDraw();
    else if (e.key === 'Enter') finishDraw();
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      draw.pts.pop();
      refreshDraw();
    }
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    if (edit) exitEdit();
    else enterEdit();
    return;
  }
  // shape editing
  if (edit) {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') exitEdit();
    else if (k === '1') setEditMode('vertex');
    else if (k === '2') setEditMode('edge');
    else if (k === '3') setEditMode('face');
    else if (k === 'a') selectAllElements();
    else if (k === 'e' && edit.mode === 'face' && edit.sel.length) extrudeSelected();
    else if (k === 'w') setGizmoMode('translate');
    else if (k === 'e') setGizmoMode('rotate');
    else if (k === 'r') setGizmoMode('scale');
    return;
  }
  if (e.metaKey || e.ctrlKey) return;
  const exprKeys = ['neutral', 'blink', 'smile', 'frown', 'talk', 'turn', 'loop'];
  if (/^[0-6]$/.test(e.key)) {
    setExpr(exprKeys[Number(e.key)]);
    return;
  }
  if (e.key.toLowerCase() === 'h') {
    selectRole('head');
    return;
  }
  if (e.key.toLowerCase() === 'y') {
    selectRole('body');
    return;
  }
  const modes = { w: 'translate', e: 'rotate', r: 'scale' };
  if (modes[e.key.toLowerCase()]) {
    setGizmoMode(modes[e.key.toLowerCase()]);
    return;
  }
  if (e.key === '[' || e.key === ']') {
    shiftLayer(e.key === '[' ? -1 : 1);
    return;
  }
  const paths = topLevel(selection);
  if (!paths.length) return;
  const step = e.shiftKey ? 0.025 : 0.005;
  // the character faces +z: left / right move along x as seen from the front
  const moves = {
    ArrowLeft: [0, -step],
    ArrowRight: [0, step],
    ArrowUp: [2, -step],
    ArrowDown: [2, step],
    PageUp: [1, step],
    PageDown: [1, -step],
  };
  const m = moves[e.key];
  if (m) {
    e.preventDefault();
    pushUndo(paths.join() + '-nudge');
    for (const p of paths) {
      const b = getBlock(p);
      if (b) b.p[m[0]] = r2(b.p[m[0]] + m[1]);
    }
    designChanged(true);
    updateHelper();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    $('del').click();
  }
});

window.addEventListener('beforeunload', flushSave);

// ---------- go ----------
loadDraft();
rebuildPreview();
resize();
setCam('angle');
renderRoster();
renderProfile();
renderPalette();
renderTree();
renderForm();
renderRig();
renderSliders();
setGizmoMode('translate');
setExpr('neutral');
syncUndoButtons();
syncEditBar();
// a hook for checking the lab from the console
window.__lab = { camera, controls, get draft() { return draft; }, get model() { return model; }, select, selectRole, setExpr, setCam, switchUnit };
