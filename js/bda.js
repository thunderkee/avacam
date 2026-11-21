// Fighters from bdafighter (marble-fighter), exported to GLB by the game's own builder (ShooterMesh)
// with their head and eyes tagged (userData.role: 'head', 'eye'; the game's own tags such as 'jaw'
// and 'turret' come along). Each loads into a ToyStage rig: the head turns about its base, eyes
// blink, the jaw opens when talking, and the body turns, tilts and leans like the other 3D characters.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The game's current cast (its playable() list, the 2.2 designs), in the game's order.
// jawClose: how far (radians) to shut a jaw the game builds hanging open, so it rests closed.
export const BDA_CAST = [
  { id: 'bda-angel', file: 'models/bda-angel.glb', name: 'Seraph', bg: '#CFDDF7' },
  { id: 'bda-dragon', file: 'models/bda-dragon.glb', name: 'Wyvern', bg: '#EFC0C3', jawClose: 0.25 },
  { id: 'bda-pioneer', file: 'models/bda-pioneer.glb', name: 'Pioneer', bg: '#E4DCCB' },
  { id: 'bda-liberty', file: 'models/bda-liberty.glb', name: 'Liberty', bg: '#C1EBE6' },
  { id: 'bda-monoceros', file: 'models/bda-monoceros.glb', name: 'Mandrill', bg: '#D0D9EB' },
  { id: 'bda-baron', file: 'models/bda-baron.glb', name: 'Crimson Baron', bg: '#EFC5C7' },
  { id: 'bda-bastion', file: 'models/bda-bastion.glb', name: 'Bastion', bg: '#C3D5C7' },
  { id: 'bda-nightshade', file: 'models/bda-nightshade.glb', name: 'Nightshade', bg: '#C8C3D5' },
  { id: 'bda-violet', file: 'models/bda-violet.glb', name: 'Silverback', bg: '#CCC4E2' },
  { id: 'bda-kabuto', file: 'models/bda-kabuto.glb', name: 'Leo King', bg: '#D1C7E3', jawClose: 0.35 },
  { id: 'bda-tyrant', file: 'models/bda-tyrant.glb', name: 'Tyrant King', bg: '#C8CAD0' },
  { id: 'bda-rex', file: 'models/bda-rex.glb', name: 'Rex Saur', bg: '#CFE6EE', jawClose: 0.4 },
  { id: 'bda-liger', file: 'models/bda-liger.glb', name: 'Fang Hound', bg: '#D9D2C2' },
  { id: 'bda-ember', file: 'models/bda-ember.glb', name: 'Blossom', bg: '#FFD9C8', jawClose: 0.2 },
  { id: 'bda-rampage', file: 'models/bda-rampage.glb', name: 'Red Bunny', bg: '#F4C2C4' },
  { id: 'bda-trueleo', file: 'models/bda-trueleo.glb', name: 'True Leo King', bg: '#F1DDB0' },
].map((e) => {
  let rig = null, ready = null;
  return {
    ...e, kind: 'toy',
    build: () => (rig ||= emptyRig(), ready ||= load(e, rig), rig),
    ready: () => (rig ||= emptyRig(), ready ||= load(e, rig)),
  };
});

const loader = new GLTFLoader();
const HEAD_SIZE = 1.9;  // match the other 3D characters' heads (about 2 units tall)
const HEAD_Y = 0.15;    // where their head centres sit
// Body shot (shot: 'body'): the whole fighter in frame, head to feet, with a little room above.
const BODY_H = 3.4, BODY_TOP = 1.6, BODY_W = 3.0; // (the frame is about 2.7 wide: wide wings may crop a little)
// Upper shot (the default, shot: 'upper'): head and shoulders, like the other characters.
const UPPER_H = 2.3, UPPER_TOP = 1.5, UPPER_W = 8; // (arms and wings may crop at the sides)
const CAM_Z = 9.5; // ToyStage's camera distance

function emptyRig() {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  // head starts as a stand-in until the model loads (render needs one)
  const head = new THREE.Group();
  body.add(head);
  // faceBack: the fighters face -z, so they're turned round (nod and tilt flip with it);
  // headStill: the head stays on its turret (no drift of its own). The body moves like the other
  // characters' (turn, tilt, sway, lean-in).
  return { root, head, body, eyes: [], brows: [], ears: [], mouth: null, extra: {}, faceBack: true, headStill: true };
}

