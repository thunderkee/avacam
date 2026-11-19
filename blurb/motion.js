/**
 * Motion — shared helpers for continuous rig channels (eyes, brows, head).
 *
 * A "track" is an ascending list of { frame, value } keyframes with linear
 * interpolation, the same shape Creator's addKeyframes() takes.
 *
 * Rig channels (all optional) passed to the plugin as `extras`:
 *   eyes:  { left, right }                       closure 0 (open) … 100 (shut)
 *   brows: { left: { y, rotation }, right: … }   y in artwork px (negative = up), degrees
 *   head:  { rotation, x, y }                    degrees, artwork px
 */
const Motion = (() => {
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    /** Linear value of a track at a (possibly fractional) frame. */
    function valueAt(track, frame) {
        if (!track || track.length === 0) return 0;
        if (frame <= track[0].frame) return track[0].value;
        for (let i = 1; i < track.length; i++) {
            const b = track[i];
            if (frame <= b.frame) {
                const a = track[i - 1];
                return a.value + ((b.value - a.value) * (frame - a.frame)) / (b.frame - a.frame || 1);
            }
        }
        return track[track.length - 1].value;
    }

    /** Centered moving average; radius 0 returns a copy. */
    function smooth(values, radius) {
        if (radius <= 0) return values.slice();
        const out = new Array(values.length);
        for (let i = 0; i < values.length; i++) {
            let sum = 0;
            let n = 0;
            for (let j = i - radius; j <= i + radius; j++) {
                if (j >= 0 && j < values.length) { sum += values[j]; n++; }
            }
            out[i] = sum / n;
        }
        return out;
    }

    /**
     * Per-frame values → sparse keyframes (Ramer–Douglas–Peucker on value error).
     * Keeps first and last frame; result reproduces the curve within `tolerance`.
     */
    function decimate(values, tolerance, round = 2) {
        const n = values.length;
        if (n === 0) return [];
        const keep = new Uint8Array(n);
        keep[0] = 1;
        keep[n - 1] = 1;
        const stack = [[0, n - 1]];
        while (stack.length) {
            const [a, b] = stack.pop();
            let worst = -1;
            let worstErr = tolerance;
            for (let i = a + 1; i < b; i++) {
                const expected = values[a] + ((values[b] - values[a]) * (i - a)) / (b - a);
                const err = Math.abs(values[i] - expected);
                if (err > worstErr) { worstErr = err; worst = i; }
            }
            if (worst !== -1) {
                keep[worst] = 1;
                stack.push([a, worst], [worst, b]);
            }
        }
        const p = 10 ** round;
        const out = [];
        for (let i = 0; i < n; i++) if (keep[i]) out.push({ frame: i, value: Math.round(values[i] * p) / p });
        return out;
    }

    /** Small seeded PRNG so auto-motion is stable between previews and the build. */
    function rng(seed) {
        // Scramble small seeds: raw xorshift from e.g. 9 yields near-zero values for its first draws.
        let s = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
        return () => {
            s ^= s << 13; s >>>= 0;
            s ^= s >> 17;
            s ^= s << 5; s >>>= 0;
            return s / 4294967296;
        };
    }

    /**
     * Natural-looking procedural blinks: quick close, short hold, slower open,
     * every 2.5–5.5 s (occasionally a double blink).
     */
    function autoBlinks(totalFrames, fps, seed = 7) {
        const random = rng(seed);
        const values = new Array(totalFrames).fill(0);
        const close = Math.max(1, Math.round(0.06 * fps));
        const hold = Math.max(1, Math.round(0.03 * fps));
        const open = Math.max(1, Math.round(0.1 * fps));

        const blinkAt = (start) => {
            for (let i = 0; i <= close; i++) put(start + i, (i / close) * 100);
            for (let i = 1; i <= hold; i++) put(start + close + i, 100);
            for (let i = 1; i <= open; i++) put(start + close + hold + i, 100 - (i / open) * 100);
        };
        const put = (f, v) => { if (f >= 0 && f < totalFrames) values[f] = Math.max(values[f], v); };

        let t = Math.round((0.8 + random() * 1.5) * fps);
        while (t < totalFrames - 1) {
            blinkAt(t);
            if (random() < 0.15) blinkAt(t + close + hold + open + Math.round(0.08 * fps));
            t += Math.round((2.5 + random() * 3) * fps);
        }
        return decimate(values, 0.5, 0);
    }

    /**
     * Discrete tracks (opacity swaps) must cut, not fade: Lottie players render
     * between keyframes, so a linear 0→100 over one frame shows two shapes at
     * 50 % for that instant. This ease holds the old value until the very end.
     */
    const STEP = { type: 'CUBIC_BEZIER', x1: 1, y1: 0, x2: 1, y2: 0 };
    function stepify(track) {
        return track.map((k, i) => (i < track.length - 1 && track[i + 1].value !== k.value ? { ...k, easing: STEP } : k));
    }

    /** Smooth noise in [-1, 1]: sum of a few seeded sines (cheap, loops nowhere). */
    function wander(totalFrames, fps, seed, speed = 1) {
        const random = rng(seed);
        const waves = [0.13, 0.31, 0.57].map((f) => ({ f: f * speed * (0.8 + random() * 0.4), p: random() * Math.PI * 2, a: 0.5 + random() * 0.5 }));
        const norm = waves.reduce((s, w) => s + w.a, 0);
        return Array.from({ length: totalFrames }, (_, i) => waves.reduce((s, w) => s + w.a * Math.sin(w.p + 2 * Math.PI * w.f * (i / fps)), 0) / norm);
    }

    /**
     * Idle head motion for faux 3D: slow yaw / pitch drift and a little roll,
     * all in degrees. `energy` (optional per-frame 0..1, e.g. speech loudness)
     * adds nods on emphasis and livelier turns while talking.
     */
    function idleHead(totalFrames, fps, { seed = 5, energy = null, strength = 1 } = {}) {
        const yawN = wander(totalFrames, fps, seed, 0.7);
        const pitchN = wander(totalFrames, fps, seed + 1, 0.9);
        const rollN = wander(totalFrames, fps, seed + 2, 0.6);
        const env = energy ? smooth(energy, Math.round(0.12 * fps)) : null;
        const slow = energy ? smooth(energy, Math.round(0.7 * fps)) : null;
        const talk = (i) => (slow ? 0.5 + slow[i] : 1);
        const nod = (i) => (env ? Math.max(0, env[i] - slow[i]) * 9 : 0); // emphasis dips the chin

        const yaw = yawN.map((v, i) => v * 11 * talk(i) * strength);
        const pitch = pitchN.map((v, i) => (v * 4 * talk(i) + nod(i)) * strength);
        const roll = rollN.map((v, i) => v * 3 * talk(i) * strength);
        return { yaw: decimate(yaw, 0.15), pitch: decimate(pitch, 0.15), roll: decimate(roll, 0.1) };
    }

    /**
     * Eye darts (saccades): hold, then snap in ~2 frames to a new look target,
     * mostly near centre, occasionally a side glance. Units are -1..1 of the
     * iris travel range. Eyes also lead head turns (`yaw` track, degrees).
     */
    function saccades(totalFrames, fps, { seed = 9, yaw = null, energy = null } = {}) {
        const random = rng(seed);
        const x = new Array(totalFrames).fill(0);
        const y = new Array(totalFrames).fill(0);
        let tx = 0;
        let ty = 0;
        let px = 0;
        let py = 0;
        let next = Math.round((0.6 + random()) * fps);
        let moveStart = -100;
        const snap = Math.max(2, Math.round(0.06 * fps));
        for (let f = 0; f < totalFrames; f++) {
            if (f >= next) {
                px = x[f - 1] || 0;
                py = y[f - 1] || 0;
                const glance = random() < 0.25;
                tx = (random() * 2 - 1) * (glance ? 0.9 : 0.35);
                ty = (random() * 2 - 1) * (glance ? 0.5 : 0.2);
                if (random() < 0.4) { tx = 0; ty = 0; } // back to camera
                moveStart = f;
                next = f + Math.round((0.4 + random() * 2.2) * fps);
            }
            const t = clamp((f - moveStart) / snap, 0, 1);
            const e = 1 - (1 - t) ** 3; // fast out, soft landing
            const lead = yaw ? valueAt(yaw, f + Math.round(0.15 * fps)) / 14 : 0;
            x[f] = clamp(px + (tx - px) * e + lead, -1, 1);
            y[f] = py + (ty - py) * e;
        }
        // Acting in the pauses: when the speech stops for a beat mid-clip, the character looks off to
        // one side (thinking) and comes back just before it speaks again.
        if (energy) {
            const quiet = smooth(energy, Math.round(0.1 * fps)).map((v) => v < 0.05);
            const min = Math.round(0.8 * fps);
            let side = random() < 0.5 ? -1 : 1;
            for (let a = 0; a < totalFrames;) {
                if (!quiet[a]) { a++; continue; }
                let b = a;
                while (b < totalFrames && quiet[b]) b++;
                if (b - a >= min && a > Math.round(0.3 * fps) && b < totalFrames - Math.round(0.3 * fps)) {
                    const s0 = a + Math.round(0.2 * fps), s1 = b - Math.round(0.15 * fps);
                    for (let f = s0; f < s1; f++) {
                        const k = Math.min(1, (f - s0) / snap, (s1 - f) / snap);
                        const ease = 1 - (1 - Math.max(0, k)) ** 3;
                        x[f] = x[f] + (side * 0.75 - x[f]) * ease;
                        y[f] = y[f] + (-0.25 - y[f]) * ease;
                    }
                    side = -side;
                }
                a = b;
            }
        }
        return { x: decimate(x, 0.03), y: decimate(y, 0.03) };
    }

    /** Gentle breathing: body rises ~1 px every ~4 s (artwork px, negative = up). */
    function breathing(totalFrames, fps, seed = 3) {
        const random = rng(seed);
        const period = 3.6 + random() * 0.8;
        const phase = random() * Math.PI * 2;
        const values = Array.from({ length: totalFrames }, (_, i) => -((Math.sin(phase + (2 * Math.PI * i) / (fps * period)) + 1) / 2) * 1.6);
        return decimate(values, 0.05);
    }

    const OPEN = { MBP: 0, REST: 0.3, FV: 1, U: 1.5, I: 2, E: 3, O: 3, A: 4 };

    /**
     * Continuous jaw on top of the discrete mouth swaps, as a vertical scale
     * factor for the mouth layers (1 = as drawn).
     *  - `live` (per-frame 0..1, optional): measured openness — tracked jaw or
     *    voice loudness. The mouth opens/closes with it inside each shape.
     *  - Every new, more-open shape gets a small stretch that settles over a
     *    few frames (squash & stretch), so syllables read as motion, not swaps.
     */
    function jawScale(segments, totalFrames, fps, { live = null, toViseme = (k) => k } = {}) {
        const shapeOpen = new Array(totalFrames).fill(OPEN.REST / 4);
        const bounce = new Array(totalFrames).fill(0);
        const settle = Math.max(2, Math.round(0.12 * fps));
        let prevOpen = OPEN.REST;
        for (const seg of segments) {
            const open = OPEN[toViseme(seg.key)] !== undefined ? OPEN[toViseme(seg.key)] : OPEN.REST;
            for (let f = seg.start; f < Math.min(seg.end, totalFrames); f++) shapeOpen[f] = open / 4;
            const rise = open - prevOpen;
            if (rise > 0.5) {
                for (let i = 0; i < settle && seg.start + i < totalFrames; i++) {
                    bounce[seg.start + i] = Math.max(bounce[seg.start + i], 0.07 * Math.min(1, rise / 2) * Math.exp((-3 * i) / settle));
                }
            }
            prevOpen = open;
        }
        const liveSmooth = live ? smooth(live, 1) : null;
        const values = shapeOpen.map((base, f) => {
            // The live track can be shorter than the clip (audio ending before the
            // video): missing frames mean "no measurement", not NaN.
            const v = liveSmooth ? liveSmooth[f] : undefined;
            const measured = Number.isFinite(v) ? (v - base) * 0.45 : 0;
            return clamp(1 + measured + bounce[f], 0.8, 1.22);
        });
        return decimate(smooth(values, 1), 0.004, 3);
    }

    /** Shift timed events earlier — mouths should form a hair before the sound. */
    function leadEvents(events, ms) {
        return events.map((e) => ({ ...e, startMs: Math.max(0, e.startMs - ms), endMs: Math.max(0, e.endMs - ms) })).filter((e) => e.endMs > e.startMs);
    }

    /** Match a layer name to a rig part: eyeL/R, irisL/R, browL/R, head — or null. */
    function matchRigName(name) {
        const tokens = String(name || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
        const has = (...words) => tokens.some((t) => words.includes(t));
        const side = has('L', 'LEFT', 'LT') ? 'L' : has('R', 'RIGHT', 'RT') ? 'R' : null;
        if (has('BROW', 'EYEBROW', 'BROWS', 'EYEBROWS')) return side ? `brow${side}` : null;
        if (has('WHITE', 'SOCKET', 'SCLERA')) return null; // static eye parts in the templates
        if (has('IRIS', 'PUPIL', 'EYEBALL')) return side ? `iris${side}` : null;
        if (has('EYE', 'EYES')) return side ? `eye${side}` : null;
        if (has('HEAD', 'SKULL')) return 'head';
        if (has('BODY', 'TORSO', 'SHOULDERS', 'CHEST')) return 'body';
        return null;
    }

    return { clamp, valueAt, smooth, decimate, rng, autoBlinks, stepify, STEP, wander, idleHead, saccades, breathing, jawScale, leadEvents, matchRigName };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Motion;
}
