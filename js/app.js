// Avatar Cam: live face → character, record motion + audio, re-render in Post.
//
// One recording format for every character: raw tracker samples { t, bs, m, key }.
// Blurb characters are posed by Blurb's own FaceSync + Rig (blurb/*.js); the 3D
// characters read the same tracks as plain numbers (performance.js → poseAt).
/* global Motion, LipSync */
import { FPS, NEAR, sampleFromResult, poseFromResult, demoSample, solve, poseAt, LiveSolver } from './performance.js';
import { BLURB_CAST, BlurbCharacter } from './blurb-render.js';
import { TOY_CAST, ToyStage } from './toys3d.js';
import { blurb3DCast } from './blurb3d.js';
import { BDA_CAST } from './bda.js';
import { VOICE_PRESETS, decode, applyVoice, toWav } from './voice-fx.js';
import { extractCaptions, captionAt, drawCaption, toSrt, languageName } from './captions.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const now = () => performance.now() / 1000;

// --------------------------------------------------------------------- cast

// 2D Blurb characters, then their 3D versions, then Puff / Neko / Bolt.
const CAST = [...BLURB_CAST(), ...blurb3DCast(), ...TOY_CAST, ...BDA_CAST];
const blurbChars = new Map(); // id → BlurbCharacter (built lazily)
let toys = null;              // ToyStage, created on first 3D character
const charFor = (entry) => {
  if (entry.kind === 'toy') { toys ||= new ToyStage(); return toys; }
  if (!blurbChars.has(entry.id)) blurbChars.set(entry.id, new BlurbCharacter(entry));
  return blurbChars.get(entry.id);
};

// --------------------------------------------------------------- backgrounds

const grad = (ctx, h, stops) => { const g = ctx.createLinearGradient(0, 0, 0, h); stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s)); return g; };
const BACKGROUNDS = [
  { id: 'match', label: 'Character colour', css: 'conic-gradient(#B5E6C7 0 25%,#F6BFC4 0 50%,#B6DBF6 0 75%,#F6E08A 0)', fill: null },
  { id: 'sunset', css: 'linear-gradient(#ff9a8b,#ff6a88 55%,#ff99ac)', fill: (c, w, h) => grad(c, h, ['#ff9a8b', '#ff6a88', '#ff99ac']) },
  { id: 'ocean', css: 'linear-gradient(#a1c4fd,#c2e9fb)', fill: (c, w, h) => grad(c, h, ['#a1c4fd', '#c2e9fb']) },
  { id: 'mint', css: 'linear-gradient(#d4fc79,#96e6a1)', fill: (c, w, h) => grad(c, h, ['#d4fc79', '#96e6a1']) },
  { id: 'night', css: 'linear-gradient(#232526,#414345)', fill: (c, w, h) => grad(c, h, ['#232526', '#414345']) },
  { id: 'cream', css: '#f5efe6', fill: () => '#f5efe6' },
  { id: 'green', css: '#00b140', fill: () => '#00b140' },
];

// ---------------------------------------------------------------------- state

const view = $('view'), vctx = view.getContext('2d');
const cam = $('cam');
const state = {
  mode: 'live', demo: false, exporting: false,
  entry: CAST.find((c) => c.id === 'blurb') || CAST[0], bg: BACKGROUNDS[0],
  stream: null, landmarker: null, poser: null, pose: null, poseTick: 0,
  live: new LiveSolver(), lastFace: -1e9, lowLight: false,
  calib: [], calibrating: null,
  recording: null, // { t0, samples, audioRec, chunks }
  proj: null,      // { samples, calib, audio, duration }
};

function resizeView() {
  const r = view.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  view.width = Math.round(r.width * dpr); view.height = Math.round(r.height * dpr);
}
addEventListener('resize', resizeView); resizeView();

function show(id) { for (const s of ['live', 'post']) $(s).classList.toggle('on', s === id); state.mode = id; }

// --------------------------------------------------------------------- render

// Idle motion for when there's no face: Blurb's own idle head, blinks and breathing.
const IDLE_N = 12 * FPS;
const idleTracks = (() => {
  const head = Motion.idleHead(IDLE_N, FPS, { strength: 0.8 });
  const blinks = Motion.autoBlinks(IDLE_N, FPS);
  return {
    n: IDLE_N, offset: 0, segments: [{ key: LipSync.REST, start: 0, end: IDLE_N }],
    extras: { head, eyes: { left: blinks, right: blinks }, breath: Motion.breathing(IDLE_N, FPS), profile: false },
  };
})();

