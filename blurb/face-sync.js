/**
 * FaceSync — face-tracking samples → mouth timing + eye / brow / head motion.
 *
 * Input samples come from MediaPipe Face Landmarker (see src/ui/media.js):
 *   { t: seconds, bs: { jawOpen: 0..1, eyeBlinkLeft: …, … } | null, m: number[16] | null }
 * `bs` is the 52 ARKit-style blendshapes; `m` the 4×4 facial transform (column-major).
 *
 * Everything is calibrated against the performer's own neutral (median) pose,
 * so camera angle and resting expression don't leak into the animation.
 */
const FaceSync = (() => {
    const M = typeof Motion !== 'undefined' ? Motion : require('./motion.js');
    const L = typeof LipSync !== 'undefined' ? LipSync : require('./lipsync.js');

    const median = (values) => {
        const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
        return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    };
    const avg = (bs, a, b) => ((bs[a] || 0) + (bs[b] || 0)) / 2;
    const DEG = 180 / Math.PI;

    /** Head yaw / pitch / roll in degrees from a column-major 4×4 transform. */
    function headPose(m) {
        if (!m || m.length < 16) return null;
        const r = (row, col) => m[col * 4 + row];
        return {
            pitch: Math.atan2(r(2, 1), r(2, 2)) * DEG,
            yaw: Math.asin(M.clamp(-r(2, 0), -1, 1)) * DEG,
            roll: Math.atan2(r(1, 0), r(0, 0)) * DEG,
        };
    }

    /**
     * Head pose from face-mesh geometry (degrees). More faithful than the
     * transform matrix for big turns, whose yaw under-reads and bleeds into roll:
     *  - yaw: where the nose tip sits between the two cheek edges
     *  - roll: angle of the line through the outer eye corners
     *  - pitch: how far the forehead→chin line tips toward or away from the camera,
     *    from the mesh's depth (z); without depth, the nose tip's height between
     *    forehead and chin (a 2-D cue that flattens out on big nods)
     * `key` points are [x, y, z] with x (and z) already scaled to square pixels.
     * Positive pitch = looking down.
     */
    function landmarkPose(key) {
        if (!key || !key.nose) return null;
        const { nose, cheekL, cheekR, eyeOuterL, eyeOuterR, forehead, chin } = key;
        const width = cheekR[0] - cheekL[0];
        if (Math.abs(width) < 1e-6) return null;
        const r = (nose[0] - cheekL[0]) / width; // 0.5 when facing the camera
        // Linear in the ratio: an arcsine saturates at 90° once the far cheek hides behind
        // the nose. Gain 150 puts a true side-on turn (ratio near 0 or 1) at ~75°.
        const yaw = M.clamp((r - 0.5) * 150, -75, 75);
        const roll = Math.atan2(eyeOuterR[1] - eyeOuterL[1], eyeOuterR[0] - eyeOuterL[0]) * DEG;
        let pitch;
        if (Number.isFinite(chin[2]) && Number.isFinite(forehead[2])) {
            // Looking down brings the forehead toward the camera (smaller z) and takes
            // the chin away; the image-plane length keeps it independent of head tilt.
            pitch = Math.atan2(chin[2] - forehead[2], Math.hypot(chin[0] - forehead[0], chin[1] - forehead[1])) * DEG;
        } else {
            const height = chin[1] - forehead[1];
            const v = height ? (nose[1] - forehead[1]) / height : 0.55;
            pitch = Math.asin(M.clamp((v - 0.55) * 2.2, -1, 1)) * DEG;
        }
        return { yaw, pitch, roll };
    }

    /**
     * Head pose for one sample: mesh geometry for yaw and roll; pitch averages the
     * mesh-depth reading with the transform matrix (they agree closely, and
     * together they're steadier on big nods than either alone).
     */
    function combinedPose(s) {
        const geo = landmarkPose(s.key);
        const mat = headPose(s.m);
        if (!geo) return mat;
        if (mat && Number.isFinite(mat.pitch) && s.key && Number.isFinite(s.key.chin[2])) return { ...geo, pitch: (geo.pitch + mat.pitch) / 2 };
        return geo;
    }

    /**
     * Expression geometry from the mesh (null without the extra key points), all
     * as fractions of face height, measured along the face's own up/across axes
     * so head tilt doesn't change them:
     *  - brow (L/R): mid-brow height above the outer eye corner (the corner stays
     *    put when the eyes widen; the upper lid doesn't)
     *  - inner (L/R): the inner brow end's height above the same corner — inner
     *    minus brow is the brow slant (sad: inner ends up; angry: pulled down)
     *  - furrow: gap between the inner brow ends (÷ face width) — shrinks in a scowl
     *  - eye (L/R): lid opening
     *  - corner: mouth corners' height relative to the top of the upper lip
     *    (up in a smile, down in a frown)
     */
    function faceShape(key) {
        if (!key || !key.browMidL || !key.lidTopL || !key.mouthL) return null;
        const ux = key.forehead[0] - key.chin[0];
        const uy = key.forehead[1] - key.chin[1];
        const H = Math.hypot(ux, uy);
        if (H < 1e-6) return null;
        const up = [ux / H, uy / H];
        const across = [-up[1], up[0]];
        const rise = (a, b) => ((a[0] - b[0]) * up[0] + (a[1] - b[1]) * up[1]) / H; // a above b
        const W = Math.abs((key.cheekR[0] - key.cheekL[0]) * across[0] + (key.cheekR[1] - key.cheekL[1]) * across[1]) || H;
        const cornerMid = [(key.mouthL[0] + key.mouthR[0]) / 2, (key.mouthL[1] + key.mouthR[1]) / 2];
        return {
            browL: rise(key.browMidL, key.eyeOuterL),
            browR: rise(key.browMidR, key.eyeOuterR),
            innerL: rise(key.browInnerL, key.eyeOuterL),
            innerR: rise(key.browInnerR, key.eyeOuterR),
            furrow: Math.hypot(key.browInnerR[0] - key.browInnerL[0], key.browInnerR[1] - key.browInnerL[1]) / W,
            eyeL: rise(key.lidTopL, key.lidBotL),
            eyeR: rise(key.lidTopR, key.lidBotR),
            corner: rise(cornerMid, key.lipTop),
        };
    }

    /** Lip blendshapes → one of the 8 visemes. */
    function visemeFromBlendshapes(bs) {
        if (!bs) return L.REST;
        const jaw = bs.jawOpen || 0;
        const pucker = bs.mouthPucker || 0;
        const funnel = bs.mouthFunnel || 0;
        const rollLower = bs.mouthRollLower || 0;
        const press = avg(bs, 'mouthPressLeft', 'mouthPressRight');
        const wide = avg(bs, 'mouthSmileLeft', 'mouthSmileRight') + avg(bs, 'mouthStretchLeft', 'mouthStretchRight');

        if (rollLower > 0.3 && jaw < 0.25) return 'FV';
        if (jaw < 0.06 && pucker < 0.35 && funnel < 0.2) return press > 0.15 || (bs.mouthClose || 0) > 0.15 ? 'MBP' : L.REST;
        if (pucker > 0.45) return jaw > 0.2 ? 'O' : 'U';
        if (funnel > 0.25) return 'O';
        if (jaw > 0.35) return 'A';
        if (wide > 0.35) return jaw < 0.15 ? 'I' : 'E';
        return jaw > 0.12 ? 'E' : 'I';
    }

    /**
     * Expression strengths (0..1) from one frame's blendshapes, before
     * per-performer calibration:
     *  - smile: lip corners up (mouthSmile), helped by cheek squint
     *  - laugh: a smile with the jaw open and the eyes squeezed (a real laugh, not
     *    just talking while smiling)
     *  - frown: lip corners down (mouthFrown) and lowered brows, cancelled by a smile
     */
    function expressionOf(bs) {
        if (!bs) return { smile: 0, laugh: 0, frown: 0 };
        const smileRaw = avg(bs, 'mouthSmileLeft', 'mouthSmileRight');
        const squint = avg(bs, 'cheekSquintLeft', 'cheekSquintRight');
        const jaw = bs.jawOpen || 0;
        const browDown = avg(bs, 'browDownLeft', 'browDownRight');
        const smile = M.clamp((smileRaw - 0.12) / 0.4 + squint * 0.25, 0, 1);
        const laugh = M.clamp(smile * M.clamp((jaw - 0.18) / 0.3, 0, 1) * (0.55 + M.clamp((squint - 0.15) / 0.3, 0, 1)), 0, 1);
        const frown = M.clamp((avg(bs, 'mouthFrownLeft', 'mouthFrownRight') - 0.06) / 0.3 + browDown * 0.35 - smile * 0.8, 0, 1);
        return { smile, laugh, frown };
    }

    /**
     * Expression strength tracks (0..1 per frame) for a clip, calibrated to the
     * performer's own resting face (medians), from blendshapes plus mesh shape:
     *  - smile     lip corners up (mouthSmile)
     *  - laugh     a smile with the eyes squeezed and the mouth/teeth open
     *  - squeeze   eyes narrowed below their resting opening (cheeks pushing up)
     *  - sad       inner brow ends raised (outer ones not), lips pushed or corners down, no smile
     *  - angry     inner brow ends pulled down + brows lowered, eyes not wide, no smile
     *  - surprise  eyes wide open with brows up
     *  - frown     sad or angry (either turns the resting mouth down)
     * Without the mesh points (older captures) only smile / laugh / frown come
     * from the blendshapes.
     */
    function expressionTracks(tracked, frameTimes, fps) {
        const smoothN = Math.max(1, Math.round(0.12 * fps));
        const track = (values) => M.decimate(M.smooth(values, smoothN).map((v) => M.clamp(v, 0, 1)), 0.03);
        const at = (pick) => frameTimes.map(sampler(tracked, pick));
        const pct = (values, q) => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(q * (v.length - 1))] : 0; };
        // Smile: calibrated so a naturally upturned mouth is neutral, capped so a smile
        // held through the whole clip still counts.
        const smileRaw = at((s) => expressionOf(s.bs).smile);
        const smileBase = Math.min(0.25, pct(smileRaw, 0.15));
        const smile = smileRaw.map((v) => M.clamp((v - smileBase) / (1 - smileBase), 0, 1));

        const shapes = tracked.map((s) => ({ t: s.t, g: faceShape(s.key), bs: s.bs })).filter((x) => x.g);
        if (shapes.length < tracked.length * 0.5) {
            // Older captures: blendshapes only.
            const legacy = (key) => { const raw = at((s) => expressionOf(s.bs)[key]); const b = Math.min(0.25, pct(raw, 0.15)); return raw.map((v) => M.clamp((v - b) / (1 - b), 0, 1)); };
            return { smile: track(smile), laugh: track(legacy('laugh')), frown: track(legacy('frown')) };
        }
        const g = (pick) => frameTimes.map(sampler(shapes, (x) => pick(x.g, x.bs)));
        const eye = g((x) => (x.eyeL + x.eyeR) / 2);
        const brow = g((x) => (x.browL + x.browR) / 2);
        const slant = g((x) => ((x.innerL - x.browL) + (x.innerR - x.browR)) / 2);
        const corner = g((x) => x.corner);
        const bs = (name) => at((s) => s.bs[name] || 0);
        const avg2 = (a, b) => bs(a).map((v, i) => (v + bs(b)[i]) / 2);
        const jaw = bs('jawOpen');
        const teeth = avg2('mouthUpperUpLeft', 'mouthUpperUpRight');
        const pucker = bs('mouthPucker');
        const outerUp = avg2('browOuterUpLeft', 'browOuterUpRight');
        const e0 = median(eye) || 0.05;
        const b0 = median(brow);
        const s0 = median(slant);
        const c0 = median(corner);
        const n = frameTimes.length;
        const out = { smile, laugh: [], squeeze: [], sad: [], angry: [], surprise: [], frown: [] };
        for (let f = 0; f < n; f++) {
            const squeeze = M.clamp((e0 - eye[f]) / e0 / 0.45, 0, 1);
            const wide = M.clamp((eye[f] - e0) / e0 / 0.35, 0, 1);
            const open = M.clamp(Math.max(jaw[f] / 0.15, teeth[f] / 0.5), 0, 1);
            const notSmiling = 1 - M.clamp(smile[f] * 1.5, 0, 1);
            const lowered = M.clamp((b0 - brow[f]) / 0.02, 0, 1);
            const slantDev = slant[f] - s0;
            // A laugh squeezes the eyes hard; talking through a smile only narrows them a little.
            const laugh = M.clamp(smile[f] * 1.2, 0, 1) * M.clamp((squeeze - 0.3) / 0.3, 0, 1) * open;
            const mouthSad = Math.max(M.clamp((pucker[f] - 0.12) / 0.2, 0, 1) * 0.6, M.clamp((c0 - corner[f] - 0.015) / 0.025, 0, 1) * (1 - M.clamp(jaw[f] / 0.12, 0, 1)));
            // Sad brows lift only at the inner ends; with the outer brows up too it's
            // excitement or surprise, not sadness.
            const outerCalm = 1 - M.clamp((outerUp[f] - 0.25) / 0.3, 0, 1);
            const sad = notSmiling * outerCalm * M.clamp(M.clamp((slantDev - 0.005) / 0.012, 0, 1) * 0.8 + mouthSad * 0.4, 0, 1);
            const angry = notSmiling * (1 - wide) * M.clamp((-slantDev - 0.014) / 0.02, 0, 1) * M.clamp(0.4 + lowered, 0, 1);
            const surprise = M.clamp((wide - 0.35) / 0.45, 0, 1) * M.clamp(0.4 + outerUp[f] * 1.5, 0, 1) * (1 - M.clamp(smile[f], 0, 1) * 0.5);
            out.laugh.push(laugh);
            out.squeeze.push(squeeze);
            out.sad.push(sad);
            out.angry.push(angry);
            out.surprise.push(surprise);
            out.frown.push(Math.max(sad, angry));
        }
        return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, track(v)]));
    }

    /** Value of `pick(sample)` at time t, linearly interpolated, holding over dropouts. */
    function sampler(samples, pick) {
        const pts = samples.map((s) => [s.t, pick(s)]).filter(([, v]) => Number.isFinite(v));
        return (t) => {
            if (pts.length === 0) return NaN;
            if (t <= pts[0][0]) return pts[0][1];
            let lo = 0;
            let hi = pts.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (pts[mid][0] <= t) lo = mid; else hi = mid;
            }
            const [ta, va] = pts[lo];
            const [tb, vb] = pts[hi];
            if (t >= tb) return vb;
            return va + ((vb - va) * (t - ta)) / (tb - ta || 1);
        };
    }

    /**
     * Build the animation from tracked samples.
     * opts: { fps, totalFrames, strength=1, mirror=true, mouth=true, eyes=true, brows=true, head=true, gaze=true, shoulders=true, expression=true }
     * Returns { events (for LipSync.buildSegments), extras (Motion rig channels), faceRatio }.
     */
    function samplesToRig(samples, opts) {
        const { fps, totalFrames } = opts;
        const strength = opts.strength == null ? 1 : opts.strength;
        const mirror = opts.mirror !== false;
        const tracked = samples.filter((s) => s.bs);
        const faceRatio = samples.length ? tracked.length / samples.length : 0;
        const frameTimes = Array.from({ length: totalFrames }, (_, f) => f / fps);
        const result = { events: [], extras: {}, faceRatio };
        if (tracked.length === 0) return result;

        // In a mirrored (selfie) view the performer's left eye drives the character's screen-left eye.
        const side = (name, screenLeft) => (screenLeft === mirror ? `${name}Left` : `${name}Right`);

        // Jaw opening per frame, normalised to this performer: people (and fast
        // speech) open the jaw far less than the model's 0..1 range, so absolute
        // thresholds would never reach the open shapes.
        const jawAt = sampler(tracked, (s) => (s.bs.jawOpen || 0) + 0.3 * (s.bs.mouthFunnel || 0));
        const jawRaw = frameTimes.map(jawAt);
        const sortedJaw = jawRaw.filter(Number.isFinite).slice().sort((a, b) => a - b);
        const jawScale = Math.max(0.12, sortedJaw[Math.floor(0.95 * (sortedJaw.length - 1))] || 0);
        const jawNorm = jawRaw.map((v) => M.clamp(v / jawScale, 0, 1.3));
        result.jaw = jawNorm.map((v) => Math.min(1, v));

        if (opts.mouth !== false) {
            // Nearest sample per frame — visemes are discrete. Classification sees the
            // normalised jaw (1.0 → a wide-open "A").
            let j = 0;
            const nearest = new Array(frameTimes.length);
            const shapes = frameTimes.map((t, f) => {
                while (j < tracked.length - 1 && Math.abs(tracked[j + 1].t - t) <= Math.abs(tracked[j].t - t)) j++;
                nearest[f] = j;
                return visemeFromBlendshapes({ ...tracked[j].bs, jawOpen: jawNorm[f] * 0.55 });
            });
            // Syllable closures: in fast speech the mouth rarely shuts, but each
            // syllable still dips between two openings. Mark the bottom of each dip.
            const W = Math.max(2, Math.round(0.15 * fps));
            for (let f = 1; f < jawNorm.length - 1; f++) {
                const v = jawNorm[f];
                if (v > jawNorm[f - 1] || v > jawNorm[f + 1]) continue;
                const before = Math.max(...jawNorm.slice(Math.max(0, f - W), f));
                const after = Math.max(...jawNorm.slice(f + 1, f + 1 + W));
                if (before - v > 0.3 && after - v > 0.3 && v < 0.45) {
                    const bs = tracked[nearest[f]].bs;
                    shapes[f] = (bs.mouthClose || 0) > 0.08 || avg(bs, 'mouthPressLeft', 'mouthPressRight') > 0.08 ? 'MBP' : L.REST;
                }
            }
            for (let f = 0, start = 0; f <= shapes.length; f++) {
                if (f === shapes.length || shapes[f] !== shapes[start]) {
                    result.events.push({ shape: shapes[start], startMs: (start / fps) * 1000, endMs: (f / fps) * 1000 });
                    start = f;
                }
            }
        }

        if (opts.eyes !== false) {
            // Looking down (eyes or whole head) lowers the lids without a blink, and
            // the blink reading rises with it; take that share back out.
            const pitchOf = (s) => { const p = combinedPose(s); return p ? p.pitch : 0; };
            const pitchRest = median(tracked.map(pitchOf).filter(Number.isFinite));
            const eye = (screenLeft) => {
                const at = sampler(tracked, (s) => (s.bs[side('eyeBlink', screenLeft)] || 0)
                    - 0.55 * (s.bs[side('eyeLookDown', screenLeft)] || 0)
                    - 0.008 * M.clamp(pitchOf(s) - pitchRest, 0, 30));
                const raw = frameTimes.map(at);
                const open = median(raw); // performer's resting lid position
                // Blinks are quick (≈0.1–0.3 s); squints held while smiling, laughing or
                // scowling last longer. Measuring against a moving baseline (a low
                // percentile over ~1.2 s) keeps blinks and drops the held squint, which
                // the expression tracks show instead (happy or narrowed eyes).
                const half = Math.max(2, Math.round(0.6 * fps));
                const local = raw.map((_, f) => {
                    const w = raw.slice(Math.max(0, f - half), f + half + 1).filter(Number.isFinite).sort((a, b) => a - b);
                    return w.length ? w[Math.floor(0.3 * (w.length - 1))] : open;
                });
                const fromScore = raw.map((v, f) => M.clamp((v - Math.max(open, local[f]) - 0.12) / 0.45, 0, 1) * 100);
                // The mesh shows blinks more clearly than the blink score on some faces
                // (behind glasses the score may never pass ~0.7): the lid gap drops to
                // near zero. Compare it with its own recent open level, so held squints
                // and looking down (slow, sustained) don't count.
                const meshKey = `eye${screenLeft === mirror ? 'R' : 'L'}`;
                const lids = tracked.map((s) => ({ t: s.t, g: faceShape(s.key) })).filter((x) => x.g);
                if (lids.length < tracked.length * 0.5) return fromScore;
                const gap = frameTimes.map(sampler(lids, (x) => x.g[meshKey]));
                const openLevel = gap.map((_, f) => {
                    const w = gap.slice(Math.max(0, f - half), f + half + 1).filter(Number.isFinite).sort((a, b) => a - b);
                    return w.length ? w[Math.floor(0.7 * (w.length - 1))] : 0;
                });
                return fromScore.map((v, f) => {
                    const ratio = openLevel[f] > 1e-4 ? gap[f] / openLevel[f] : 1;
                    return Math.max(v, M.clamp((0.7 - ratio) / 0.5, 0, 1) * 100);
                });
            };
            const left = eye(true);
            const right = eye(false);
            // Eyes blink together: the two readings rarely match exactly, which
            // would show as an accidental wink. Link them unless one eye is clearly
            // shut while the other is open (a real wink).
            for (let f = 0; f < left.length; f++) {
                if (Math.abs(left[f] - right[f]) < 45) left[f] = right[f] = Math.max(left[f], right[f]);
            }
            result.extras.eyes = { left: M.decimate(left, 4, 0), right: M.decimate(right, 4, 0) };
        }

        if (opts.brows !== false) {
            // Raising comes from the blendshapes (reliable for brows going up); lowering
            // and the slant come from the mesh, because browDown barely registers on
            // many faces (a scowl can read 0.0). Mesh sides are image sides, so the
            // character's screen-left brow is the image's right one when mirrored.
            const shapes = tracked.map((s) => ({ t: s.t, g: faceShape(s.key) })).filter((x) => x.g);
            const meshSide = (screenLeft) => (screenLeft === mirror ? 'R' : 'L');
            const brow = (screenLeft) => {
                const outer = side('browOuterUp', screenLeft);
                const down = side('browDown', screenLeft);
                const at = sampler(tracked, (s) => Math.max(s.bs.browInnerUp || 0, s.bs[outer] || 0) - (s.bs[down] || 0));
                const raw = M.smooth(frameTimes.map(at), Math.round(0.04 * fps));
                const rest = median(raw);
                let y = raw.map((v) => M.clamp(-(v - rest) * 14 * strength, -10, 6));
                let tilt = raw.map((v) => M.clamp((rest - v) * 18 * strength, -12, 12) * (screenLeft ? 1 : -1));
                if (shapes.length > tracked.length * 0.5) {
                    const k = meshSide(screenLeft);
                    const smoothAt = (pick) => M.smooth(frameTimes.map(sampler(shapes, pick)), Math.max(1, Math.round(0.08 * fps)));
                    const height = smoothAt((x) => x.g[`brow${k}`]);
                    const slant = smoothAt((x) => x.g[`inner${k}`] - x.g[`brow${k}`]);
                    const eyeOpen = smoothAt((x) => (x.g.eyeL + x.g.eyeR) / 2);
                    const smiling = M.smooth(frameTimes.map(sampler(tracked, (s) => expressionOf(s.bs).smile)), Math.max(1, Math.round(0.08 * fps)));
                    const h0 = median(height);
                    const s0 = median(slant);
                    const e0 = median(eyeOpen) || 0.05;
                    y = y.map((v, f) => {
                        // A smile's cheeks lift the eye corners, which only looks like lowered brows.
                        const calm = 1 - M.clamp(smiling[f] * 1.5, 0, 1);
                        // Lowered brows (face heights → art px, down = +y); raising stays blendshape-driven.
                        return M.clamp(v + Math.max(0, h0 - height[f]) * 260 * strength * calm, -10, 9);
                    });
                    // Slant: inner end down (angry) / up (sad). Clockwise lowers the right
                    // end, which is the inner end of the screen-left brow. Wide eyes mean
                    // surprise (outer brows up, not inner ends down), so no angry slant then.
                    tilt = slant.map((v, f) => {
                        const calm = 1 - M.clamp(smiling[f] * 1.5, 0, 1);
                        const wide = M.clamp((eyeOpen[f] - e0) / e0 / 0.35, 0, 1);
                        let dev = v - s0;
                        if (dev < 0) dev *= 1 - wide;
                        return M.clamp(-dev * 520 * strength * calm, -16, 16) * (screenLeft ? 1 : -1);
                    });
                }
                return { y: M.decimate(y, 0.2), rotation: M.decimate(tilt, 0.3) };
            };
            result.extras.brows = { left: brow(true), right: brow(false) };
        }

        if (opts.head !== false) {
            // Prefer mesh-geometry pose; fall back to the transform matrix (older captures).
            const poses = tracked.map((s) => ({ t: s.t, p: combinedPose(s) })).filter((s) => s.p);
            if (poses.length) {
                // Calibrate against the performer's resting pose — except tilt: upright is
                // the true rest there, so tilt is taken as measured (level camera assumed).
                // Otherwise a tilt held for much of the clip would be cancelled out.
                const channel = (key, { smoothSec = 0.07, restLimit = Infinity } = {}) => {
                    const at = sampler(poses, (s) => s.p[key]);
                    const raw = M.smooth(frameTimes.map(at), Math.max(1, Math.round(smoothSec * fps)));
                    const rest = M.clamp(median(raw), -restLimit, restLimit);
                    return raw.map((v) => v - rest);
                };
                const flip = mirror ? -1 : 1;
                // Degrees, consumed by the faux-3D rig: yaw/pitch become parallax, roll rotates the head.
                const roll = channel('roll', { smoothSec: 0.04, restLimit: 0 }).map((v) => M.clamp(v * flip * strength, -25, 25));
                // Wide range: past ~22° the rig switches to a ¾ drawing (see Rig.viewTrack).
                const yaw = channel('yaw').map((v) => M.clamp(v * flip * strength, -75, 75));
                // Nods up and down read fully (the rig soft-limits what the art can show).
                const pitch = channel('pitch').map((v) => M.clamp(v * strength, -35, 35));
                result.extras.head = { roll: M.decimate(roll, 0.25), yaw: M.decimate(yaw, 0.25), pitch: M.decimate(pitch, 0.25) };

                // Head position in the frame (transform translation, cm): sway, bob, and lean in/out.
                const moves = tracked.map((s) => ({ t: s.t, m: s.m })).filter((s) => s.m && s.m.length >= 16 && Number.isFinite(s.m[14]) && s.m[14] !== 0);
                if (moves.length) {
                    const axis = (i) => {
                        const at = sampler(moves, (s) => s.m[i]);
                        return M.smooth(frameTimes.map(at), Math.round(0.08 * fps));
                    };
                    const tx = axis(12);
                    const ty = axis(13);
                    const tz = axis(14);
                    const rx = median(tx);
                    const ry = median(ty);
                    const rz = median(tz);
                    const PX_PER_CM = 6;
                    const x = tx.map((v) => M.clamp((v - rx) * PX_PER_CM * flip * strength, -40, 40));
                    const y = ty.map((v) => M.clamp(-(v - ry) * PX_PER_CM * strength, -30, 30));
                    const scale = tz.map((v) => M.clamp(1 + (Math.abs(rz) / Math.abs(v) - 1) * 0.6 * strength, 0.85, 1.2));
                    Object.assign(result.extras.head, { x: M.decimate(x, 0.25), y: M.decimate(y, 0.25), scale: M.decimate(scale, 0.003, 3) });
                }
            }
        }

        if (opts.shoulders !== false) {
            // Neck & shoulders from the pose model: shoulder-line tilt, torso sway/bob.
            const posed = samples.filter((smp) => smp.pose && smp.pose.shoulderL && smp.pose.shoulderR);
            if (posed.length > samples.length * 0.3) {
                const flipB = mirror ? -1 : 1;
                // Pose landmark 11 (performer's left shoulder) is on the image's right, so measure
                // image-left → image-right (12 → 11): near 0° when level, the same sense as the
                // head-roll line, and never near the ±180° wrap that made tilt jump.
                const line = sampler(posed, (smp) => Math.atan2(smp.pose.shoulderL[1] - smp.pose.shoulderR[1], smp.pose.shoulderL[0] - smp.pose.shoulderR[0]) * DEG);
                const midX = sampler(posed, (smp) => (smp.pose.shoulderL[0] + smp.pose.shoulderR[0]) / 2);
                const midY = sampler(posed, (smp) => (smp.pose.shoulderL[1] + smp.pose.shoulderR[1]) / 2);
                const width = median(posed.map((smp) => Math.abs(smp.pose.shoulderR[0] - smp.pose.shoulderL[0])));
                const ART_SHOULDERS = 220; // shoulder width of the characters' torsos, artwork px
                const k = width > 1e-3 ? ART_SHOULDERS / width : 0;
                const smoothT = (arr) => M.smooth(arr, Math.round(0.1 * fps));
                const tilt = smoothT(frameTimes.map(line));
                const mx = smoothT(frameTimes.map(midX));
                const my = smoothT(frameTimes.map(midY));
                const [rt, rx2, ry2] = [median(tilt), median(mx), median(my)];
                result.extras.body = {
                    roll: M.decimate(tilt.map((v) => M.clamp((v - rt) * flipB * strength, -12, 12)), 0.2),
                    x: M.decimate(mx.map((v) => M.clamp((v - rx2) * k * flipB * strength, -40, 40)), 0.25),
                    y: M.decimate(my.map((v) => M.clamp((v - ry2) * k * strength, -20, 20)), 0.25),
                };
            }
        }

        if (opts.expression !== false) {
            result.extras.expression = expressionTracks(tracked, frameTimes, fps);
        }

        if (opts.gaze !== false) {
            // Where the performer looks, from the eye-look blendshapes (-1..1 of iris travel).
            // Horizontal: toward the performer's own left is +; the mirror flips it to screen space.
            const look = (s, k) => s.bs[k] || 0;
            const leftward = sampler(tracked, (s) => ((look(s, 'eyeLookOutLeft') - look(s, 'eyeLookInLeft')) + (look(s, 'eyeLookInRight') - look(s, 'eyeLookOutRight'))) / 2);
            const down = sampler(tracked, (s) => (look(s, 'eyeLookDownLeft') + look(s, 'eyeLookDownRight') - look(s, 'eyeLookUpLeft') - look(s, 'eyeLookUpRight')) / 2);
            const lx = M.smooth(frameTimes.map(leftward), 1);
            const ly = M.smooth(frameTimes.map(down), 1);
            const restX = median(lx);
            const restY = median(ly);
            const dir = mirror ? -1 : 1;
            const x = lx.map((v) => M.clamp((v - restX) * 1.6 * dir, -1, 1));
            const y = ly.map((v) => M.clamp((v - restY) * 1.4, -1, 1));
            result.extras.gaze = { x: M.decimate(x, 0.04), y: M.decimate(y, 0.04) };
        }

        return result;
    }

    return { headPose, landmarkPose, combinedPose, faceShape, visemeFromBlendshapes, expressionOf, samplesToRig };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FaceSync;
}
