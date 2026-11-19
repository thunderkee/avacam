/**
 * SvgPath — parse, edit and write SVG path data for the character editor.
 *
 * A path becomes a list of absolute segments:
 *   { c: 'M', p }            move to p
 *   { c: 'L', p }            line to p (H and V become L)
 *   { c: 'C', c1, c2, p }    cubic curve (S becomes C)
 *   { c: 'Q', c1, p }        quadratic curve (T becomes Q)
 *   { c: 'A', rx, ry, rot, large, sweep, p }
 *   { c: 'Z' }               close
 * where points are [x, y]. Simple shapes (circle, ellipse, rect, line,
 * polygon, polyline) convert to equivalent path data so they can be edited too.
 */
const SvgPath = (() => {
    const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
    const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

    function parse(d) {
        const tokens = String(d || '').match(TOKEN) || [];
        const segs = [];
        let i = 0;
        let cmd = null;
        let cur = [0, 0];
        let start = [0, 0];
        let lastCtrl = null; // reflected by S / T
        let lastCmd = null;
        const num = () => Number(tokens[i++]);
        while (i < tokens.length) {
            if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
            else if (!cmd) { i++; continue; }
            const up = cmd.toUpperCase();
            const rel = cmd !== up;
            if (up === 'Z') {
                segs.push({ c: 'Z' });
                cur = start.slice();
                lastCtrl = null;
                lastCmd = 'Z';
                cmd = null;
                continue;
            }
            if (i + ARGS[up] > tokens.length || tokens.slice(i, i + ARGS[up]).some((t) => /[A-Za-z]/.test(t))) break;
            const pt = () => {
                const x = num();
                const y = num();
                return rel ? [cur[0] + x, cur[1] + y] : [x, y];
            };
            if (up === 'M') {
                const p = pt();
                segs.push({ c: 'M', p });
                cur = p;
                start = p.slice();
                lastCtrl = null;
                cmd = rel ? 'l' : 'L'; // further pairs are line-tos
            } else if (up === 'L') {
                const p = pt();
                segs.push({ c: 'L', p });
                cur = p;
                lastCtrl = null;
            } else if (up === 'H') {
                const x = num();
                const p = [rel ? cur[0] + x : x, cur[1]];
                segs.push({ c: 'L', p });
                cur = p;
                lastCtrl = null;
            } else if (up === 'V') {
                const y = num();
                const p = [cur[0], rel ? cur[1] + y : y];
                segs.push({ c: 'L', p });
                cur = p;
                lastCtrl = null;
            } else if (up === 'C') {
                const c1 = pt();
                const c2 = pt();
                const p = pt();
                segs.push({ c: 'C', c1, c2, p });
                lastCtrl = c2;
                cur = p;
            } else if (up === 'S') {
                const c1 = lastCtrl && (lastCmd === 'C' || lastCmd === 'S') ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur.slice();
                const c2 = pt();
                const p = pt();
                segs.push({ c: 'C', c1, c2, p });
                lastCtrl = c2;
                cur = p;
            } else if (up === 'Q') {
                const c1 = pt();
                const p = pt();
                segs.push({ c: 'Q', c1, p });
                lastCtrl = c1;
                cur = p;
            } else if (up === 'T') {
                const c1 = lastCtrl && (lastCmd === 'Q' || lastCmd === 'T') ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur.slice();
                const p = pt();
                segs.push({ c: 'Q', c1, p });
                lastCtrl = c1;
                cur = p;
            } else if (up === 'A') {
                const rx = num();
                const ry = num();
                const rot = num();
                const large = num() ? 1 : 0;
                const sweep = num() ? 1 : 0;
                const p = pt();
                segs.push({ c: 'A', rx, ry, rot, large, sweep, p });
                lastCtrl = null;
                cur = p;
            }
            lastCmd = up;
        }
        return segs;
    }

    const n = (v) => {
        const r = Math.round(v * 100) / 100;
        return Object.is(r, -0) ? '0' : String(r);
    };
    const pt = (p) => `${n(p[0])},${n(p[1])}`;

    function serialize(segs) {
        return segs.map((s) => {
            switch (s.c) {
                case 'M': case 'L': return `${s.c}${pt(s.p)}`;
                case 'C': return `C${pt(s.c1)} ${pt(s.c2)} ${pt(s.p)}`;
                case 'Q': return `Q${pt(s.c1)} ${pt(s.p)}`;
                case 'A': return `A${n(s.rx)},${n(s.ry)} ${n(s.rot)} ${s.large},${s.sweep} ${pt(s.p)}`;
                default: return 'Z';
            }
        }).join(' ');
    }

    /** Path data equivalent to a basic shape element's geometry (attrs: name → string). */
    function shapeToPath(tag, a) {
        const f = (k, d = 0) => (a[k] == null || a[k] === '' ? d : parseFloat(a[k]));
        const K = 0.5522847498; // cubic approximation of a quarter circle
        const ellipse = (cx, cy, rx, ry) =>
            `M${n(cx + rx)},${n(cy)} C${n(cx + rx)},${n(cy + ry * K)} ${n(cx + rx * K)},${n(cy + ry)} ${n(cx)},${n(cy + ry)} ` +
            `C${n(cx - rx * K)},${n(cy + ry)} ${n(cx - rx)},${n(cy + ry * K)} ${n(cx - rx)},${n(cy)} ` +
            `C${n(cx - rx)},${n(cy - ry * K)} ${n(cx - rx * K)},${n(cy - ry)} ${n(cx)},${n(cy - ry)} ` +
            `C${n(cx + rx * K)},${n(cy - ry)} ${n(cx + rx)},${n(cy - ry * K)} ${n(cx + rx)},${n(cy)} Z`;
        switch (tag) {
            case 'circle': return ellipse(f('cx'), f('cy'), f('r'), f('r'));
            case 'ellipse': return ellipse(f('cx'), f('cy'), f('rx'), f('ry'));
            case 'rect': {
                const x = f('x');
                const y = f('y');
                const w = f('width');
                const h = f('height');
                let rx = a.rx != null ? f('rx') : a.ry != null ? f('ry') : 0;
                let ry = a.ry != null ? f('ry') : rx;
                rx = Math.min(rx, w / 2);
                ry = Math.min(ry, h / 2);
                if (!rx || !ry) return `M${n(x)},${n(y)} L${n(x + w)},${n(y)} L${n(x + w)},${n(y + h)} L${n(x)},${n(y + h)} Z`;
                const kx = rx * K;
                const ky = ry * K;
                return `M${n(x + rx)},${n(y)} L${n(x + w - rx)},${n(y)} C${n(x + w - rx + kx)},${n(y)} ${n(x + w)},${n(y + ry - ky)} ${n(x + w)},${n(y + ry)} ` +
                    `L${n(x + w)},${n(y + h - ry)} C${n(x + w)},${n(y + h - ry + ky)} ${n(x + w - rx + kx)},${n(y + h)} ${n(x + w - rx)},${n(y + h)} ` +
                    `L${n(x + rx)},${n(y + h)} C${n(x + rx - kx)},${n(y + h)} ${n(x)},${n(y + h - ry + ky)} ${n(x)},${n(y + h - ry)} ` +
                    `L${n(x)},${n(y + ry)} C${n(x)},${n(y + ry - ky)} ${n(x + rx - kx)},${n(y)} ${n(x + rx)},${n(y)} Z`;
            }
            case 'line': return `M${n(f('x1'))},${n(f('y1'))} L${n(f('x2'))},${n(f('y2'))}`;
            case 'polygon':
            case 'polyline': {
                const nums = String(a.points || '').match(TOKEN) || [];
                const pts = [];
                for (let i = 0; i + 1 < nums.length; i += 2) pts.push(`${n(+nums[i])},${n(+nums[i + 1])}`);
                if (!pts.length) return '';
                return `M${pts.join(' L')}${tag === 'polygon' ? ' Z' : ''}`;
            }
            default: return null;
        }
    }

    /** Geometry attributes a shape loses when it becomes a path. */
    const GEOMETRY = { circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry'], line: ['x1', 'y1', 'x2', 'y2'], polygon: ['points'], polyline: ['points'] };
    const EDITABLE = new Set(['path', ...Object.keys(GEOMETRY)]);

    /**
     * Every draggable point: segment end points ("p") and curve controls ("c1"/"c2").
     * Returns [{ seg, kind, x, y, anchor? }] where controls name the node they hang off.
     */
    function points(segs) {
        const out = [];
        let prev = null;
        segs.forEach((s, i) => {
            if (s.c === 'Z') return;
            if (s.c === 'C') {
                out.push({ seg: i, kind: 'c1', x: s.c1[0], y: s.c1[1], anchor: prev });
                out.push({ seg: i, kind: 'c2', x: s.c2[0], y: s.c2[1], anchor: s.p });
            } else if (s.c === 'Q') {
                out.push({ seg: i, kind: 'c1', x: s.c1[0], y: s.c1[1], anchor: prev, anchor2: s.p });
            }
            out.push({ seg: i, kind: 'p', x: s.p[0], y: s.p[1] });
            prev = s.p;
        });
        return out;
    }

    const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

    /**
     * Move one point to (x, y). Moving a node carries its curve handles with it,
     * and a subpath's start and its closing point (when they coincide) move together.
     */
    function movePoint(segs, seg, kind, x, y) {
        const out = segs.map((s) => ({ ...s, p: s.p && s.p.slice(), c1: s.c1 && s.c1.slice(), c2: s.c2 && s.c2.slice() }));
        const s = out[seg];
        if (!s || s.c === 'Z') return out;
        if (kind !== 'p') {
            s[kind] = [x, y];
            return out;
        }
        const dx = x - s.p[0];
        const dy = y - s.p[1];
        const shift = (i, withIn, withOut) => {
            const t = out[i];
            if (!t || !t.p) return;
            t.p = [t.p[0] + dx, t.p[1] + dy];
            if (withIn && t.c === 'C') t.c2 = [t.c2[0] + dx, t.c2[1] + dy];
            const next = out[i + 1];
            if (withOut && next && next.c === 'C') next.c1 = [next.c1[0] + dx, next.c1[1] + dy];
        };
        shift(seg, true, true);
        // Find this subpath's bounds to keep a closed outline closed.
        let start = seg;
        while (start > 0 && segs[start].c !== 'M') start--;
        let end = seg;
        while (end + 1 < segs.length && segs[end + 1].c !== 'M') end++;
        const closed = segs[end] && segs[end].c === 'Z';
        const lastDraw = closed ? end - 1 : end;
        if (closed && segs[start].c === 'M' && start !== lastDraw && same(segs[start].p, segs[lastDraw].p)) {
            if (seg === start) shift(lastDraw, true, false);
            else if (seg === lastDraw) {
                out[start].p = [out[start].p[0] + dx, out[start].p[1] + dy];
                const first = out[start + 1];
                if (first && first.c === 'C') first.c1 = [first.c1[0] + dx, first.c1[1] + dy];
            }
        }
        return out;
    }

    return { parse, serialize, shapeToPath, points, movePoint, GEOMETRY, EDITABLE };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SvgPath;
}