/** Draw one frame of a performance: background, then the character. */
function renderScene(ctx, w, h, tracks, f, t, entry, bg) {
  if (!w || !h) return false; // not laid out yet (or hidden): nothing to draw into
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (bg.image) {
    const img = bg.image, s = Math.max(w / img.width, h / img.height);
    ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
  } else {
    ctx.fillStyle = bg.fill ? bg.fill(ctx, w, h) : entry.bg || '#ddd';
    ctx.fillRect(0, 0, w, h);
  }
  const ch = charFor(entry);
  let drawn = true;
  if (entry.kind === 'toy') {
    ch.setCharacter(entry);
    ctx.drawImage(ch.render(poseAt(tracks, f), t, w, h), 0, 0, w, h);
  } else {
    // Half-body art (400×500): bottom-aligned, full width on a 9:16 frame.
    const { width: aw, height: ah } = ch.size;
    const s = Math.min(w / aw, (h * 0.74) / ah);
    if (ch.locked) {
      // Blob heads: the face at the centre of the frame; leaning in scales it from there.
      const near = tracks.extras.near?.head ? Motion.valueAt(tracks.extras.near.head, f) : 1;
      const k = clamp(1 + (near - 1) * NEAR.head2D.amp, NEAR.head2D.min, NEAR.head2D.max);
      ctx.translate(w / 2, h / 2);
      ctx.scale(s * k, s * k);
      ctx.translate(-ch.center.x, -ch.center.y);
    } else {
      ctx.translate((w - aw * s) / 2, h - ah * s);
      ctx.scale(s, s);
    }
    if (!ch.bitmaps) { ch.load(); drawn = false; } else ch.draw(ctx, tracks, f);
  }
  ctx.restore();
  return drawn;
}

// ----------------------------------------------------------------- characters

function buildCarousel(el) {
  el.innerHTML = '';
  for (const entry of CAST) {
    const b = document.createElement('button');
    b.className = 'char-btn' + (entry === state.entry ? ' sel' : '');
    b.dataset.id = entry.id;
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    thumb.style.backgroundColor = entry.bg;
    const img = document.createElement('img');
    img.alt = '';
    if (entry.kind === 'blurb') img.src = charFor(entry).thumbUrl();
    else toyThumb(entry).then((url) => { img.src = url; });
    thumb.append(img);
    if (entry.kind === 'toy') thumb.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: '3D' }));
    b.append(thumb, Object.assign(document.createElement('span'), { textContent: entry.name }));
    b.onclick = () => pickCharacter(entry);
    el.append(b);
  }
}
const toyThumbs = new Map();
async function toyThumb(entry) {
  if (!toyThumbs.has(entry.id)) {
    if (entry.ready) await entry.ready(); // a model loaded from a file (bdafighter): wait for it
    const cv = Object.assign(document.createElement('canvas'), { width: 120, height: 213 });
    const stage = charFor(entry);
    stage.setCharacter(entry);
    cv.getContext('2d').drawImage(stage.render(poseAt(idleTracks, 0), 0, 120, 213), 0, 0);
    // Crop to the head
    const sq = Object.assign(document.createElement('canvas'), { width: 104, height: 104 });
    sq.getContext('2d').drawImage(cv, 0, 30, 120, 120, 0, 0, 104, 104);
    toyThumbs.set(entry.id, sq.toDataURL());
  }
  return toyThumbs.get(entry.id);
}
async function pickCharacter(entry) {
  state.entry = entry;
  document.querySelectorAll('.char-btn').forEach((x) => x.classList.toggle('sel', x.dataset.id === entry.id));
  if (entry.kind === 'blurb') {
    const ch = charFor(entry);
    if (!ch.bitmaps) { $('loadingChar').hidden = false; await ch.load(); $('loadingChar').hidden = true; }
  }
}
buildCarousel($('liveChars'));
pickCharacter(state.entry);

// --------------------------------------------------------------- start / camera

async function loadTracker() {
  const base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const { FaceLandmarker, FilesetResolver } = await import(`${base}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${base}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    // As in Blurb: keep the face through big nods and turns.
    minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
  });
  try { return await FaceLandmarker.createFromOptions(files, opts('GPU')); }
  catch { return await FaceLandmarker.createFromOptions(files, opts('CPU')); }
}

/** Shoulders (optional): MediaPipe Pose Landmarker lite, as Blurb's Face mode uses. */
async function loadPoser() {
  const base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const { PoseLandmarker, FilesetResolver } = await import(`${base}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${base}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', delegate },
    runningMode: 'VIDEO', numPoses: 1,
  });
  try { return await PoseLandmarker.createFromOptions(files, opts('GPU')); }
  catch { return await PoseLandmarker.createFromOptions(files, opts('CPU')); }
}

