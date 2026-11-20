// Fighters from bdafighter (marble-fighter), exported to GLB by the game's own builder (ShooterMesh)
// with their head and eyes tagged (userData.role: 'head', 'eye'; the game's own tags such as 'jaw'
// and 'turret' come along). Each loads into a ToyStage rig: the head turns about its base, eyes
// blink, the jaw opens when talking, and the body turns, tilts and leans like the other 3D characters.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The current (2.2) designs, as the game uses them: angel-22, rex-22, ember-22, and trueleo (one version).
export const BDA_CAST = [
  { id: 'bda-angel', file: 'models/bda-angel.glb', name: 'Seraph', bg: '#CFDDF7', shot: 'body' },
  { id: 'bda-trueleo', file: 'models/bda-trueleo.glb', name: 'True Leo King', bg: '#F1DDB0', shot: 'body' },
  { id: 'bda-rex', file: 'models/bda-rex.glb', name: 'Rex Saur', bg: '#CFE6EE', shot: 'body' },
  { id: 'bda-ember', file: 'models/bda-ember.glb', name: 'Blossom', bg: '#FFD9C8', shot: 'body' },
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
const CAM_Z = 9.5; // ToyStage's camera distance

function emptyRig() {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  // head starts as a stand-in until the model loads (render needs one)
  const head = new THREE.Group();
  body.add(head);
  // faceBack: the fighters face -z, so they're turned round (nod and tilt flip with it);
  // headStill: the head stays on its turret (no drift of its own).
  return { root, head, body, eyes: [], brows: [], ears: [], mouth: null, extra: {}, faceBack: true, headStill: true };
}

async function load({ file, shot }, rig) {
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

  // Size and place: the head as big as the other characters' heads, centred where theirs are.
  // Or, for a body shot, the whole fighter fitted head to feet.
  if (shot === 'body') {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    // Deep fighters (Rex's head and tail) reach toward the camera, and near parts look bigger:
    // shrink until the nearest part fits too (the camera sits CAM_Z in front).
    const k0 = Math.min(BODY_H / size.y, BODY_W / size.x);
    let k = k0;
    for (let i = 0; i < 8; i++) k = k0 * Math.max(0.3, (CAM_Z - Math.max(0, size.z * k / 2 - 1.2)) / CAM_Z);
    orient.scale.setScalar(k);
    // (the top is placed so that, seen from the camera, even its nearest edge sits at BODY_TOP)
    const near = (CAM_Z - size.z * k / 2) / CAM_Z;
    orient.position.set(centre.x * k, -0.35 + (BODY_TOP + 0.35) * near - box.max.y * k, centre.z * k);
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
  // Closed eyes: a dark lid line over each eye, shown while blinking (squashing these eyes barely shows).
  const lidMat = new THREE.MeshStandardMaterial({ color: '#1b1b24', roughness: 0.6 });
  rig.eyes = eyes.map((e) => {
    e.userData.travel = 0.012;
    e.geometry.computeBoundingBox();
    const box = e.geometry.boundingBox.clone().applyMatrix4(e.matrix); // in the eye's parent space
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const lid = new THREE.Mesh(new THREE.BoxGeometry(size.x * 1.08, Math.max(size.y * 0.24, size.x * 0.14), Math.max(size.z * 0.5, 0.01)), lidMat);
    lid.position.set(c.x, c.y - size.y * 0.08, box.min.z - 0.004); // just in front (the fighters face -z)
    lid.visible = false;
    e.parent.add(lid);
    e.userData.lid = lid;
    return e;
  });
  // These jaws hinge the other way from the game's usual (+x opened them shut), so they open on -x.
  if (jaw) { rig.extra.jaw = jaw; jaw.userData.rest = jaw.rotation.x; jaw.userData.sign = -1; }
  return rig;
}
