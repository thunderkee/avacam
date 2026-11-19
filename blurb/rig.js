/**
 * Rig — turns timelines (mouth segments + Motion extras) into per-layer
 * animation descriptors the plugin sandbox applies, for either
 *   • a built-in character (parts imported as layers), or
 *   • the user's own selected layers (matched by name).
 *
 * An animation descriptor (`anim`) is relative to the layer's current values:
 *   { opacity?: track (0..100, absolute; stepped swaps unless opacitySmooth), scaleY?: track (factor of base),
 *     dx?, dy?: track (artwork px), rotation?: track (degrees added) }
 *
 * Character data shape (from scripts/characters.mjs):
 *   { id, name, size, pivot, defs, parts: [{ id, name, role, side?, state?, key?, group, body }],
 *     visemeArt?: { A: 'AA', … } }   // when mouths are keyed by phoneme
 */
const Rig = (() => {
    const L = typeof LipSync !== 'undefined' ? LipSync : require('./lipsync.js');
    const M = typeof Motion !== 'undefined' ? Motion : require('./motion.js');

    const EYE_STATES = ['open', 'half', 'closed'];
    const eyeState = (closure) => (closure < 35 ? 'open' : closure < 75 ? 'half' : 'closed');

    /** Which mouth part draws a shape key on this character. */
    function resolveMouth(character, key) {
        const mouths = new Map(character.parts.filter((p) => p.role === 'mouth').map((p) => [p.key, p]));
        if (mouths.has(key)) return mouths.get(key);
        if (character.visemeArt && character.visemeArt[key] && mouths.has(character.visemeArt[key])) return mouths.get(character.visemeArt[key]);
        const viseme = L.PHONEME_TO_VISEME[key];
        if (viseme && mouths.has(viseme)) return mouths.get(viseme);
        return mouths.get(L.REST);
    }

    function mergeSame(segments) {
        const out = [];
        for (const s of segments) {
            const prev = out[out.length - 1];
            if (prev && prev.key === s.key) prev.end = s.end;
            else out.push({ ...s });
        }
        return out;
    }

    /** Eye closure track (0..100) → open / half / closed segments over all frames. */
    function eyeSegments(track, totalFrames) {
        const segs = [];
        for (let f = 0; f < totalFrames; f++) segs.push({ key: eyeState(track ? M.valueAt(track, f) : 0), start: f, end: f + 1 });
        return mergeSame(segs);
    }

    const rad = Math.PI / 180;
    const sample = (track, n) => Array.from({ length: n }, (_, f) => (track && track.length ? M.valueAt(track, f) : 0));

    /** Per-frame gaze for one eye in -1..1 (shared gaze or per-eye). */
    function gazeFor(extras, side, n) {
        const g = extras.gaze;
        if (!g) return { x: new Array(n).fill(0), y: new Array(n).fill(0) };
        const eye = g.left || g.right ? g[side === 'L' ? 'left' : 'right'] || g.left || g.right : g;
        return { x: sample(eye.x, n), y: sample(eye.y, n) };
    }

    /**
     * Built-in character → { layers: [{ partId, name, group, anim }], head: anim | null }.
     * Layers are in stacking order (bottom → top).
     *
     * Faux 3D: head yaw / pitch (degrees) shift every head part by its `depth`
     * (parallax), squash parts narrow with the turn, and the neck null carries
     * roll plus a little drift. Irises add gaze on top of their parallax.
     */
    /**
     * Which drawing each frame uses: front, or a ¾ view once the head turns past
     * `enter` degrees (and back below `exit` — hysteresis stops flicker).
     */
    function viewTrack(character, rawYaw, lock, { profile = true } = {}) {
        const tv = character.turnViews;
        const has = (v) => character.parts.some((p) => p.view === v);
        // Locked side view: the profile drawing for the whole clip (when the character has one).
        if (lock && has(lock)) return rawYaw.map(() => lock);
        if (!tv || !has('R') || !has('L')) return rawYaw.map(() => 'F');
        // `profile: false` caps big turns at the ¾ drawing (no side view).
        const side = profile && tv.profile && has('PR') && has('PL') ? tv.profile : null;
        // Ladder of drawings by turn: front ↔ ¾ ↔ profile, each step with hysteresis.
        const level = { F: 0, R: 1, L: 1, PR: 2, PL: 2 };
        let view = 'F';
        return rawYaw.map((y) => {
            const a = Math.abs(y);
            const dirKey = y >= 0 ? 'R' : 'L';
            let lvl = level[view];
            const sameSide = view === 'F' || view.endsWith(dirKey);
            if (!sameSide) lvl = a > tv.enter ? 1 : 0; // swung across: re-pick from the angle
            else if (lvl === 0 && a > tv.enter) lvl = 1;
            else if (lvl === 1 && side && a > side.enter) lvl = 2;
            else if (lvl === 2 && a < side.exit) lvl = a > tv.exit ? 1 : 0;
            else if (lvl === 1 && a < tv.exit) lvl = 0;
            view = lvl === 0 ? 'F' : lvl === 1 ? dirKey : `P${dirKey}`;
            return view;
        });
    }

    /**
     * Expression per frame — 'laugh' | 'smile' | 'frown' | null — from the 0..1
     * strength tracks, with hysteresis (on above `on`, off below `off`) and a
     * minimum hold so a flicker of a smile doesn't swap the mouth for one frame.
     */
    // Priority order: a laugh outranks a smile, which outranks the rest. 'frown' is the
    // older, combined sad-or-angry track (captures without mesh points).
    const EXPR = {
        laugh: { on: 0.5, off: 0.32 },
        smile: { on: 0.45, off: 0.28 },
        angry: { on: 0.45, off: 0.28 },
        sad: { on: 0.45, off: 0.28 },
        frown: { on: 0.45, off: 0.28 },
        surprise: { on: 0.5, off: 0.3 },
    };
    const EXPR_ORDER = ['laugh', 'smile', 'angry', 'sad', 'frown', 'surprise'];
    function expressionStates(expression, n, minHold = 6) {
        const out = new Array(n).fill(null);
        if (!expression) return out;
        const tracks = Object.fromEntries(EXPR_ORDER.map((k) => [k, sample(expression[k], n)]));
        let cur = null;
        for (let f = 0; f < n; f++) {
            const v = (k) => tracks[k][f] || 0;
            if (cur && v(cur) < EXPR[cur].off) cur = null;
            for (const k of EXPR_ORDER) {
                if (k === cur) break;
                if (v(k) > EXPR[k].on) { cur = k; break; }
            }
            if (cur === 'smile' && v('laugh') > EXPR.laugh.on) cur = 'laugh';
            out[f] = cur;
        }
        // Drop runs shorter than the minimum hold.
        for (let f = 0; f < n;) {
            let e = f;
            while (e < n && out[e] === out[f]) e++;
            if (out[f] && e - f < minHold) for (let i = f; i < e; i++) out[i] = f > 0 ? out[f - 1] : null;
            f = e;
        }
        return out;
    }

    /** Per-frame booleans → stepped opacity keyframes (null when always visible). */
    function visibilityTrack(visible) {
        if (visible.every(Boolean)) return null;
        const segs = mergeSame(visible.map((on, f) => ({ key: on ? 'on' : 'off', start: f, end: f + 1 })));
        return L.opacityKeyframes(segs, 'on');
    }

    function buildCharacterRig(character, { segments, extras = {}, totalFrames, fps = 30 }) {
        const n = Math.max(1, totalFrames);
        const frontParts = character.parts.filter((p) => !p.view || p.view === 'F');
        const front = { ...character, parts: frontParts };
        let mouthSegs = mergeSame(segments.map((s) => ({ ...s, key: resolveMouth(front, s.key).id })));
        const mouthAt = new Array(n);
        for (const seg of mouthSegs) for (let f = seg.start; f < Math.min(seg.end, n); f++) mouthAt[f] = seg.key;
        const restId = resolveMouth(front, L.REST).id;
        for (let f = 0; f < n; f++) if (!mouthAt[f]) mouthAt[f] = restId;

        // Expressions (tracked smile / laugh / frown) swap in their own mouths and
        // eyes where the character has them: a smile replaces the closed and resting
        // mouths, and talking through a smile that reaches the eyes opens into the
        // grin on the open vowels (A, E) while other shapes keep speaking; a laugh takes over
        // the mouth and squeezes the eyes; a frown turns the resting mouth down.
        const exprAt = expressionStates(extras.expression, n);
        // How squeezed the eyes are (0..1): a smile reaching the eyes is a real grin.
        const squeeze = extras.expression && extras.expression.squeeze ? sample(extras.expression.squeeze, n) : null;
        const mouthOf = (key) => { const p = frontParts.find((x) => x.role === 'mouth' && x.key === key); return p ? p.id : null; };
        const exprMouth = { smile: mouthOf('SMILE'), laugh: mouthOf('LAUGH'), frown: mouthOf('FROWN') };
        const closedIds = new Set([restId, resolveMouth(front, 'MBP').id]);
        const openIds = new Set([resolveMouth(front, 'A').id, resolveMouth(front, 'E').id]);
        for (let f = 0; f < n; f++) {
            const e = exprAt[f];
            if (e === 'laugh' && exprMouth.laugh) mouthAt[f] = exprMouth.laugh;
            // Talking through a smile only opens into the grin when the eyes smile too;
            // a polite smile keeps the speech shape (the grin would look like laughing).
            else if (e === 'smile' && exprMouth.laugh && openIds.has(mouthAt[f]) && (!squeeze || squeeze[f] > 0.6)) mouthAt[f] = exprMouth.laugh;
            else if ((e === 'smile' || e === 'laugh') && exprMouth.smile && closedIds.has(mouthAt[f])) mouthAt[f] = exprMouth.smile;
            else if ((e === 'frown' || e === 'sad' || e === 'angry') && exprMouth.frown && closedIds.has(mouthAt[f])) mouthAt[f] = exprMouth.frown;
        }
        mouthSegs = mergeSame(mouthAt.map((key, f) => ({ key, start: f, end: f + 1 })));

        const eyes = {
            L: eyeSegments(extras.eyes && extras.eyes.left, n),
            R: eyeSegments(extras.eyes && extras.eyes.right, n),
        };
        const eyeAt = { L: new Array(n), R: new Array(n) };
        for (const side of ['L', 'R']) for (const seg of eyes[side]) for (let f = seg.start; f < Math.min(seg.end, n); f++) eyeAt[side][f] = seg.key;
        // Expressions in the eyes (blinks still win): laughing — or smiling with the
        // eyes squeezed — gives happy arcs; a scowl narrows them; surprise holds them open.
        const hasHappy = character.parts.some((p) => p.role === 'eye' && p.state === 'happy');
        if (exprAt.some(Boolean)) {
            for (const side of ['L', 'R']) {
                for (let f = 0; f < n; f++) {
                    const e = exprAt[f];
                    if (eyeAt[side][f] === 'closed') continue;
                    if (hasHappy && (e === 'laugh' || (e === 'smile' && squeeze && squeeze[f] > 0.75))) eyeAt[side][f] = 'happy';
                    else if (e === 'angry') eyeAt[side][f] = 'half';
                    else if (e === 'surprise') eyeAt[side][f] = 'open';
                }
                eyes[side] = mergeSame(eyeAt[side].map((key, f) => ({ key, start: f, end: f + 1 })));
            }
        }

        const head = extras.head || {};
        // Soft-limit the turn used for parallax so features never slide off the face.
        const soft = (v, max) => max * Math.tanh(v / max);
        const rawYaw = sample(head.yaw, n);
        const lock = extras.view === 'PR' || extras.view === 'PL' ? extras.view : null;
        const views = viewTrack(character, rawYaw, lock, { profile: extras.profile !== false });
        // Blink through a head turn: the cut between drawings reads as a natural blink-and-turn.
        for (let f = 1; f < n; f++) {
            if (views[f] === views[f - 1]) continue;
            for (const side of ['L', 'R']) {
                const set = (i, st) => { if (i >= 0 && i < n && eyeAt[side][i] !== 'happy') eyeAt[side][i] = st; };
                set(f - 1, 'half'); set(f, 'closed'); set(f + 1, 'closed'); set(f + 2, 'half');
            }
        }
        const angle = character.turnViews ? character.turnViews.angle : 0;
        // Parallax inside each drawing: front uses the turn itself, a ¾ view only what's left past its angle.
        const pAngle = character.turnViews && character.turnViews.profile ? character.turnViews.profile.angle : 70;
        // Locked to a profile, the tracked turn reads as small turns around that profile.
        const yawIn = lock && views[0] === lock ? rawYaw.map((v) => v + (lock === 'PR' ? pAngle : -pAngle)) : rawYaw;
        const yawFor = {
            F: yawIn.map((v) => soft(v, 18)),
            R: yawIn.map((v) => soft(v - angle, 8)),
            L: yawIn.map((v) => soft(v + angle, 8)),
            PR: yawIn.map((v) => soft(v - pAngle, 5)),
            PL: yawIn.map((v) => soft(v + pAngle, 5)),
        };
        // Nods: up to ~20° shows as features sliding up/down plus a little vertical
        // foreshortening of the head (see lsy below).
        const pitch = sample(head.pitch, n).map((v) => soft(v, 20));
        const turn = character.turn || 0.6;
        const gazeRange = character.gaze || { x: 5, y: 3 };
        const gaze = { L: gazeFor(extras, 'L', n), R: gazeFor(extras, 'R', n) };
        const brows = {
            L: sample(extras.brows && extras.brows.left && extras.brows.left.y, n),
            R: sample(extras.brows && extras.brows.right && extras.brows.right.y, n),
        };
        // Brow slant (degrees; angry = inner ends down, sad = inner ends up).
        const browRot = {
            L: sample(extras.brows && extras.brows.left && extras.brows.left.rotation, n),
            R: sample(extras.brows && extras.brows.right && extras.brows.right.rotation, n),
        };
        const browTurns = browRot.L.some((v) => Math.abs(v) > 0.2) || browRot.R.some((v) => Math.abs(v) > 0.2);
        /** Where a brow sits (artwork px) in a given drawing — its own turning point. */
        const browCentre = (side, view) => {
            const geo = character.turnViews && character.turnViews.geometry && character.turnViews.geometry[view];
            const eye = (geo && geo.eyes && geo.eyes[side]) || (character.eyes && character.eyes[side]);
            const y = character.eyes && character.eyes[side] ? character.eyes[side].y : centerY;
            return eye ? { x: eye.x, y: y - (character.browRise || 30) } : null;
        };
        const breath = sample(extras.breath, n);
        const jawRaw = extras.mouthScale && extras.mouthScale.length ? sample(extras.mouthScale, n) : null;
        // Anticipation and overshoot on swaps into an open shape: a squash in, a pop past, then settle.
        const openSet = new Set([...openIds, resolveMouth(front, 'O').id, resolveMouth(front, 'I').id, exprMouth.laugh].filter(Boolean));
        const pop = new Array(n).fill(1);
        for (let f = 1; f < n; f++) {
            if (mouthAt[f] === mouthAt[f - 1] || !openSet.has(mouthAt[f]) || openSet.has(mouthAt[f - 1])) continue;
            pop[f] *= 0.9;
            if (f + 1 < n) pop[f + 1] *= 1.07;
            if (f + 2 < n) pop[f + 2] *= 1.02;
        }
        const jaw = jawRaw || pop.some((v) => v !== 1) ? Array.from({ length: n }, (_, f) => (jawRaw ? jawRaw[f] : 1) * pop[f]) : null;
        // Imported parts scale about the canvas centre; keep the mouth centred on itself.
        const centerY = character.size.height / 2;
        const mouthY = character.mouth ? character.mouth.y : centerY;

        const hx = sample(head.x, n);
        const hy = sample(head.y, n);
        // Tracked shoulders: the body sways/tilts on its own; the head rides on the neck.
        const body = extras.body || null;
        const bodyRoll = body ? sample(body.roll, n) : null;
        const bodyX = body ? sample(body.x, n) : hx;
        const bodyY = body ? sample(body.y, n) : hy;
        const SHOULDER_DROP = 80; // shoulder pivot below the canvas centre (imported parts rotate about the centre)
        const NECK_RISE = character.size.height / 2 + SHOULDER_DROP - character.pivot.y; // neck pivot above the shoulders

        // Jaw stretch for a mouth part. Expression mouths are drawn already open (or set),
        // so the jaw only nudges them — stretching the big laugh further would push it
        // past the chin.
        const jawFor = (part, f) => {
            const setShape = part.key === 'LAUGH' || part.key === 'SMILE' || part.key === 'FROWN';
            return setShape ? 1 + M.clamp(jaw[f] - 1, -0.08, 0.04) : jaw[f];
        };
        const offsetTracks = (part, yaw) => {
            const depth = part.group === 'head' ? part.depth || 0 : 0;
            const dx = new Array(n);
            const dy = new Array(n);
            for (let f = 0; f < n; f++) {
                dx[f] = yaw[f] * turn * depth;
                dy[f] = pitch[f] * turn * depth * 0.8;
                if (part.role === 'iris' || (character.gazeMovesEyes && part.role === 'eye')) {
                    dx[f] += gaze[part.side].x[f] * gazeRange.x;
                    dy[f] += gaze[part.side].y[f] * gazeRange.y;
                }
                if (part.role === 'brow') dy[f] += brows[part.side][f];
                if (part.role === 'mouth' && jaw) dy[f] += (mouthY - centerY) * (1 - jawFor(part, f));
                if (part.group === 'body') {
                    // Moving around the frame moves the whole character, so the neck stays attached.
                    dx[f] += bodyX[f] + (bodyLag ? bodyLag[f] : 0);
                    dy[f] += breath[f] + bodyY[f];
                    if (bodyRoll) {
                        // Rotate about the shoulders, not the canvas centre the layer pivots on.
                        const t = bodyRoll[f] * rad;
                        dx[f] += SHOULDER_DROP * Math.sin(t);
                        dy[f] += SHOULDER_DROP * (1 - Math.cos(t));
                    }
                }
            }
            return { dx, dy };
        };
        const moving = (t) => t.length > 2 || t.some((k) => Math.abs(k.value) > 0.01);

        // Head transform per frame (art px / degrees / factor): roll about the neck
        // pivot, drift into turns, breathing, tracked sway/bob and lean-in scale.
        // With tracked shoulders the head rides the body's neck point plus a
        // limited lean of its own (the neck can't stretch far).
        const neckX = (f) => (bodyRoll ? NECK_RISE * Math.sin(bodyRoll[f] * rad) : 0);
        // The neck point swings on a circle about the shoulders, so it dips (+y) as the body tilts.
        const neckY = (f) => (bodyRoll ? NECK_RISE * (1 - Math.cos(bodyRoll[f] * rad)) : 0);
        const lean = (f, own, base) => (body ? base + M.clamp(own - base, -10, 10) : own);
        const headRoll = sample(head.roll, n);
        const headScale = head.scale && head.scale.length ? sample(head.scale, n) : new Array(n).fill(1);
        const headX = rawYaw.map((v, f) => soft(soft(v, 30) * turn * 0.35, 6) + lean(f, hx[f], bodyX[f]) + neckX(f));
        const headY = pitch.map((v, f) => v * turn * 0.25 + breath[f] * 0.7 + lean(f, hy[f], bodyY[f]) + neckY(f));
        const { x: px, y: py } = character.pivot;
        const cx = character.size.width / 2;
        const cy = centerY;
        // The shoulders follow the head's turn a little, late (untracked characters only).
        const bodyLag = body ? null : (() => {
            const out = new Array(n);
            let l = 0;
            for (let f = 0; f < n; f++) { l += ((headX[f] - hx[f]) * 0.3 - l) * 0.1; out[f] = l; }
            return out;
        })();
        // A soft-bodied head (the Orb) squashes and stretches as it talks: a touch taller on open shapes.
        const talkSquash = character.squashTalk ? (() => {
            let v = 0;
            return mouthAt.map((id) => { v += ((openSet.has(id) ? 1 : 0) - v) * 0.35; return v; });
        })() : null;
        // Springy extras (antenna, bow): a damped spring driven by the head's acceleration, so they lag
        // and wobble after a move, then settle.
        const springs = new Map();
        const springRot = (part) => {
            const g = part.spring.k || 1;
            if (springs.has(g)) return springs.get(g);
            const out = new Array(n);
            const dt = 1 / fps, w = 2 * Math.PI * 1.8, z = 0.22;
            let th = 0, v = 0;
            for (let f = 0; f < n; f++) {
                const ax = f >= 2 ? (headX[f] - 2 * headX[f - 1] + headX[f - 2]) / (dt * dt) : 0;
                const ar = f >= 2 ? (headRoll[f] - 2 * headRoll[f - 1] + headRoll[f - 2]) / (dt * dt) : 0;
                v += (-w * w * th - 2 * z * w * v - g * (ax * 10 + ar * 1.5)) * dt;
                th += v * dt;
                out[f] = M.clamp(th, -14, 14);
            }
            springs.set(g, out);
            return out;
        };

        /**
         * The neck, rigged like a real one: its base B (in the collar) rides the body,
         * its top reaches the chin C (the head pivot, wherever the head moved), and the
         * column between them rotates and stretches to join the two — so it bends with
         * a tilt instead of swinging out of the collar, and never leaves the jaw.
         * Layer form: q → c + d + R·S·(q − c), with R·S chosen so B0 → B and up → C.
         */
        const NECK_BASE = { x: px, y: py + (character.neckLength || 38) }; // the collar point, below the chin
        const neckAnim = () => {
            const dx = new Array(n);
            const dy = new Array(n);
            const rot = new Array(n);
            const sxs = new Array(n);
            const sys = new Array(n);
            const len0 = NECK_BASE.y - py;
            for (let f = 0; f < n; f++) {
                // Base: where the body puts the collar point this frame.
                const tb = bodyRoll ? bodyRoll[f] * rad : 0;
                const bdx = bodyX[f] + (bodyLag ? bodyLag[f] : 0) + (bodyRoll ? SHOULDER_DROP * Math.sin(tb) : 0);
                const bdy = breath[f] + bodyY[f] + (bodyRoll ? SHOULDER_DROP * (1 - Math.cos(tb)) : 0);
                const bx0 = NECK_BASE.x - cx;
                const by0 = NECK_BASE.y - cy;
                const B = { x: cx + bdx + bx0 * Math.cos(tb) - by0 * Math.sin(tb), y: cy + bdy + bx0 * Math.sin(tb) + by0 * Math.cos(tb) };
                // Top: the head pivot (chin/neck point) after the head's own move.
                const C = { x: px + headX[f], y: py + headY[f] };
                const vx = C.x - B.x;
                const vy = C.y - B.y;
                const a = Math.atan2(vx, -vy); // lean from vertical (clockwise +)
                const sy = M.clamp(Math.hypot(vx, vy) / len0, 0.7, 1.5);
                const sx = 1 + (headScale[f] - 1) * 0.5;
                // d = B − c + R·S·(c − B0)
                const ux = (cx - NECK_BASE.x) * sx;
                const uy = (cy - NECK_BASE.y) * sy;
                dx[f] = B.x - cx + ux * Math.cos(a) - uy * Math.sin(a);
                dy[f] = B.y - cy + ux * Math.sin(a) + uy * Math.cos(a);
                rot[f] = a / rad;
                sxs[f] = sx;
                sys[f] = sy;
            }
            const out = {};
            const fin = (arr, d) => arr.map((v) => (Number.isFinite(v) ? v : d));
            const tdx = M.decimate(fin(dx, 0), 0.08);
            const tdy = M.decimate(fin(dy, 0), 0.08);
            if (moving(tdx)) out.dx = tdx;
            if (moving(tdy)) out.dy = tdy;
            const r = fin(rot, 0);
            if (r.some((v) => Math.abs(v) > 0.05)) out.rotation = M.decimate(r, 0.1);
            const s1 = fin(sxs, 1);
            const s2 = fin(sys, 1);
            if (s1.some((v) => Math.abs(v - 1) > 0.001)) out.scaleX = M.decimate(s1, 0.002, 4);
            if (s2.some((v) => Math.abs(v - 1) > 0.001)) out.scaleY = M.decimate(s2, 0.002, 4);
            return Object.keys(out).length ? out : null;
        };

        // A glow layer (the Orb's) breathes: a slow swell between 55% and 100%, a little quicker and
        // brighter while the character speaks (eased in and out of speech so it never jumps).
        let glowPulse = null;
        const glowTrack = (visible) => {
            if (!glowPulse) {
                glowPulse = new Array(n);
                const speaking = new Uint8Array(n);
                for (const seg of segments) if (seg.key !== L.REST) for (let f = Math.max(0, seg.start); f < Math.min(seg.end, n); f++) speaking[f] = 1;
                let phase = 0;
                let talk = 0;
                for (let f = 0; f < n; f++) {
                    talk += (speaking[f] - talk) * 0.08;
                    phase += (2 * Math.PI) / (fps * (3.6 - 1.2 * talk));
                    const swell = (1 - Math.cos(phase)) / 2; // 0 → 1 → 0, starting dim
                    glowPulse[f] = 55 + 30 * swell + 15 * talk * (0.5 + 0.5 * swell);
                }
            }
            return M.decimate(glowPulse.map((v, f) => (visible[f] ? v : 0)), 0.8, 1);
        };

        const layers = [];
        for (const part of character.parts) {
            // allViews parts (the neck) belong to the head but show under every drawing.
            const view = part.group === 'head' && !part.allViews ? part.view || 'F' : null;
            const baseId = part.id.split('@')[0];
            const visible = new Array(n);
            for (let f = 0; f < n; f++) {
                let on = !view || views[f] === view;
                if (on && part.role === 'mouth') on = mouthAt[f] === baseId;
                if (on && part.role === 'eye') on = eyeAt[part.side][f] === part.state;
                // Characters whose shut eyes are just a line on the face hide the eye white and iris
                // while that eye is closed or squinting happily, so nothing shows behind the line.
                if (on && character.shutHidesEyes && (part.role === 'eyeWhite' || part.role === 'iris')) on = eyeAt[part.side][f] !== 'closed' && eyeAt[part.side][f] !== 'happy';
                visible[f] = on;
            }
            if (!visible.some(Boolean)) continue; // never shown in this clip: don't import it

            const anim = {};
            const opacity = part.role === 'glow' ? glowTrack(visible) : visibilityTrack(visible);
            if (opacity) anim.opacity = opacity;
            if (opacity && part.role === 'glow') anim.opacitySmooth = true;

            if (part.role === 'neck') {
                layers.push({ partId: part.id, name: part.name, group: part.group, anim: neckAnim() });
                continue;
            }
            // A shared (allViews) part turns with whichever drawing is on screen.
            const yaw = part.allViews ? views.map((v, f) => yawFor[v || 'F'][f]) : yawFor[view || 'F'];
            const local = offsetTracks(part, yaw);
            // Local scale factors: the whole head narrows with the turn (every head part
            // the same, so the features stay locked to the face whatever point Creator
            // scales layers about); the jaw opens the mouth (a touch of inverse width
            // keeps its volume).
            const lsx = new Array(n).fill(1);
            const lsy = new Array(n).fill(1);
            if (part.group === 'head') {
                for (let f = 0; f < n; f++) {
                    lsx[f] = 1 - (1 - Math.cos(yaw[f] * rad)) * 1.4;
                    lsy[f] = 1 - (1 - Math.cos(pitch[f] * rad)) * 1.2; // nodding foreshortens the head
                    // Layers scale about the canvas centre; shift so the head foreshortens about
                    // the chin instead, which keeps the chin on the neck however far it is from the centre.
                    local.dx[f] += (px - cx) * (1 - lsx[f]);
                    local.dy[f] += (py - cy) * (1 - lsy[f]);
                }
            }
            if (part.role === 'mouth' && jaw) {
                for (let f = 0; f < n; f++) {
                    const j = jawFor(part, f);
                    lsy[f] *= j;
                    lsx[f] *= 1 - (j - 1) * 0.3;
                }
            }

            let dx = local.dx;
            let dy = local.dy;
            let rot = null;
            // A slanting brow turns about its own centre b, not the canvas centre c it
            // pivots on: shift it by (I − R)(b − c) so it stays in place.
            const ownRot = part.role === 'brow' && browTurns ? browRot[part.side] : part.spring ? springRot(part) : null;
            const bc = !ownRot ? null : part.spring ? part.spring.pivot : browCentre(part.side, part.view && part.view.length === 1 ? part.view : null);
            if (ownRot && bc) {
                const bx = bc.x - cx;
                const by = bc.y - cy;
                local.dx = local.dx.map((v, f) => { const a = ownRot[f] * rad; return v + bx - (bx * Math.cos(a) - by * Math.sin(a)); });
                local.dy = local.dy.map((v, f) => { const a = ownRot[f] * rad; return v + by - (bx * Math.sin(a) + by * Math.cos(a)); });
                dx = local.dx;
                dy = local.dy;
            }
            if (part.group === 'head') {
                // Bake the head transform into the part itself (no parenting): a part
                // drawn about its own centre c lands at  T + pivot + s·R·(c + o − pivot),
                // rotated by the head roll and scaled by the head scale. This is what a
                // parent would do, without relying on how a host re-bases child keyframes.
                dx = new Array(n);
                dy = new Array(n);
                rot = ownRot && bc ? headRoll.map((v, f) => v + ownRot[f]) : headRoll;
                for (let f = 0; f < n; f++) {
                    const t = headRoll[f] * rad;
                    const sc = headScale[f];
                    const sqx = talkSquash ? 1 - 0.015 * talkSquash[f] : 1;
                    const sqy = talkSquash ? 1 + 0.03 * talkSquash[f] : 1;
                    const vx = (cx + local.dx[f] - px) * sqx;
                    const vy = (cy + local.dy[f] - py) * sqy;
                    dx[f] = headX[f] + px + sc * (vx * Math.cos(t) - vy * Math.sin(t)) - cx;
                    dy[f] = headY[f] + py + sc * (vx * Math.sin(t) + vy * Math.cos(t)) - cy;
                    lsx[f] *= sc * sqx;
                    lsy[f] *= sc * sqy;
                }
            } else if (part.group === 'body' && bodyRoll) {
                rot = bodyRoll;
            }
            // Breathing fills the chest a little, as well as lifting it (untracked bodies).
            if (part.group === 'body' && !body) for (let f = 0; f < n; f++) lsy[f] *= 1 - breath[f] * 0.005;

            // Never let a bad input (a NaN anywhere upstream) reach a layer: a NaN
            // position or scale makes a part ignore the head entirely.
            const fin = (arr, d) => arr.map((v) => (Number.isFinite(v) ? v : d));
            dx = fin(dx, 0);
            dy = fin(dy, 0);
            if (rot) rot = fin(rot, 0);
            for (let f = 0; f < n; f++) {
                if (!Number.isFinite(lsx[f])) lsx[f] = 1;
                if (!Number.isFinite(lsy[f])) lsy[f] = 1;
            }
            const tx = M.decimate(dx, 0.08);
            const ty = M.decimate(dy, 0.08);
            if (moving(tx)) anim.dx = tx;
            if (moving(ty)) anim.dy = ty;
            if (rot && rot.some((v) => Math.abs(v) > 0.05)) anim.rotation = M.decimate(rot, 0.1);
            if (lsx.some((v) => Math.abs(v - 1) > 0.001)) anim.scaleX = M.decimate(lsx, 0.002, 4);
            if (lsy.some((v) => Math.abs(v - 1) > 0.001)) anim.scaleY = M.decimate(lsy, 0.002, 4);
            layers.push({ partId: part.id, name: part.name, group: part.group, anim: Object.keys(anim).length ? anim : null });
        }

        const viewSegments = mergeSame(views.map((v, f) => ({ key: v, start: f, end: f + 1 })));
        // Head motion is baked into each part, so there is no head null to animate.
        return { layers, head: null, mouthSegments: mouthSegs, eyeSegments: eyes, viewSegments };
    }

    /**
     * The user's own layers → { animations: [{ layerId, anim }], mapping: { role: layerName } }.
     * selection: [{ id, name }]
     */
    function buildSelectionRig(selection, { set, segments, extras = {}, totalFrames }) {
        const rigLayers = {};
        const mouthLayers = {};
        const exprLayers = {};
        const exprKeys = (o) => Object.keys(o);
        for (const layer of selection) {
            const rig = M.matchRigName(layer.name);
            if (rig) {
                const upper = layer.name.toUpperCase();
                const state = /\b(CLOSED?|SHUT)\b/.test(upper) ? 'closed' : /\bHALF\b/.test(upper) ? 'half' : /\b(HAPPY|LAUGH(ING)?|SQUINT)\b/.test(upper) ? 'happy' : 'open';
                const key = rig.startsWith('eye') ? `${rig}:${state}` : rig;
                if (!rigLayers[key]) rigLayers[key] = layer;
                continue;
            }
            // Expression mouths ("Mouth Smile", "Laugh", "Frown") sit beside the speech shapes.
            const expr = String(layer.name).toUpperCase().match(/\b(SMILE|SMILING|LAUGH|LAUGHING|FROWN|FROWNING|SAD)\b/);
            if (expr) {
                const k = /^SMIL/.test(expr[1]) ? 'SMILE' : /^LAUGH/.test(expr[1]) ? 'LAUGH' : 'FROWN';
                if (!exprLayers[k]) exprLayers[k] = layer;
                continue;
            }
            const key = L.matchLayerName(layer.name, set);
            if (key && !mouthLayers[key]) mouthLayers[key] = layer;
        }

        const animations = [];
        const available = Object.keys(mouthLayers);
        const exprAt = expressionStates(extras.expression, totalFrames);
        let mouthSegs = [];
        if (available.length) {
            mouthSegs = L.remapSegments(segments, available);
            if (exprKeys(exprLayers).length && exprAt.some(Boolean)) {
                // Same rules as the built-in characters (see buildCharacterRig).
                const at = new Array(totalFrames).fill(available.includes(L.REST) ? L.REST : available[0]);
                for (const seg of mouthSegs) for (let f = seg.start; f < Math.min(seg.end, totalFrames); f++) at[f] = seg.key;
                for (let f = 0; f < totalFrames; f++) {
                    const e = exprAt[f];
                    if (e === 'laugh' && exprLayers.LAUGH) at[f] = 'LAUGH';
                    else if (e === 'smile' && exprLayers.LAUGH && (at[f] === 'A' || at[f] === 'E')) at[f] = 'LAUGH';
                    else if ((e === 'smile' || e === 'laugh') && exprLayers.SMILE && (at[f] === L.REST || at[f] === 'MBP')) at[f] = 'SMILE';
                    else if (e === 'frown' && exprLayers.FROWN && at[f] === L.REST) at[f] = 'FROWN';
                }
                mouthSegs = mergeSame(at.map((key, f) => ({ key, start: f, end: f + 1 })));
            }
            for (const key of available) animations.push({ layerId: mouthLayers[key].id, role: `mouth:${key}`, anim: { opacity: L.opacityKeyframes(mouthSegs, key) } });
            for (const key of exprKeys(exprLayers)) animations.push({ layerId: exprLayers[key].id, role: `mouth:${key}`, anim: { opacity: L.opacityKeyframes(mouthSegs, key) } });
        }

        for (const side of ['L', 'R']) {
            const track = extras.eyes && extras.eyes[side === 'L' ? 'left' : 'right'];
            const states = EYE_STATES.filter((s) => rigLayers[`eye${side}:${s}`]);
            const happy = rigLayers[`eye${side}:happy`];
            if (!track) continue;
            if (states.length > 1 || (happy && states.length)) {
                // Swap drawn eye states, falling back to the nearest available one.
                const segs = eyeSegments(track, totalFrames).map((s) => ({ ...s, key: states.includes(s.key) ? s.key : s.key === 'half' ? (states.includes('closed') ? 'closed' : 'open') : states[0] }));
                let merged = mergeSame(segs);
                if (happy) {
                    // Laughing squeezes the eyes into the "Happy" layer (blinks still win).
                    const at = new Array(totalFrames);
                    for (const seg of merged) for (let f = seg.start; f < Math.min(seg.end, totalFrames); f++) at[f] = seg.key;
                    for (let f = 0; f < totalFrames; f++) if (exprAt[f] === 'laugh' && at[f] !== 'closed') at[f] = 'happy';
                    merged = mergeSame(at.map((key, f) => ({ key, start: f, end: f + 1 })));
                    animations.push({ layerId: happy.id, role: `eye${side}:happy`, anim: { opacity: L.opacityKeyframes(merged, 'happy') } });
                }
                for (const state of states) animations.push({ layerId: rigLayers[`eye${side}:${state}`].id, role: `eye${side}:${state}`, anim: { opacity: L.opacityKeyframes(merged, state) } });
            } else if (states.length === 1) {
                // A single eye layer squashes vertically to blink.
                const scaleY = track.map((k) => ({ frame: k.frame, value: Math.max(0.08, 1 - k.value / 100) }));
                animations.push({ layerId: rigLayers[`eye${side}:${states[0]}`].id, role: `eye${side}`, anim: { scaleY } });
            }
        }

        for (const side of ['L', 'R']) {
            const layer = rigLayers[`brow${side}`];
            const brow = extras.brows && extras.brows[side === 'L' ? 'left' : 'right'];
            if (layer && brow) animations.push({ layerId: layer.id, role: `brow${side}`, anim: { dy: brow.y, rotation: brow.rotation } });
        }

        for (const side of ['L', 'R']) {
            const layer = rigLayers[`iris${side}`];
            if (!layer || !extras.gaze) continue;
            const g = gazeFor(extras, side, totalFrames);
            animations.push({ layerId: layer.id, role: `iris${side}`, anim: { dx: M.decimate(g.x.map((v) => v * 5), 0.08), dy: M.decimate(g.y.map((v) => v * 3), 0.08) } });
        }

        if (rigLayers.body && extras.body) {
            const b = extras.body;
            animations.push({ layerId: rigLayers.body.id, role: 'body', anim: { rotation: b.roll, dx: b.x, dy: b.y } });
        }

        if (rigLayers.head && extras.head) {
            const h = extras.head;
            const scale = (track, k) => (track || []).map((kf) => ({ frame: kf.frame, value: Math.round(kf.value * k * 100) / 100 }));
            const sum = (a, b) => {
                const frames = [...new Set([...(a || []), ...(b || [])].map((k) => k.frame))].sort((x, y) => x - y);
                return frames.map((frame) => ({ frame, value: Math.round(((a && a.length ? M.valueAt(a, frame) : 0) + (b && b.length ? M.valueAt(b, frame) : 0)) * 100) / 100 }));
            };
            const anim = { rotation: h.roll, dx: sum(scale(h.yaw, 0.6), h.x), dy: sum(scale(h.pitch, 0.5), h.y) };
            if (h.scale && h.scale.length > 1) { anim.scaleX = h.scale; anim.scaleY = h.scale; }
            animations.push({ layerId: rigLayers.head.id, role: 'head', anim });
        }

        const mapping = {};
        for (const [key, layer] of Object.entries(mouthLayers)) mapping[key] = layer.name;
        for (const [key, layer] of Object.entries(rigLayers)) mapping[key] = layer.name;
        return { animations, mapping, mouthSegments: mouthSegs };
    }

    /** What a built-in rig shows at a frame — for the UI preview. */
    function frameState(rig, frame) {
        const visible = new Set();
        const offsets = {};
        const alpha = {}; // smooth opacity (the breathing glow), 0..1
        for (const layer of rig.layers) {
            const a = layer.anim;
            if (a && a.opacity && a.opacitySmooth) {
                const v = M.valueAt(a.opacity, frame);
                if (v <= 0.5) continue;
                alpha[layer.partId] = v / 100;
            } else if (a && a.opacity && M.valueAt(a.opacity, frame) < 50) continue;
            visible.add(layer.partId);
            if (a && (a.dx || a.dy || a.scaleX || a.scaleY || a.rotation)) {
                offsets[layer.partId] = {
                    x: a.dx ? M.valueAt(a.dx, frame) : 0,
                    y: a.dy ? M.valueAt(a.dy, frame) : 0,
                    sx: a.scaleX ? M.valueAt(a.scaleX, frame) : 1,
                    sy: a.scaleY ? M.valueAt(a.scaleY, frame) : 1,
                    rot: a.rotation ? M.valueAt(a.rotation, frame) : 0,
                };
            }
        }
        const h = rig.head || {};
        const head = {
            rotation: h.rotation ? M.valueAt(h.rotation, frame) : 0,
            x: h.dx ? M.valueAt(h.dx, frame) : 0,
            y: h.dy ? M.valueAt(h.dy, frame) : 0,
            scale: h.scaleX ? M.valueAt(h.scaleX, frame) : 1,
        };
        return { visible, offsets, head, alpha };
    }

    return { resolveMouth, eyeSegments, viewTrack, buildCharacterRig, buildSelectionRig, frameState, eyeState };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Rig;
}