$('startBtn').onclick = async () => {
  const msg = $('startMsg'); msg.className = ''; msg.textContent = 'Starting camera…';
  $('startBtn').disabled = true;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } }));
    cam.srcObject = state.stream; $('pipVid').srcObject = state.stream;
    await cam.play();
    msg.textContent = 'Loading face tracker…';
    state.landmarker = await loadTracker();
    // Shoulder tracking loads alongside; the face works without it.
    loadPoser().then((p) => { state.poser = p; }).catch(() => { state.poser = null; });
    $('startOv').classList.remove('on');
    show('live');
    calibrate();
  } catch (e) {
    msg.className = 'err';
    msg.textContent = e.name === 'NotAllowedError' ? "Camera access was blocked. Allow it in your browser's site settings, or try without camera."
      : `Couldn't start: ${e.message || e}`;
    $('startBtn').disabled = false;
  }
};
$('demoBtn').onclick = async () => {
  state.demo = true;
  try { state.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { state.stream = null; }
  $('startOv').classList.remove('on'); $('pipBtn').disabled = true; $('recalBtn').disabled = true;
  show('live');
};

// Calibration: ~2 s of neutral face. FaceSync calibrates against medians, so these
// samples are prepended to every solve to anchor "rest" to the neutral face.
function calibrate() {
  state.calibrating = { t0: now(), samples: [] };
  $('calOv').classList.add('on'); $('calBar').style.width = '0';
}
function calibrationTick() {
  const c = state.calibrating;
  const k = (now() - c.t0) / 2;
  $('calBar').style.width = Math.min(100, k * 100) + '%';
  if (k < 1) return;
  const faces = c.samples.filter((s) => s.bs);
  if (faces.length > 10) { state.calib = faces; state.live.setCalibration(faces); }
  state.calibrating = null;
  $('calOv').classList.remove('on');
}
$('recalBtn').onclick = calibrate;
$('pipBtn').onclick = () => { $('pip').classList.toggle('on'); $('pipBtn').classList.toggle('on'); };

// Low-light check on a tiny downsample twice a second.
const probe = Object.assign(document.createElement('canvas'), { width: 16, height: 12 });
const pctx = probe.getContext('2d', { willReadFrequently: true });
let lastProbe = 0;
function checkLight(t) {
  if (t - lastProbe < 0.5 || !cam.videoWidth) return;
  lastProbe = t; pctx.drawImage(cam, 0, 0, 16, 12);
  const d = pctx.getImageData(0, 0, 16, 12).data; let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  state.lowLight = s / (d.length / 4) < 45;
}

// ------------------------------------------------------------------ live loop

let lastVideoTime = -1, lastDemo = 0, fpsCount = 0, fpsT = now();
/** Take a new tracker sample if one is due; returns it or null. */
function nextSample(t) {
  if (state.demo) {
    if (t - lastDemo < 1 / FPS) return null;
    lastDemo = t; fpsCount++;
    return demoSample(t);
  }
  if (!state.landmarker || cam.readyState < 2 || cam.currentTime === lastVideoTime) return null;
  lastVideoTime = cam.currentTime;
  const ts = performance.now();
  const aspect = cam.videoWidth / cam.videoHeight || 4 / 3;
  const res = state.landmarker.detectForVideo(cam, ts);
  // Shoulders move slowly: the heavier pose model runs on every 3rd frame (as in Blurb).
  if (state.poser && state.poseTick++ % 3 === 0) {
    try { state.pose = poseFromResult(state.poser.detectForVideo(cam, ts), aspect); } catch { state.pose = null; }
  }
  checkLight(t);
  const s = sampleFromResult(res, t, aspect, state.pose);
  if (s.bs) fpsCount++;
  return s;
}

function liveFrame() {
  const t = now();
  const s = nextSample(t);
  if (s) {
    if (s.bs) state.lastFace = t;
    state.calibrating?.samples.push(s);
    state.live.push(s);
    if (state.recording) state.recording.samples.push({ ...s, t: t - state.recording.t0 });
  }
  if (state.calibrating) calibrationTick();

  const lost = t - state.lastFace > 0.4;
  $('trackDot').classList.toggle('warn', lost || state.lowLight);
  $('trackText').textContent = state.demo ? 'Demo motion' : lost ? 'Face lost' : state.lowLight ? 'Low light' : 'Tracking';
  if (t - fpsT > 1) { $('fps').textContent = `${Math.round(fpsCount / (t - fpsT))} fps`; fpsCount = 0; fpsT = t; }

  if (state.recording) {
    const rt = t - state.recording.t0;
    $('timerText').textContent = fmt(rt);
    if (rt >= 90) stopRecording();
  }

  // Without a face, idle (Blurb's idle motion) instead of freezing.
  const sol = lost ? null : state.live.solve();
  updateHud(t, sol, s, lost);
  if (sol) renderScene(vctx, view.width, view.height, sol.tracks, sol.frame, t, state.entry, state.bg);
  else renderScene(vctx, view.width, view.height, idleTracks, Math.floor(t * FPS) % IDLE_N, t, state.entry, state.bg);
}

// ---------------------------------------------------------------- tracking readout
// Distance to the camera, head tilt, shoulder tilt and movement, as the rig sees them.

$('trackChip').onclick = () => { $('hud').hidden = !$('hud').hidden; };

// Settings: the Character Lab, the tracking readout, recalibrate.
function openSettings() {
  $('setHud').setAttribute('aria-checked', String(!$('hud').hidden));
  // recalibrating needs the camera running
  $('setRecal').disabled = $('recalBtn').disabled || $('startOv').classList.contains('on');
  $('settingsOv').classList.add('on');
}
const closeSettings = () => $('settingsOv').classList.remove('on');
$('settingsBtn').onclick = openSettings;
$('startSettingsBtn').onclick = openSettings;
$('settingsClose').onclick = closeSettings;
$('settingsOv').onclick = (e) => { if (e.target === $('settingsOv')) closeSettings(); };
$('setHud').onclick = () => { $('hud').hidden = !$('hud').hidden; $('setHud').setAttribute('aria-checked', String(!$('hud').hidden)); };
$('setRecal').onclick = () => { closeSettings(); calibrate(); };
let hudT = 0, lastRaw = null;
function updateHud(t, sol, sample, lost) {
  if (sample?.m) lastRaw = sample;
  if ($('hud').hidden || t - hudT < 0.1) return;
  hudT = t;
  const hint = [];
  if (lost || !sol) {
    for (const id of ['hudDist', 'hudTilt', 'hudSh', 'hudMove', 'hudArms']) $(id).textContent = '--';
    $('hudHint').textContent = state.demo ? '' : 'Face your camera to start tracking';
    return;
  }
  const p = poseAt(sol.tracks, sol.frame);
  // Distance: the face transform's depth is in cm; the bar shows lean in / out from your calibrated rest.
  const cm = lastRaw?.m ? Math.round(Math.abs(lastRaw.m[14])) : null;
  $('hudDist').textContent = cm ? `${cm} cm` : '--';
  $('hudDistBar').style.left = `${50 + clamp((p.nearHead - 1) / 0.3, -1, 1) * 46}%`;
  if (cm && cm < 25) hint.push('Too close: move back a little');
  else if (cm && cm > 90) hint.push('Far away: move closer for better tracking');
  // Head tilt (roll) and shoulder tilt, degrees; the bars tilt the same way on screen.
  const side = (deg) => (Math.abs(deg) < 2 ? 'level' : `${Math.abs(Math.round(deg))}° ${deg > 0 ? 'R' : 'L'}`);
  $('hudTilt').textContent = side(p.roll);
  $('hudTiltLine').style.transform = `rotate(${clamp(p.roll, -45, 45)}deg)`;
  const hasShoulders = !!sol.tracks.extras.body;
  if (hasShoulders) {
    $('hudSh').textContent = side(p.bodyRoll);
    $('hudShLine').style.transform = `rotate(${clamp(p.bodyRoll, -30, 30)}deg)`;
  } else {
    $('hudSh').textContent = state.poser || state.demo ? 'not seen' : 'loading';
    $('hudShLine').style.transform = 'rotate(0)';
    if (state.poser) hint.push('Step back so your shoulders are in view');
  }
  // Movement: head offset from rest (artwork px → pad), plus shoulders' sway.
  const mx = hasShoulders ? p.bodyX : p.headX, my = hasShoulders ? p.bodyY : p.headY;
  $('hudMoveDot').style.left = `${50 + clamp(p.headX / 40, -1, 1) * 40}%`;
  $('hudMoveDot').style.top = `${50 + clamp(p.headY / 30, -1, 1) * 40}%`;
  const mag = Math.hypot(p.headX, p.headY);
  $('hudMove').textContent = mag < 3 ? 'still' : `${Math.round(mag)} px${hasShoulders && Math.hypot(mx, my) > 3 ? ' · body' : ''}`;
  // Arms: reaching toward the camera (3D), else how far each upper arm is raised (screen sides).
  const armWord = (a) => {
    if (!a || a.vis < 0.5) return null;
    if (a.d3 && a.d3.reach > 0.15) return `reach ${Math.round(a.d3.reach * 100)} cm`;
    const lift = Math.abs(a.u);
    return lift > 1.6 ? 'up' : lift > 0.6 ? 'out' : 'down';
  };
  const words = p.arms ? ['L', 'R'].map((sd) => (armWord(p.arms[sd]) ? `${sd} ${armWord(p.arms[sd])}` : null)).filter(Boolean) : [];
  $('hudArms').textContent = words.length ? words.join(' · ') : 'not seen';
  $('hudHint').textContent = hint[0] || '';
}

function mainLoop() {
  if (!view.width) resizeView(); // sized before layout: measure again once the page has a size
  if (!state.exporting) {
    if (state.mode === 'live') liveFrame();
    else if (state.mode === 'post' && state.proj) postTick();
  }
  requestAnimationFrame(mainLoop);
}
requestAnimationFrame(mainLoop);

// ------------------------------------------------------------------ recording

$('recBtn').onclick = () => (state.recording ? stopRecording() : countdown());
let counting = false;
async function countdown() {
  if (counting) return; counting = true;
  const el = $('countdown'); el.classList.add('on');
  for (const n of [3, 2, 1]) { el.textContent = n; await new Promise((r) => setTimeout(r, 800)); }
  el.classList.remove('on'); counting = false;
  startRecording();
}
const audioMime = () => ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
function startRecording() {
  const rec = { t0: now(), samples: [], audioRec: null, chunks: [] };
  const audioTracks = state.stream?.getAudioTracks() || [];
  if (audioTracks.length && window.MediaRecorder) {
    const mime = audioMime();
    const ar = new MediaRecorder(new MediaStream(audioTracks), mime ? { mimeType: mime } : undefined);
    ar.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
    // Motion time starts when audio does, so the two stay in sync.
    ar.onstart = () => { rec.t0 = now(); rec.samples = []; };
    ar.start(250); rec.audioRec = ar;
  }
  state.recording = rec;
  $('recBtn').classList.add('recording'); $('timer').hidden = false; $('liveChars').style.visibility = 'hidden';
}
async function stopRecording() {
  const rec = state.recording;
  if (!rec) return;
  state.recording = null;
  $('recBtn').classList.remove('recording'); $('timer').hidden = true; $('liveChars').style.visibility = '';
  let audio = null;
  if (rec.audioRec) {
    await new Promise((r) => { rec.audioRec.onstop = r; rec.audioRec.stop(); });
    audio = new Blob(rec.chunks, { type: rec.audioRec.mimeType || 'audio/webm' });
  }
  if (rec.samples.length < 10) return; // too short: stay in Live
  openPost({ samples: rec.samples, calib: state.calib, audio, duration: rec.samples.at(-1).t });
}

// ----------------------------------------------------------------------- post

const post = { audioEl: null, playing: false, clockT0: 0, clockPos: 0, smooth: 0.2, strength: 1, trimS: 0, trimE: 1, tracks: null,
  buffer: null,           // the recorded voice, decoded
  voice: 'none', semis: 0, // voice effect choice (kept across takes)
  fxBuffer: null, fxJob: 0,
  captions: null, capOn: true, capJob: 0 }; // captions: { language, lines } for this take

function openPost(proj) {
  state.proj = proj;
  post.trimS = 0; post.trimE = proj.duration; post.clockPos = 0; post.buffer = null; post.fxBuffer = null; post.fxJob++; $('fxOv').classList.remove('on');
  post.captions = null; post.capJob++; buildCaptionPanel();
  $('trimStart').value = 0; $('trimEnd').value = 1000;
  post.audioEl?.pause();
  post.audioEl = null;
  if (proj.audio) {
    post.audioEl = new Audio(URL.createObjectURL(proj.audio));
    post.audioEl.preload = 'auto';
    post.audioEl.onended = () => setPlaying(false);
  }
  buildCarousel($('postChars'));
  buildVoicePanel();
  if (proj.audio) decode(proj.audio).then((b) => { post.buffer = b; if (post.voice !== 'none' || post.semis) applyVoiceFx(); }).catch(() => {});
  resolveTracks(); updateTrimLabels();
  show('post');
  setPlaying(true);
}

// ---------------------------------------------------------------- voice effects
// The recorded voice re-processed (pitch, robot, echo…); timing is kept, so lip sync still matches.

function buildVoicePanel() {
  const el = $('voiceChips'), scroll = el.scrollLeft; el.innerHTML = '';
  for (const v of VOICE_PRESETS) {
    const b = document.createElement('button');
    b.className = 'vchip' + (v.id === post.voice ? ' sel' : '');
    b.innerHTML = `<span>${v.icon}</span>${v.label}`;
    b.onclick = () => { post.voice = v.id; buildVoicePanel(); applyVoiceFx(); };
    el.append(b);
  }
  el.scrollLeft = scroll; // (the row keeps its place when a chip is picked)
  $('semis').value = post.semis; $('semiVal').textContent = (post.semis > 0 ? '+' : '') + post.semis;
  const has = !!state.proj?.audio;
  $('semis').disabled = !has;
  el.querySelectorAll('button').forEach((b) => { b.disabled = !has; });
  $('voiceStatus').textContent = has ? '' : 'No sound was recorded for this take (allow the microphone to use voice effects).';
}
// The label follows the slider; the voice is applied when it's let go.
$('semis').oninput = (e) => { post.semis = +e.target.value; $('semiVal').textContent = (post.semis > 0 ? '+' : '') + post.semis; };
$('semis').onchange = () => applyVoiceFx();

// While a voice is applied, playback pauses behind a "Applying voice…" overlay and resumes after.
async function applyVoiceFx() {
  if (!state.proj?.audio) return;
  const job = ++post.fxJob;
  if (!post.buffer) { $('voiceStatus').textContent = 'Loading sound…'; return; } // runs again once decoded
  if (!$('fxOv').classList.contains('on')) { post.fxResume = post.playing; setPlaying(false); $('fxOv').classList.add('on'); }
  const done = () => { if (job !== post.fxJob) return; $('fxOv').classList.remove('on'); if (post.fxResume) setPlaying(true); };
  $('voiceStatus').textContent = '';
  await new Promise((r) => setTimeout(r, 50)); // let the overlay paint
  const fx = await applyVoice(post.buffer, { preset: post.voice, semitones: post.semis });
  if (job !== post.fxJob) return; // a newer choice took over
  const fxBuffer = fx === post.buffer ? null : fx;
  const blob = fxBuffer ? await toWav(fxBuffer) : state.proj.audio;
  if (job !== post.fxJob) return;
  post.fxBuffer = fxBuffer;
  // Swap the player's source once the new one is ready, keeping position and play state; the
  // old player (and its sound file) is let go, so repeated changes don't pile up in memory.
  const el = new Audio(URL.createObjectURL(blob));
  el.preload = 'auto';
  el.onended = () => setPlaying(false);
  el.addEventListener('loadedmetadata', () => {
    if (job !== post.fxJob) return URL.revokeObjectURL(el.src);
    const old = post.audioEl, t = currentTime();
    el.currentTime = t;
    post.audioEl = el;
    if (old) { old.pause(); URL.revokeObjectURL(old.src); old.removeAttribute('src'); old.load(); }
    done();
  }, { once: true });
  el.addEventListener('error', done, { once: true });
  const p = VOICE_PRESETS.find((v) => v.id === post.voice);
  $('voiceStatus').textContent = post.fxBuffer ? `${p.label}${post.semis ? ` ${post.semis > 0 ? '+' : ''}${post.semis} st` : ''} applied` : '';
}

// Re-run Blurb's face pipeline over the whole take (fast: ~70 ms for 90 s).
function resolveTracks() {
  post.tracks = solve(state.proj.samples, state.proj.calib, { strength: post.strength, smooth: post.smooth });
}
let resolveTimer = 0;
const resolveSoon = () => { clearTimeout(resolveTimer); resolveTimer = setTimeout(resolveTracks, 60); };

const frameAt = (t) => post.tracks.offset + Math.round(t * FPS);
function currentTime() {
  if (post.audioEl) return post.audioEl.currentTime;
  return post.playing ? post.clockPos + (now() - post.clockT0) : post.clockPos;
}
function seekTo(t) {
  t = clamp(t, post.trimS, post.trimE);
  if (post.audioEl) post.audioEl.currentTime = t;
  post.clockPos = t; post.clockT0 = now();
}
function setPlaying(on) {
  post.playing = on;
  if (on) {
    if (currentTime() >= post.trimE - 0.05 || currentTime() < post.trimS) seekTo(post.trimS);
    post.audioEl?.play().catch(() => {});
    post.clockT0 = now();
  } else { post.clockPos = currentTime(); post.audioEl?.pause(); }
  $('playIco').innerHTML = on ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4l13 8-13 8z"/>';
}
let seeking = false;
function postTick() {
  let t = currentTime();
  if (post.playing && t >= post.trimE) { setPlaying(false); seekTo(post.trimE); t = post.trimE; }
  if (!seeking) $('seek').value = Math.round((t / state.proj.duration) * 1000);
  renderScene(vctx, view.width, view.height, post.tracks, frameAt(t), t, state.entry, state.bg);
  drawCaptionAt(vctx, view.width, view.height, t, dockTop());
  highlightCaption(t);
}

$('playBtn').onclick = () => setPlaying(!post.playing);
$('tapPlay').onclick = () => setPlaying(!post.playing);
$('seek').oninput = (e) => { seeking = true; seekTo((e.target.value / 1000) * state.proj.duration); };
$('seek').onchange = () => { seeking = false; };
$('backBtn').onclick = () => { setPlaying(false); buildCarousel($('liveChars')); show('live'); };

document.querySelectorAll('#postTabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#postTabs button').forEach((x) => x.classList.toggle('sel', x === b));
  document.querySelectorAll('#post .panel').forEach((p) => p.classList.toggle('on', p.id === b.dataset.p));
}));
$('smooth').value = post.smooth * 100; $('smoothVal').textContent = $('smooth').value;
$('smooth').oninput = (e) => { post.smooth = e.target.value / 100; $('smoothVal').textContent = e.target.value; resolveSoon(); };
$('gain').oninput = (e) => { post.strength = e.target.value / 100; $('gainVal').textContent = e.target.value + '%'; resolveSoon(); };
function updateTrimLabels() {
  $('tsVal').textContent = post.trimS.toFixed(1) + 's'; $('teVal').textContent = post.trimE.toFixed(1) + 's';
  $('durText').textContent = fmt(post.trimE - post.trimS);
}
$('trimStart').oninput = (e) => {
  const d = state.proj.duration;
  post.trimS = Math.min((e.target.value / 1000) * d, post.trimE - 0.5); e.target.value = (post.trimS / d) * 1000; seekTo(post.trimS); updateTrimLabels();
};
$('trimEnd').oninput = (e) => {
  const d = state.proj.duration;
  post.trimE = Math.max((e.target.value / 1000) * d, post.trimS + 0.5); e.target.value = (post.trimE / d) * 1000; seekTo(Math.max(post.trimS, post.trimE - 1)); updateTrimLabels();
};

