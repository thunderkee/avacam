/**
 * LipSync — the text → phoneme → mouth-shape timeline engine.
 *
 * Ported from the Talking Head Generator web app (SRT parser, word timing,
 * CMU phoneme lookup, viseme mapping) and reshaped for Lottie Creator: the
 * output is a frame-based segment list plus per-mouth opacity keyframes that
 * the plugin sandbox applies to real Creator layers.
 *
 * Pure functions only — no DOM, no `creator` — so it runs in the UI iframe and
 * in Node tests alike.
 */
const LipSync = (() => {
    const REST = 'REST';

    // The 39 CMU phonemes we have mouth artwork for (assets/mouths/<PHONEME>.svg).
    const PHONEMES = [
        'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'B', 'CH', 'D', 'DH', 'EH', 'ER', 'EY',
        'F', 'G', 'HH', 'IH', 'IY', 'JH', 'K', 'L', 'M', 'N', 'NG', 'OW', 'OY', 'P',
        'R', 'S', 'SH', 'T', 'TH', 'UH', 'UW', 'V', 'W', 'Y', 'Z', 'ZH'
    ];

    // The 8-shape viseme set described in the original project README.
    const VISEMES = ['REST', 'A', 'E', 'I', 'O', 'U', 'MBP', 'FV'];

    const PHONEME_TO_VISEME = {
        AA: 'A', AE: 'A', AH: 'A', AY: 'A', AW: 'A',
        EH: 'E', EY: 'E', ER: 'E', HH: 'E',
        T: 'E', D: 'E', N: 'E', L: 'E', S: 'E', Z: 'E', TH: 'E', DH: 'E',
        K: 'E', G: 'E', NG: 'E',
        IH: 'I', IY: 'I', Y: 'I',
        AO: 'O', OW: 'O', OY: 'O',
        UW: 'U', UH: 'U', W: 'U', R: 'U', CH: 'U', JH: 'U', SH: 'U', ZH: 'U',
        M: 'MBP', B: 'MBP', P: 'MBP',
        F: 'FV', V: 'FV',
        SIL: REST
    };

    // Which built-in artwork represents each viseme / the rest pose.
    const VISEME_ARTWORK = { REST: 'M', A: 'AA', E: 'EH', I: 'IY', O: 'OW', U: 'UW', MBP: 'M', FV: 'F' };

    // Alternative layer names accepted when matching the user's own mouth layers.
    const ALIASES = {
        REST: ['REST', 'SIL', 'SILENT', 'SILENCE', 'NEUTRAL', 'IDLE', 'CLOSED', 'X'],
        MBP: ['MBP', 'BMP', 'PBM'],
        FV: ['FV', 'VF']
    };

    // How open each viseme is — used to insert in-betweens on big jumps.
    const OPENNESS = { MBP: 0, REST: 0.3, FV: 1, U: 1.5, I: 2, E: 3, O: 3, A: 4 };

    const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

    const stripStress = (phoneme) => String(phoneme).toUpperCase().replace(/[012]$/, '');

    // ---------------------------------------------------------------- input

    /** Parse SRT text into cues: [{ startMs, endMs, text }]. Tolerates CRLF and "." millis. */
    function parseSRT(content) {
        const cues = [];
        const blocks = String(content || '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
        const timing = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

        for (const block of blocks) {
            const lines = block.trim().split('\n');
            const timingIndex = lines.findIndex((line) => timing.test(line));
            if (timingIndex === -1) continue;

            const m = lines[timingIndex].match(timing);
            const toMs = (h, mi, s, ms) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +ms.padEnd(3, '0');
            const startMs = toMs(m[1], m[2], m[3], m[4]);
            const endMs = toMs(m[5], m[6], m[7], m[8]);
            const text = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]*>/g, '').trim();

            if (endMs > startMs && text) cues.push({ startMs, endMs, text });
        }
        return cues.sort((a, b) => a.startMs - b.startMs);
    }

    /**
     * Turn a plain script into timed cues at a given speaking rate.
     * Each line / sentence becomes a cue; a short pause separates cues.
     */
    function textToCues(text, { wpm = 150, pauseMs = 350, leadInMs = 300 } = {}) {
        const msPerWord = 60000 / Math.max(40, wpm);
        const sentences = String(text || '')
            .split(/\n+|(?<=[.!?])\s+/)
            .map((s) => s.trim())
            .filter(Boolean);

        const cues = [];
        let t = leadInMs;
        for (const sentence of sentences) {
            const words = sentence.split(/\s+/).filter(Boolean);
            const duration = Math.max(250, Math.round(words.length * msPerWord));
            cues.push({ startMs: t, endMs: t + duration, text: sentence });
            t += duration + pauseMs;
        }
        return cues;
    }

    // ---------------------------------------------------------- phonemes

    /**
     * Expand cues into a phoneme timeline: [{ phoneme, startMs, endMs, word }].
     * Words share a cue's duration in proportion to their phoneme weight
     * (vowels hold longer than consonants), which reads more naturally than
     * the equal split the original app used.
     */
    function cuesToPhonemes(cues, dictionary) {
        const events = [];
        const unknownWords = new Set();
        let wordCount = 0;

        for (const cue of cues) {
            const words = cue.text
                .split(/\s+/)
                .map((raw) => ({ raw, clean: raw.replace(/[^A-Za-z']/g, '').replace(/'/g, '') }))
                .filter((w) => w.clean.length > 0);
            if (words.length === 0) continue;

            const expanded = words.map((w) => {
                if (!dictionary.hasWord(w.clean)) unknownWords.add(w.clean.toLowerCase());
                const phonemes = dictionary.getPhonemesSafe(w.clean).map(stripStress).filter((p) => PHONEME_TO_VISEME[p]);
                const weights = phonemes.map((p) => (VOWELS.has(p) ? 1.4 : 1));
                return { ...w, phonemes, weights, weight: weights.reduce((a, b) => a + b, 0) };
            }).filter((w) => w.phonemes.length > 0);

            const total = expanded.reduce((sum, w) => sum + w.weight, 0);
            if (total === 0) continue;

            const msPerWeight = (cue.endMs - cue.startMs) / total;
            let t = cue.startMs;
            for (const w of expanded) {
                wordCount++;
                w.phonemes.forEach((phoneme, i) => {
                    const d = w.weights[i] * msPerWeight;
                    events.push({ phoneme, startMs: t, endMs: t + d, word: w.raw, wordIndex: wordCount - 1 });
                    t += d;
                });
            }
        }

        return { events, wordCount, unknownWords: [...unknownWords] };
    }

    // ----------------------------------------------------- languages

    /**
     * Bahasa Indonesia letter-to-sound rules. Indonesian spelling is close to
     * phonemic, so rules beat a dictionary: digraphs (ng, ny, sy, kh) and the
     * diphthongs (ai, au, oi) first, then single letters. Output uses the same
     * CMU symbols as English, so the rest of the pipeline is unchanged.
     */
    const ID_RULES = [
        ['ng', ['NG']], ['ny', ['N', 'Y']], ['sy', ['SH']], ['kh', ['HH']],
        ['ai', ['AY']], ['au', ['AW']], ['oi', ['OY']],
        ['a', ['AA']], ['i', ['IY']], ['u', ['UW']], ['e', ['EH']], ['o', ['OW']],
        ['b', ['B']], ['c', ['CH']], ['d', ['D']], ['f', ['F']], ['g', ['G']], ['h', ['HH']],
        ['j', ['JH']], ['k', ['K']], ['l', ['L']], ['m', ['M']], ['n', ['N']], ['p', ['P']],
        ['q', ['K']], ['r', ['R']], ['s', ['S']], ['t', ['T']], ['v', ['F']], ['w', ['W']],
        ['x', ['K', 'S']], ['y', ['Y']], ['z', ['Z']],
    ];

    function indonesianPhonemes(word) {
        const w = String(word).toLowerCase().replace(/[^a-z]/g, '');
        const out = [];
        for (let i = 0; i < w.length;) {
            const rule = ID_RULES.find(([letters]) => w.startsWith(letters, i));
            if (!rule) { i++; continue; }
            // A word-final "h" after a vowel is barely voiced ("rumah", "sudah").
            if (rule[0] === 'h' && i === w.length - 1 && i > 0) { i++; continue; }
            out.push(...rule[1]);
            i += rule[0].length;
        }
        return out.length ? out : ['AH'];
    }

    // Other Latin-script languages: spelling → sound rules, coarse but enough to
    // pick mouth shapes (the 8 visemes barely care about fine vowel quality).
    // A rule is [letters, phonemes, when?]: 'front' = before e/i/y, 'final' =
    // at the end of the word, 'initial' = at the start. Longest match wins, so
    // list digraphs first. Letters a rule set doesn't cover fall back to BASE.
    const BASE_RULES = [
        ['a', ['AA']], ['e', ['EH']], ['i', ['IY']], ['o', ['OW']], ['u', ['UW']], ['y', ['IY']],
        ['b', ['B']], ['c', ['K']], ['d', ['D']], ['f', ['F']], ['g', ['G']], ['h', ['HH']],
        ['j', ['JH']], ['k', ['K']], ['l', ['L']], ['m', ['M']], ['n', ['N']], ['p', ['P']],
        ['q', ['K']], ['r', ['R']], ['s', ['S']], ['t', ['T']], ['v', ['V']], ['w', ['W']],
        ['x', ['K', 'S']], ['z', ['Z']],
    ];
    const LANG_RULES = {
        id: { rules: ID_RULES },
        ms: { rules: ID_RULES },
        es: {
            pre: { 'ñ': 'ñ' },
            rules: [
                ['ñ', ['N', 'Y']], ['ll', ['Y']], ['rr', ['R']], ['ch', ['CH']], ['qu', ['K']], ['gue', ['G', 'EH']], ['gui', ['G', 'IY']],
                ['c', ['S'], 'front'], ['g', ['HH'], 'front'], ['j', ['HH']], ['h', []], ['v', ['B']], ['z', ['S']], ['y', ['Y']],
                ['ai', ['AY']], ['ei', ['EY']], ['oi', ['OY']], ['au', ['AW']],
            ],
        },
        pt: {
            pre: { 'ç': 'ç', 'ã': 'ã', 'õ': 'õ' },
            rules: [
                ['ção', ['S', 'AW', 'N']], ['ões', ['OY', 'N', 'S']], ['ão', ['AW', 'N']], ['ã', ['AA', 'N']], ['õ', ['OW', 'N']], ['ç', ['S']],
                ['lh', ['L', 'Y']], ['nh', ['N', 'Y']], ['ch', ['SH']], ['rr', ['HH']], ['qu', ['K']], ['ss', ['S']],
                ['c', ['S'], 'front'], ['g', ['ZH'], 'front'], ['j', ['ZH']], ['x', ['SH']], ['h', []],
                ['m', ['N'], 'final'], ['e', ['IY'], 'final'], ['o', ['UW'], 'final'],
                ['ei', ['EY']], ['ou', ['OW']], ['ai', ['AY']], ['au', ['AW']], ['oi', ['OY']],
            ],
        },
        fr: {
            pre: { 'ç': 'ç' },
            rules: [
                ['eaux', ['OW']], ['eau', ['OW']], ['aux', ['OW']], ['au', ['OW']], ['ou', ['UW']], ['oi', ['W', 'AA']], ['oy', ['W', 'AA', 'Y']],
                ['ain', ['EH', 'N']], ['ein', ['EH', 'N']], ['ai', ['EH']], ['ei', ['EH']], ['eu', ['ER']], ['œu', ['ER']],
                ['ent', [], 'final'], ['es', [], 'final'], ['er', ['EY'], 'final'], ['ez', ['EY'], 'final'], ['et', ['EH'], 'final'],
                ['on', ['OW', 'N']], ['an', ['AA', 'N']], ['en', ['AA', 'N']], ['in', ['EH', 'N']], ['un', ['ER', 'N']],
                ['ch', ['SH']], ['ph', ['F']], ['th', ['T']], ['qu', ['K']], ['gn', ['N', 'Y']], ['ill', ['IY', 'Y']], ['ç', ['S']],
                ['c', ['S'], 'front'], ['g', ['ZH'], 'front'], ['j', ['ZH']], ['h', []], ['u', ['UW']], ['e', [], 'final'], ['e', ['AH']],
                ['s', [], 'final'], ['t', [], 'final'], ['d', [], 'final'], ['x', [], 'final'], ['z', [], 'final'], ['p', [], 'final'],
            ],
        },
        de: {
            pre: { 'ä': 'ä', 'ö': 'ö', 'ü': 'ü', 'ß': 'ß' },
            rules: [
                ['tsch', ['CH']], ['sch', ['SH']], ['sp', ['SH', 'P'], 'initial'], ['st', ['SH', 'T'], 'initial'], ['ch', ['HH']], ['ck', ['K']],
                ['ei', ['AY']], ['ai', ['AY']], ['ie', ['IY']], ['eu', ['OY']], ['äu', ['OY']], ['au', ['AW']], ['ph', ['F']], ['th', ['T']], ['qu', ['K', 'V']],
                ['er', ['ER'], 'final'], ['ä', ['EH']], ['ö', ['ER']], ['ü', ['UW']], ['ß', ['S']], ['tz', ['T', 'S']], ['z', ['T', 'S']],
                ['w', ['V']], ['v', ['F']], ['j', ['Y']], ['y', ['UW']], ['e', ['AH'], 'final'], ['h', [], 'final'],
            ],
        },
        it: {
            rules: [
                ['gli', ['L', 'Y', 'IY']], ['gn', ['N', 'Y']], ['sci', ['SH', 'IY']], ['sce', ['SH', 'EH']], ['ch', ['K']], ['gh', ['G']],
                ['ci', ['CH'], 'beforevowel'], ['gi', ['JH'], 'beforevowel'], ['c', ['CH'], 'front'], ['g', ['JH'], 'front'],
                ['qu', ['K', 'W']], ['zz', ['T', 'S']], ['z', ['T', 'S']], ['h', []], ['j', ['Y']],
            ],
        },
        nl: {
            rules: [
                ['sch', ['S', 'HH']], ['ij', ['AY']], ['ei', ['AY']], ['oe', ['UW']], ['ui', ['AW']], ['eu', ['ER']], ['ou', ['AW']], ['au', ['AW']],
                ['aa', ['AA']], ['ee', ['EY']], ['oo', ['OW']], ['uu', ['UW']], ['ie', ['IY']], ['ch', ['HH']], ['g', ['HH']],
                ['j', ['Y']], ['w', ['V']], ['v', ['F']], ['en', ['AH'], 'final'], ['e', ['AH'], 'final'], ['u', ['UH']],
            ],
        },
    };
    const VOWEL_LETTERS = 'aeiouyàáâäãåèéêëìíîïòóôöõùúûü';

    /** Lower-case, keep the letters a language's rules name, strip other accents. */
    function normalizeWord(word, keep = {}) {
        let out = '';
        for (const ch of String(word).toLowerCase()) {
            if (keep[ch]) { out += ch; continue; }
            const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
            if (/[a-zœ]/.test(plain)) out += plain;
        }
        return out;
    }

    /** Phonemes (CMU symbols) for a word in `language` by spelling rules. */
    function letterPhonemes(word, language) {
        const lang = LANG_RULES[language];
        if (!lang) return ['AH'];
        const w = normalizeWord(word, lang.pre);
        const rules = [...lang.rules, ...BASE_RULES].map((r, i) => ({ letters: r[0], ph: r[1], when: r[2], i }));
        const fits = (r, i) => {
            if (!w.startsWith(r.letters, i)) return false;
            const end = i + r.letters.length;
            if (r.when === 'final') return end === w.length;
            if (r.when === 'initial') return i === 0;
            if (r.when === 'front') return end < w.length && 'eiy'.includes(w[end]);
            if (r.when === 'beforevowel') return end < w.length && VOWEL_LETTERS.includes(w[end]);
            return true;
        };
        const out = [];
        for (let i = 0; i < w.length;) {
            let best = null;
            for (const r of rules) if (fits(r, i) && (!best || r.letters.length > best.letters.length)) best = r;
            if (!best) { i++; continue; }
            // Indonesian / Malay: a word-final "h" after a vowel is barely voiced.
            if ((language === 'id' || language === 'ms') && best.letters === 'h' && i === w.length - 1 && i > 0) { i++; continue; }
            out.push(...best.ph);
            i += best.letters.length;
        }
        return out.length ? out : ['AH'];
    }

    /** Languages with mouth rules: code → { name, whisper, tts } ('en' uses the CMU dictionary). */
    const LANGUAGES = {
        en: { name: 'English', whisper: 'english', mac: 'en' },
        id: { name: 'Bahasa Indonesia', whisper: 'indonesian', mac: 'id' },
        ms: { name: 'Bahasa Melayu', whisper: 'malay', mac: 'ms' },
        es: { name: 'Español', whisper: 'spanish', mac: 'es' },
        pt: { name: 'Português', whisper: 'portuguese', mac: 'pt' },
        fr: { name: 'Français', whisper: 'french', mac: 'fr' },
        de: { name: 'Deutsch', whisper: 'german', mac: 'de' },
        it: { name: 'Italiano', whisper: 'italian', mac: 'it' },
        nl: { name: 'Nederlands', whisper: 'dutch', mac: 'nl' },
    };

    /** A dictionary-shaped object for a language ('en' uses the CMU dictionary). */
    function dictionaryFor(language, english) {
        if (!LANG_RULES[language]) return english;
        return { hasWord: () => true, getPhonemesSafe: (word) => letterPhonemes(word, language) };
    }

    // ---------------------------------------------------------- segments

    /** Map a phoneme to the shape key used by the chosen set ('visemes' | 'phonemes'). */
    function shapeKeyFor(phoneme, set) {
        if (phoneme === 'SIL') return REST;
        return set === 'phonemes' ? phoneme : PHONEME_TO_VISEME[phoneme] || REST;
    }

    /**
     * Build a contiguous, frame-quantised segment list covering [0, totalFrames).
     * Gaps are filled with REST, identical neighbours merge, and segments shorter
     * than `minHoldFrames` are absorbed so the mouth never flickers.
     */
    function buildSegments(events, { set = 'visemes', fps = 30, totalFrames, minHoldFrames = 2, inbetweens = true } = {}) {
        const msToFrame = (ms) => Math.round((ms / 1000) * fps);
        const raw = [];

        for (const e of events) {
            const start = msToFrame(e.startMs);
            const end = msToFrame(e.endMs);
            if (end <= start) continue;
            // Events may carry a ready-made shape (audio / face tracking) instead of a phoneme.
            raw.push({ key: e.shape || shapeKeyFor(e.phoneme, set), start, end, word: e.word || '' });
        }
        raw.sort((a, b) => a.start - b.start);

        const lastEnd = raw.length ? raw[raw.length - 1].end : 0;
        const frames = Math.max(1, totalFrames || lastEnd);

        // Lay segments on a contiguous track, filling holes with REST.
        const track = [];
        let cursor = 0;
        for (const seg of raw) {
            const start = Math.max(seg.start, cursor);
            const end = Math.min(seg.end, frames);
            if (end <= start) continue;
            if (start > cursor) track.push({ key: REST, start: cursor, end: start, word: '' });
            track.push({ ...seg, start, end });
            cursor = end;
        }
        if (cursor < frames) track.push({ key: REST, start: cursor, end: frames, word: '' });

        const held = mergeShort(mergeSame(track), Math.max(1, minHoldFrames));
        return inbetweens ? addInbetweens(held, set) : held;
    }

    /**
     * Classic lip-sync in-betweens: a jump from closed to wide open (or back)
     * gets one frame of a half-open shape, so the mouth reads as moving rather
     * than popping. Rounded shapes pass through U, others through E.
     */
    function addInbetweens(segments, set) {
        const viseme = (key) => (OPENNESS[key] !== undefined ? key : PHONEME_TO_VISEME[key] || REST);
        const toSet = (v) => (set === 'phonemes' ? { E: 'EH', U: 'UW', O: 'OW', I: 'IY' }[v] : v);
        // The half-way shape: rounded moves pass through O/U, others through E/I —
        // whichever sits between the two openings and isn't an endpoint.
        const midFor = (a, b) => {
            const pool = [a, b].some((k) => k === 'O' || k === 'U') ? ['O', 'U'] : ['E', 'I'];
            const lo = Math.min(OPENNESS[a], OPENNESS[b]);
            const hi = Math.max(OPENNESS[a], OPENNESS[b]);
            // Pool is in preference order (E before I, O before U).
            return pool.find((k) => k !== a && k !== b && OPENNESS[k] > lo && OPENNESS[k] < hi) || null;
        };
        const out = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = { ...segments[i] };
            const prev = out[out.length - 1];
            const a = prev && viseme(prev.key);
            const b = viseme(seg.key);
            const jump = prev ? Math.abs(OPENNESS[a] - OPENNESS[b]) : 0;
            // The in-between borrows the first frame of the new shape, which keeps ≥ 1 frame.
            if (prev && jump >= 2.5 && seg.end - seg.start >= 2) {
                const mid = midFor(a, b);
                if (mid) {
                    out.push({ key: toSet(mid), start: seg.start, end: seg.start + 1, word: seg.word, inbetween: true });
                    seg.start += 1;
                }
            }
            out.push(seg);
        }
        return out;
    }

    function mergeSame(track) {
        const out = [];
        for (const seg of track) {
            const prev = out[out.length - 1];
            if (prev && prev.key === seg.key) {
                prev.end = seg.end;
                if (seg.word && !prev.word.endsWith(seg.word)) prev.word = `${prev.word} ${seg.word}`.trim();
            } else {
                out.push({ ...seg });
            }
        }
        return out;
    }

    function mergeShort(track, minHold) {
        if (minHold <= 1) return track;
        let out = track.map((s) => ({ ...s }));
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < out.length; i++) {
                const seg = out[i];
                if (seg.end - seg.start >= minHold || out.length === 1) continue;
                // Give the frames to the longer neighbour.
                const prev = out[i - 1];
                const next = out[i + 1];
                const target = !prev ? next : !next ? prev : (prev.end - prev.start >= next.end - next.start ? prev : next);
                if (target === prev) prev.end = seg.end;
                else next.start = seg.start;
                out.splice(i, 1);
                out = mergeSame(out);
                changed = true;
                break;
            }
        }
        return out;
    }

    /** Remap segment keys onto the shapes that actually exist (for user-supplied layers). */
    function remapSegments(segments, available) {
        const has = (k) => available.includes(k);
        const mapped = segments.map((seg) => {
            let key = seg.key;
            if (!has(key) && PHONEME_TO_VISEME[key] && has(PHONEME_TO_VISEME[key])) key = PHONEME_TO_VISEME[key];
            if (!has(key)) key = has(REST) ? REST : has('MBP') ? 'MBP' : available[0];
            return { ...seg, key };
        });
        return mergeSame(mapped);
    }

    // ---------------------------------------------------------- keyframes

    /**
     * Opacity keyframes (0 / 100) for one shape. Each visible run switches in a
     * 1/50-frame window just before its frame, so even players that render
     * between frames (lottie-web at 60–120 Hz) never show two shapes blended.
     * (plugin.js falls back to whole frames + a hold-style ease if Creator
     * rejects fractional frames.)
     */
    const SWITCH = 0.02;
    function opacityKeyframes(segments, key) {
        const frames = new Map();
        const put = (frame, value) => { if (frame >= 0) frames.set(Math.round(frame * 1000) / 1000, value); };
        const runs = segments.filter((s) => s.key === key);
        const totalEnd = segments.length ? segments[segments.length - 1].end : 0;

        put(0, runs.length && runs[0].start === 0 ? 100 : 0);
        for (const run of runs) {
            if (run.start > 0) {
                put(run.start - SWITCH, 0);
                put(run.start, 100);
            }
            if (run.end < totalEnd) {
                put(run.end - SWITCH, 100);
                put(run.end, 0);
            }
        }
        return [...frames.entries()].sort((x, y) => x[0] - y[0]).map(([frame, value]) => ({ frame, value }));
    }

    /** Keyframe tracks for every shape used in the segments: { key: [{frame, value}] }. */
    function buildTracks(segments) {
        const keys = [...new Set(segments.map((s) => s.key))];
        const tracks = {};
        for (const key of keys) tracks[key] = opacityKeyframes(segments, key);
        return tracks;
    }

    /** Which built-in SVG file draws a given shape key. */
    function artworkFor(key, set) {
        if (set === 'phonemes') return key === REST ? VISEME_ARTWORK.REST : key;
        return VISEME_ARTWORK[key] || VISEME_ARTWORK.REST;
    }

    // ------------------------------------------------- layer-name matching

    /** Match a layer name to a shape key in the given set, or null. */
    function matchLayerName(name, set) {
        const tokens = String(name || '')
            .toUpperCase()
            .replace(/MOUTH|VISEME|PHONEME|SHAPE/g, ' ')
            .split(/[^A-Z0-9]+/)
            .filter(Boolean);
        const keys = set === 'phonemes' ? [...PHONEMES, REST] : VISEMES;

        for (const key of keys) {
            const names = ALIASES[key] || [key];
            if (tokens.some((t) => names.includes(t))) return key;
        }
        return null;
    }

    return {
        REST,
        PHONEMES,
        VISEMES,
        PHONEME_TO_VISEME,
        parseSRT,
        textToCues,
        indonesianPhonemes,
        letterPhonemes,
        LANGUAGES,
        dictionaryFor,
        cuesToPhonemes,
        buildSegments,
        addInbetweens,
        OPENNESS,
        remapSegments,
        opacityKeyframes,
        buildTracks,
        artworkFor,
        matchLayerName
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LipSync;
}