async function load({ file, shot = 'upper', jawClose = 0 }, rig) {
  const gltf = await loader.loadAsync(file);
  const model = gltf.scene;
  const orient = new THREE.Group();
  orient.rotation.y = Math.PI; // face the camera
  orient.add(model);
  model.updateMatrixWorld(true);

  let head = null, jaw = null;
  const eyes = [];
  model.traverse((o) => {
    const role = o.userData?.role;
    if (role === 'head' && !head) head = o;
    else if (role === 'eye') eyes.push(o);
    else if (role === 'jaw' && !jaw) jaw = o;
    if (o.isMesh) o.frustumCulled = false;
  });

  // Size and place: a band of the fighter fitted to the frame. Upper shot: from the top of the head
  // down past the shoulders. Body shot: head to feet. (Head shot: the head alone, below.)
  if (shot === 'body' || shot === 'upper') {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    let top = box.max.y, bottom = box.min.y, H = BODY_H, TOP = BODY_TOP, W = BODY_W;
    if (shot === 'upper') {
      const hb = head ? new THREE.Box3().setFromObject(head) : null;
      top = hb ? hb.max.y : box.max.y; // (a spear or antenna above the head may crop)
      // (the game's head groups often take in the collar too, so the chest is measured from the top)
      bottom = Math.max(box.min.y, top - Math.max(size.y * 0.42, hb ? Math.min((hb.max.y - hb.min.y) * 1.2, size.y * 0.6) : 0));
      H = UPPER_H; TOP = UPPER_TOP; W = UPPER_W;
    }
    const bandH = top - bottom;
    // Deep fighters (Rex's head and tail) reach toward the camera, and near parts look bigger:
    // shrink until the nearest part fits too (the camera sits CAM_Z in front).
    const k0 = Math.min(H / bandH, W / size.x);
    let k = k0;
    const slack = shot === 'upper' ? 3 : 1.2; // (close up, a nearer head may loom a little more)
    for (let i = 0; i < 8; i++) k = k0 * Math.max(0.3, (CAM_Z - Math.max(0, size.z * k / 2 - slack)) / CAM_Z);
    orient.scale.setScalar(k);
    // (the top is placed so that, seen from the camera, even its nearest edge sits at TOP)
    const near = (CAM_Z - size.z * k / 2) / CAM_Z;
    // Wide, short fighters (Mandrill, the Baron's plane) are fitted by width: centre them in the
    // body's band instead of hanging them from the top.
    const drop = Math.max(0, H - bandH * k) / 2;
    orient.position.set(centre.x * k, -0.35 + (TOP - drop + 0.35) * near - top * k, centre.z * k);
  } else {
    const headBox = new THREE.Box3().setFromObject(head || model);
    const size = headBox.getSize(new THREE.Vector3());
    const k = Math.min(4.5, Math.max(1.2, HEAD_SIZE / Math.max(size.y, size.x * 0.8)));
    const centre = headBox.getCenter(new THREE.Vector3());
    orient.scale.setScalar(k);
    // (orient turns the model round, so x flips)
    orient.position.set(centre.x * k, HEAD_Y - centre.y * k, centre.z * k);
  }
  rig.body.add(orient);

  if (head) {
    // Pivot the head at its base (its "neck"), so turns and nods keep it on the body.
    const parent = head.parent;
    const local = new THREE.Box3().setFromObject(head);
    const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    const base = new THREE.Vector3((local.min.x + local.max.x) / 2, local.min.y + (local.max.y - local.min.y) * 0.1, (local.min.z + local.max.z) / 2).applyMatrix4(inv);
    const pivot = new THREE.Group();
    pivot.position.copy(base);
    parent.add(pivot);
    head.position.sub(base);
    pivot.add(head);
    rig.body.remove(rig.head);
    rig.head = pivot;
  }
  // Each eye turns and scales about its own middle (some are built off-centre in their geometry,
  // sometimes shared), and knows its side of the screen for left/right blinks and brows.
  rig.root.updateMatrixWorld(true);
  for (const e of eyes) {
    e.geometry = e.geometry.clone();
    e.geometry.computeBoundingBox();
    const c = e.geometry.boundingBox.getCenter(new THREE.Vector3());
    const shift = c.clone().applyMatrix4(e.matrix).sub(e.position);
    e.geometry.translate(-c.x, -c.y, -c.z);
    e.position.add(shift);
    e.updateMatrixWorld(true);
    const x = new THREE.Vector3().setFromMatrixPosition(e.matrixWorld).x;
    e.userData.side = Math.abs(x) < 0.03 ? 0 : Math.sign(x);
  }
  // Closed eyes: a dark lid line over each eye, shown while blinking (squashing these eyes barely shows).
  const lidMat = new THREE.MeshStandardMaterial({ color: '#1b1b24', roughness: 0.6 });
  rig.eyes = eyes.map((e) => {
    e.userData.travel = 0.02;
    e.geometry.computeBoundingBox();
    const box = e.geometry.boundingBox.clone().applyMatrix4(e.matrix); // in the eye's parent space
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    e.userData.h = size.y; // (expressions lift and lower the eye by a share of its height)
    const lid = new THREE.Mesh(new THREE.BoxGeometry(size.x * 1.08, Math.max(size.y * 0.24, size.x * 0.14), Math.max(size.z * 0.5, 0.01)), lidMat);
    lid.position.set(c.x, c.y - size.y * 0.08, box.min.z - 0.004); // just in front (the fighters face -z)
    lid.visible = false;
    e.parent.add(lid);
    e.userData.lid = lid;
    return e;
  });
  // These jaws hinge the other way from the game's usual (+x opened them shut), so they open on -x.
  if (jaw) { rig.extra.jaw = jaw; jaw.userData.rest = jaw.rotation.x + jawClose; jaw.userData.sign = -1; }
  // No jaw on the head (none at all, or one low on the body like Wyvern's and Tyrant King's): the
  // head stretches and squashes as they talk.
  let o = jaw; while (o && o !== rig.head) o = o.parent;
  rig.talkScale = !o;
  return rig;
}