function buildSwatches() {
  const el = $('bgSwatches'); el.innerHTML = '';
  for (const bg of BACKGROUNDS) {
    const s = document.createElement('button'); s.className = 'sw' + (bg === state.bg ? ' sel' : '');
    s.style.background = bg.css; s.ariaLabel = bg.label || bg.id; s.title = bg.label || '';
    s.onclick = () => { state.bg = bg; buildSwatches(); };
    el.append(s);
  }
  const up = document.createElement('button'); up.className = 'sw upload' + (state.bg.image ? ' sel' : '');
  up.textContent = '+'; up.ariaLabel = 'Upload image'; up.onclick = () => $('bgFile').click();
  el.append(up);
}
buildSwatches();
$('bgFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  state.bg = { id: 'image', image: await createImageBitmap(f) }; buildSwatches();
};

// --------------------------------------------------------------------- export
// Renders frames from the motion data and records them with the trimmed audio in real time.
// Before it starts, the export sheet picks the format, frame size and compression (remembered).

let exportJob = null;
const FORMATS = [
  { id: 'mp4', label: 'MP4', mimes: ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'] },
  { id: 'webm', label: 'WebM', mimes: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] },
].map((f) => ({ ...f, mime: f.mimes.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '' }));
const SIZES = [
  { id: '1080p', label: '1080×1920', note: '9:16', w: 1080, h: 1920 },
  { id: '720p', label: '720×1280', note: '9:16', w: 720, h: 1280 },
  { id: 'square', label: '1080×1080', note: '1:1', w: 1080, h: 1080 },
  { id: 'wide', label: '1920×1080', note: '16:9', w: 1920, h: 1080 },
];
// Bits per pixel per frame: the video bitrate scales with the frame size.
const QUALITIES = [
  { id: 'high', label: 'High quality', bpp: 0.15 },
  { id: 'medium', label: 'Balanced', bpp: 0.08 },
  { id: 'low', label: 'Small file', bpp: 0.035 },
];
const expPrefs = (() => { try { return JSON.parse(localStorage.getItem('avacam-export')) || {}; } catch { return {}; } })();
expPrefs.format = FORMATS.find((f) => f.id === expPrefs.format && f.mime) ? expPrefs.format : (FORMATS.find((f) => f.mime)?.id || 'webm');
expPrefs.size ||= '1080p'; expPrefs.quality ||= 'medium';
const pick = (list, id) => list.find((x) => x.id === id) || list[0];
const bitrate = () => { const z = pick(SIZES, expPrefs.size); return Math.round(z.w * z.h * FPS * pick(QUALITIES, expPrefs.quality).bpp); };

function buildExportOpts() {
  const chips = (el, list, key, extra = () => '') => {
    el.innerHTML = '';
    for (const o of list) {
      const b = document.createElement('button');
      b.className = 'vchip' + (expPrefs[key] === o.id ? ' sel' : '');
      b.innerHTML = o.label + extra(o);
      if (key === 'format' && !o.mime) { b.disabled = true; b.title = 'Not supported by this browser'; }
      b.onclick = () => { expPrefs[key] = o.id; try { localStorage.setItem('avacam-export', JSON.stringify(expPrefs)); } catch {} buildExportOpts(); };
      el.append(b);
    }
  };
  chips($('optFormat'), FORMATS, 'format');
  chips($('optSize'), SIZES, 'size', (o) => `<small>${o.note}</small>`);
  chips($('optQuality'), QUALITIES, 'quality');
  const mbMin = (bitrate() + (state.proj?.audio ? 128_000 : 0)) * 60 / 8 / 1e6;
  const dur = post.trimE - post.trimS;
  $('expMsg').textContent = `About ${(mbMin * dur / 60).toFixed(1)} MB for ${dur.toFixed(1)} s (${(bitrate() / 1e6).toFixed(1)} Mbps)`;
}

// ------------------------------------------------------------------ captions
// The original voice (before any effect) is transcribed, in whatever language it's spoken, into
// short timed lines; they're drawn on the preview and burned into the export, and can be edited.

const drawCaptionAt = (ctx, w, h, t, maxBottom) => { if (post.captions && post.capOn) drawCaption(ctx, w, h, captionAt(post.captions.lines, t), maxBottom); };
// In the preview the controls cover the bottom of the picture: keep the caption above them.
const dockTop = () => {
  const v = view.getBoundingClientRect(), d = document.querySelector('#post .dock').getBoundingClientRect();
  return v.height ? ((d.top - v.top) / v.height) * view.height : view.height;
};

function buildCaptionPanel() {
  const c = post.captions, list = $('capList');
  list.textContent = '';
  $('capTools').hidden = !c?.lines.length;
  $('capGo').textContent = c ? 'Extract again' : 'Extract captions';
  $('capGo').disabled = !state.proj?.audio;
  if (!state.proj?.audio) $('capStatus').textContent = 'This take has no sound to caption.';
  if (!c) return;
  for (const l of c.lines) {
    const row = document.createElement('div'); row.className = 'capline';
    const at = document.createElement('span'); at.className = 'mono'; at.textContent = l.start.toFixed(1) + 's';
    at.onclick = () => seekTo(l.start);
    const inp = document.createElement('input'); inp.value = l.text; inp.setAttribute('aria-label', `Caption at ${l.start.toFixed(1)} seconds`);
    inp.oninput = () => { l.text = inp.value; if (!post.playing) postTick(); };
    inp.onfocus = () => { setPlaying(false); seekTo(l.start + 0.05); };
    row.append(at, inp); list.append(row);
  }
}

let capLit = -1;
function highlightCaption(t) {
  const lines = post.captions?.lines;
  if (!lines) return;
  const i = lines.findIndex((l, k) => t >= l.start && t < (lines[k + 1]?.start ?? l.end + 0.5));
  if (i === capLit) return;
  capLit = i;
  [...$('capList').children].forEach((r, k) => r.classList.toggle('now', k === i));
  if (i >= 0 && document.activeElement?.parentElement?.parentElement !== $('capList')) $('capList').children[i]?.scrollIntoView({ block: 'nearest' });
}

$('capGo').onclick = async () => {
  if (!state.proj?.audio) return;
  const job = ++post.capJob, status = $('capStatus');
  $('capGo').disabled = true; status.classList.remove('err');
  status.textContent = 'Preparing…';
  try {
    post.buffer ||= await decode(state.proj.audio);
    const res = await extractCaptions(post.buffer, {
      language: $('capLang').value,
      onStatus: (m) => {
        if (job !== post.capJob) return;
        if (m.stage === 'download') status.textContent = `Downloading speech model… ${Math.round(m.value * 100)}%`;
        else if (m.stage === 'listen') status.textContent = 'Listening…';
        else if (m.stage === 'language') status.textContent = `Heard ${languageName(m.language)}. Writing captions…`;
      },
    });
    if (job !== post.capJob) return;
    post.captions = res; capLit = -1;
    status.textContent = res.lines.length ? `${languageName(res.language)} · ${res.lines.length} lines. Tap a line to edit it.` : 'No speech found in this take.';
    buildCaptionPanel();
    if (!post.playing) postTick();
  } catch (e) {
    if (job !== post.capJob) return;
    status.textContent = `Couldn't make captions: ${e.message}`; status.classList.add('err');
  }
  $('capGo').disabled = false;
};
$('capOn').onchange = (e) => { post.capOn = e.target.checked; if (!post.playing) postTick(); };
$('capSrt').onclick = () => {
  const srt = toSrt(post.captions.lines, post.trimS, post.trimE);
  const blob = new Blob([srt], { type: 'application/x-subrip' });
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `avacam-${Date.now()}.${post.captions.language}.srt` }).click();
};

$('exportBtn').onclick = () => {
  setPlaying(false);
  $('expOv').classList.add('on');
  $('expTitle').textContent = 'Export';
  $('expOpts').hidden = false; $('expGo').hidden = false; $('expBarWrap').hidden = true;
  $('expShare').hidden = true; $('expCancel').textContent = 'Cancel';
  buildExportOpts();
};

$('expGo').onclick = async () => {
  const ov = $('expOv');
  const size = pick(SIZES, expPrefs.size), fmt = pick(FORMATS, expPrefs.format);
  $('expOpts').hidden = true; $('expGo').hidden = true; $('expBarWrap').hidden = false;
  $('expTitle').textContent = 'Exporting…'; $('expMsg').textContent = `Rendering ${size.w}×${size.h}`;
  $('expBar').style.width = '0';
  if (state.entry.kind === 'blurb') await charFor(state.entry).load();

  const W = size.w, H = size.h;
  const out = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const octx = out.getContext('2d');
  const dur = post.trimE - post.trimS;
  const tracks = [...out.captureStream(FPS).getVideoTracks()];
  let actx = null, src = null;
  if (state.proj.audio) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    // Browsers may start an audio context suspended; export times itself on it, so start it.
    // (resume() can stay pending without a user gesture, so don't wait on it for long.)
    if (actx.state !== 'running') await Promise.race([actx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    post.buffer ||= await actx.decodeAudioData(await state.proj.audio.arrayBuffer());
    if ((post.voice !== 'none' || post.semis) && !post.fxBuffer) post.fxBuffer = await applyVoice(post.buffer, { preset: post.voice, semitones: post.semis });
    const dest = actx.createMediaStreamDestination();
    src = actx.createBufferSource(); src.buffer = post.fxBuffer || post.buffer; src.connect(dest);
    tracks.push(...dest.stream.getAudioTracks());
  }
  const mime = fmt.mime;
  const rec = new MediaRecorder(new MediaStream(tracks), { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: bitrate(), audioBitsPerSecond: 128_000 });
  const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const job = (exportJob = { cancelled: false });
  state.exporting = true;

  renderScene(octx, W, H, post.tracks, frameAt(post.trimS), post.trimS, state.entry, state.bg);
  drawCaptionAt(octx, W, H, post.trimS);
  rec.start(500);
  // The audio clock keeps sound and picture in step; the wall clock (a little behind) takes over
  // if the audio clock stalls (suspended context, no output device), so export always finishes.
  const a0 = actx ? actx.currentTime : 0, w0 = now();
  const clock = () => Math.max(actx ? actx.currentTime - a0 : 0, now() - w0 - 0.15);
  const t0 = 0;
  src?.start(0, post.trimS, dur);
  await new Promise((resolve) => {
    const step = () => {
      if (job.cancelled) return resolve();
      const el = clock() - t0;
      const t = post.trimS + Math.min(el, dur);
      renderScene(octx, W, H, post.tracks, frameAt(t), t, state.entry, state.bg);
      drawCaptionAt(octx, W, H, t);
      $('expBar').style.width = Math.min(100, (el / dur) * 100) + '%';
      if (el >= dur) return resolve();
      // A timer, not requestAnimationFrame: export keeps going if the page loses focus.
      setTimeout(step, 1000 / FPS);
    };
    step();
  });
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  try { src?.stop(); } catch {}
  actx?.close();
  state.exporting = false;
  if (job.cancelled) { ov.classList.remove('on'); return; }

  const type = rec.mimeType || mime || 'video/webm';
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type });
  const file = new File([blob], `avacam-${state.entry.id}-${Date.now()}.${ext}`, { type });
  $('expTitle').textContent = 'Ready';
  $('expMsg').textContent = `${ext.toUpperCase()} · ${W}×${H} · ${(blob.size / 1e6).toFixed(1)} MB · ${dur.toFixed(1)} s`;
  $('expShare').hidden = false; $('expCancel').textContent = 'Close';
  $('expShare').onclick = async () => {
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'AvaCam' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name }).click();
  };
};
$('expCancel').onclick = () => { if (exportJob) exportJob.cancelled = true; state.exporting = false; $('expOv').classList.remove('on'); };

// ---------------------------------------------------------------------- debug
// Open Post with N seconds of synthetic performance (no camera needed).
window.avatarCamDebug = {
  fakeTake(sec = 6, audio = null) {
    $('startOv').classList.remove('on');
    const samples = []; for (let t = 0; t <= sec; t += 1 / FPS) samples.push(demoSample(t));
    openPost({ samples, calib: [], audio, duration: sec });
  },
  pick(id) { const e = CAST.find((c) => c.id === id); if (e) pickCharacter(e); },
  /** Render one frame synchronously (the hidden preview pane pauses rAF). */
  draw(t = 1) {
    if (state.mode === 'post') renderScene(vctx, view.width, view.height, post.tracks, frameAt(t), t, state.entry, state.bg);
    else {
      const smp = demoSample(t); state.live.push(smp); const sol = state.live.solve();
      renderScene(vctx, view.width, view.height, sol ? sol.tracks : idleTracks, sol ? sol.frame : 0, t, state.entry, state.bg);
      hudT = 0; updateHud(t, sol, smp, !sol);
    }
  },
};
