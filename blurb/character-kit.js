/**
 * CharacterKit — build-your-own characters from parts.
 *
 * Three bases:
 *  - person(cfg): Theo's soft 3D look (radial-gradient skin, blurred inner shadows),
 *    with swappable hair, eyes, brows, nose, mouth, outfit and extras.
 *  - head(cfg): Orb's floating head (a gradient blob with a glow), with swappable
 *    shape, palette, eyes, mouth and extras.
 *  - flat(cfg): Kai's flat geometric look, male or female, with swappable face,
 *    hair, eyes, brows, nose, mouth, outfit and extras.
 *
 * Both return the same character data the built-in characters use (parts with
 * roles, ¾ and side drawings, turn-view geometry), so the rig, lip sync and the
 * editor treat a custom character exactly like Theo or Orb. With no options they
 * reproduce Theo, Orb and Kai exactly (scripts/characters.mjs builds them from here).
 *
 * Only what Creator's SVG import keeps: gradients, single Gaussian blurs, no dashed
 * strokes and no perfectly vertical stroke-only lines. No <mask>: Creator drops it (a masked
 * group arrives as loose, unclipped shape layers), so clipping is done geometrically and inner
 * shading is drawn as gradient fills of the outline (see "mask-free clipping").
 *
 * Runs in Node (the build) and in the panel (the character builder).
 */
const CharacterKit = (() => {
  const W = 400;
  const H = 500;
  const MOUTH_KEYS = ['REST', 'MBP', 'A', 'E', 'I', 'O', 'U', 'FV', 'SMILE', 'LAUGH', 'FROWN'];
  const EYE_STATES = ['open', 'half', 'closed', 'happy'];
  const TURN_DEG = 28;
  const PROFILE_DEG = 70;
  const mouthName = (key) => (key === 'REST' ? 'Mouth Rest' : key.length > 3 ? `Mouth ${key[0]}${key.slice(1).toLowerCase()}` : `Mouth ${key}`);
  const stateName = (state) => (state === 'open' ? '' : ` ${state[0].toUpperCase()}${state.slice(1)}`);

  // ------------------------------------------------------------ colour helpers
  const hexRgb = (hex) => {
    const v = hex.replace('#', '');
    const f = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
    return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
  };
  const rgbHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  const mix = (a, b, t) => { const x = hexRgb(a); const y = hexRgb(b); return rgbHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lighten = (c, t) => mix(c, '#FFFFFF', t);
  const darken = (c, t) => mix(c, '#000000', t);
  const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
  /** A colour with its saturation and lightness pushed (HSL), e.g. a warm, clear nose from the skin. */
  const tone = (hex, ds, dl) => {
    const [r, g, b] = hexRgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; const dd = max - min;
    let h = 0; let sat = 0;
    if (dd) { sat = dd / (1 - Math.abs(2 * l - 1)); h = max === r ? ((g - b) / dd) % 6 : max === g ? (b - r) / dd + 2 : (r - g) / dd + 4; }
    const s2 = Math.min(1, sat + ds); const l2 = Math.max(0, Math.min(1, l + dl));
    const c2 = (1 - Math.abs(2 * l2 - 1)) * s2; const x = c2 * (1 - Math.abs((h % 2) - 1)); const m = l2 - c2 / 2;
    const [r2, g2, b2] = h < 1 ? [c2, x, 0] : h < 2 ? [x, c2, 0] : h < 3 ? [0, c2, x] : h < 4 ? [0, x, c2] : h < 5 ? [x, 0, c2] : [c2, 0, x];
    return rgbHex([r2 + m, g2 + m, b2 + m].map((v) => (v < 0 ? v + 1 : v) * 255));
  };

  // ------------------------------------------------------------ geometry helpers
  /** Map every absolute "x,y" pair from a reference drawing space into the canvas. */
  function refMapper(k, ox, oy, cx = 0, cy = 0) {
    const pt = (x, y) => [+((x - cx) * k + ox).toFixed(1), +((y - cy) * k + oy).toFixed(1)];
    return {
      k,
      pt,
      at: (x, y) => { const [px, py] = pt(x, y); return { x: px, y: py }; },
      d: (path) => path.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => pt(+x, +y).join(',')),
      s: (v) => +(v * k).toFixed(2),
    };
  }

  // ---- mask-free clipping
  // Creator's SVG import drops <mask> (a masked group arrives as loose, unclipped shape layers), so
  // anything that has to stay inside an outline is clipped here instead: the shapes are sampled to
  // polygons and intersected (Sutherland–Hodgman against a convex outline), and the result is drawn
  // as a plain path. Blurred shading can't be clipped this way; it's drawn as gradient fills of the
  // outline itself.

  /** Sample path data (M L H V C Q A Z, absolute) into polygons (one per subpath). */
  function samplePath(dd, step = 4) {
    const t = dd.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    const polys = [];
    let cur = null; let cmd = 'M'; let x = 0; let y = 0; let sx = 0; let sy = 0;
    const seg = (f, len) => { const n = Math.max(2, Math.ceil(len / step)); for (let i = 1; i <= n; i++) cur.push(f(i / n)); };
    for (let i = 0; i < t.length;) {
      if (/[A-Za-z]/.test(t[i])) { cmd = t[i++]; if (cmd === 'Z' || cmd === 'z') { if (cur) cur.push([sx, sy]); x = sx; y = sy; } continue; }
      const num = () => +t[i++];
      if (cmd === 'M') { x = num(); y = num(); sx = x; sy = y; cur = [[x, y]]; polys.push(cur); cmd = 'L'; }
      else if (cmd === 'L') { x = num(); y = num(); cur.push([x, y]); }
      else if (cmd === 'H') { x = num(); cur.push([x, y]); }
      else if (cmd === 'V') { y = num(); cur.push([x, y]); }
      else if (cmd === 'C') {
        const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()]; const x0 = x; const y0 = y;
        seg((u) => { const v = 1 - u; return [v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3]; }, Math.hypot(x3 - x0, y3 - y0) + Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x3 - x2, y3 - y2));
        x = x3; y = y3;
      } else if (cmd === 'Q') {
        const [x1, y1, x2, y2] = [num(), num(), num(), num()]; const x0 = x; const y0 = y;
        seg((u) => { const v = 1 - u; return [v * v * x0 + 2 * v * u * x1 + u * u * x2, v * v * y0 + 2 * v * u * y1 + u * u * y2]; }, Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1));
        x = x2; y = y2;
      } else if (cmd === 'A') {
        // Endpoint → centre parameterisation (SVG spec F.6.5), no rotation needed here.
        let rx = Math.abs(num()); let ry = Math.abs(num()); num(); const fa = num(); const fs = num(); const x2 = num(); const y2 = num();
        const x1p = (x - x2) / 2; const y1p = (y - y2) / 2;
        const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
        const sign = fa === fs ? -1 : 1;
        const co = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
        const cxp = (co * rx * y1p) / ry; const cyp = (-co * ry * x1p) / rx;
        const cx = cxp + (x + x2) / 2; const cy = cyp + (y + y2) / 2;
        const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
        seg((u) => [cx + rx * Math.cos(t1 + dt * u), cy + ry * Math.sin(t1 + dt * u)], Math.abs(dt) * Math.max(rx, ry));
        x = x2; y = y2;
      } else i++;
    }
    return polys;
  }
  const ellipsePoly = (cx, cy, rx, ry, n = 48) => Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)]);
  const rectPoly = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  /** Convex hull (monotone chain). */
  function hull(pts) {
    const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = []; for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    const up = []; for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  /** Subject polygon clipped to a convex polygon. */
  function clipConvex(subject, clip) {
    const area = clip.reduce((a, p, i) => { const q = clip[(i + 1) % clip.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
    const k = area > 0 ? 1 : -1;
    let out = subject;
    for (let i = 0; i < clip.length && out.length; i++) {
      const a = clip[i]; const b = clip[(i + 1) % clip.length];
      const inside = (p) => k * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0;
      const cut = (p, q) => { const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); const d2 = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]); const u = d1 / (d1 - d2); return [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u]; };
      const inp = out; out = [];
      for (let j = 0; j < inp.length; j++) {
        const p = inp[j]; const q = inp[(j + 1) % inp.length];
        if (inside(q)) { if (!inside(p)) out.push(cut(p, q)); out.push(q); } else if (inside(p)) out.push(cut(p, q));
      }
    }
    return out;
  }
  const polyD = (pts) => (pts.length > 2 ? `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')} Z` : 'M0,0 Z');
  /** Path data clipped to a convex outline (given as path data or a polygon). */
  const clipD = (dd, outline) => samplePath(dd).map((poly) => polyD(clipConvex(poly, Array.isArray(outline) ? outline : samplePath(outline)[0]))).join(' ');
  /** Open strokes trimmed to the part of them at least `margin` inside a convex outline. */
  function clipLine(dd, outline, margin = 0) {
    const poly = samplePath(outline)[0];
    const area = poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
    const k = area > 0 ? 1 : -1;
    const depth = ([x, y]) => Math.min(...poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) return Infinity; // the closing point repeats the first
      return (k * ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]))) / len;
    }));
    const runs = [];
    for (const line of samplePath(dd, 1.5)) {
      let run = [];
      for (const pt of line) { if (depth(pt) >= margin) run.push(pt); else { if (run.length > 1) runs.push(run); run = []; } }
      if (run.length > 1) runs.push(run);
    }
    return runs.map((r) => `M${r.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')}`).join(' ') || 'M0,0';
  }
  /** The span of a convex polygon along a horizontal line (null when it misses). */
  function spanAt(poly, y) {
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % poly.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    return xs.length >= 2 ? [Math.min(...xs), Math.max(...xs)] : null;
  }

  /** Map every coordinate of an SVG fragment (path data + circle/ellipse centres). */
  function warpSvg(body, map) {
    const warpD = (d) => {
      const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
      const arity = { M: 2, L: 2, T: 2, C: 6, S: 4, Q: 4, A: 7, H: 1, V: 1, Z: 0 };
      const out = [];
      let cmd = 'M';
      let last = [0, 0];
      for (let i = 0; i < tokens.length;) {
        if (/[A-Za-z]/.test(tokens[i])) { cmd = tokens[i].toUpperCase(); out.push(tokens[i]); i++; continue; }
        const n = arity[cmd];
        const args = tokens.slice(i, i + n).map(Number);
        i += n;
        if (cmd === 'A') {
          const [x, y] = map(args[5], args[6]);
          out.push(`${args.slice(0, 5).join(' ')} ${x.toFixed(1)},${y.toFixed(1)}`);
          last = [args[5], args[6]];
        } else if (cmd === 'H') {
          out.push(map(args[0], last[1])[0].toFixed(1));
          last = [args[0], last[1]];
        } else if (cmd === 'V') {
          out.push(args[0]);
          last = [last[0], args[0]];
        } else {
          for (let k = 0; k < n; k += 2) {
            const [x, y] = map(args[k], args[k + 1]);
            out.push(`${x.toFixed(1)},${y.toFixed(1)}`);
          }
          last = [args[n - 2], args[n - 1]];
        }
      }
      return out.join(' ');
    };
    return body
      .replace(/\sd="([^"]+)"/g, (_, d) => ` d="${warpD(d)}"`)
      .replace(/<(circle|ellipse)\b([^>]*?)\/?>/g, (tag, name, attrs) => {
        const cx = Number((attrs.match(/\bcx="([-\d.]+)"/) || [])[1]);
        const cy = Number((attrs.match(/\bcy="([-\d.]+)"/) || [])[1]);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return tag;
        const [x, y] = map(cx, cy);
        let out = tag.replace(/\bcx="[-\d.]+"/, `cx="${x.toFixed(1)}"`).replace(/\bcy="[-\d.]+"/, `cy="${y.toFixed(1)}"`);
        const rx = Number((attrs.match(/\brx="([-\d.]+)"/) || [])[1]);
        if (name === 'ellipse' && Number.isFinite(rx)) {
          // Ellipses on the surface (blush, ears) narrow with the turn.
          // (Clamped: right at the sphere's edge the wrap's slope runs off to infinity.)
          const stretch = Math.max(0.3, Math.min(1.4, Math.abs(map(cx + 1, cy)[0] - map(cx - 1, cy)[0]) / 2));
          out = out.replace(/\brx="[-\d.]+"/, `rx="${(rx * stretch).toFixed(1)}"`);
        }
        return out;
      });
  }

  /** Two ¾ drawings (features wrap around the head) and two side profiles. Canvas units. */
  function withTurnViews(parts, { cx = 200, radius, flat = null, features, quarter = {}, profile = {}, profileEye, profileMouth, profileAfterFace = [], behindBody = [] }) {
    const wrapX = (from, to, k, body) => `<g transform="translate(${to.toFixed(2)} 0) scale(${k.toFixed(3)} 1) translate(${(-from).toFixed(2)} 0)">${body}</g>`;
    const front = parts.filter((p) => p.group === 'head');
    const viewParts = [];
    const geometry = {};
    for (const dir of [1, -1]) {
      const view = dir > 0 ? 'R' : 'L';
      const th = (dir * TURN_DEG * Math.PI) / 180;
      const sphereU = (u) => {
        if (Math.abs(u) <= radius) return radius * Math.sin(Math.max(-Math.PI / 2, Math.min(Math.PI / 2, Math.asin(u / radius) + th)));
        const g = Math.sign(u);
        return sphereU(g * radius) + (u - g * radius) * Math.cos(th);
      };
      const surfaceX = flat
        ? (x) => { const far = (x - cx) * dir > 0; return cx + (x - cx) * (far ? flat.farK : 1) + dir * flat.shift; }
        : (x) => x + (sphereU(x - cx) + cx - x) * 0.8;
      const feature = flat
        ? (x) => ({ x: surfaceX(x), k: (x - cx) * dir > 0 ? flat.farK : 1 })
        : (x) => ({ x: surfaceX(x), k: Math.abs(surfaceX(x + 1) - surfaceX(x - 1)) / 2 });
      const bend = (amount) => (body) => warpSvg(body, (x, y) => [x + (surfaceX(x) - x) * amount, y]);
      const around = (x, body, extra = 0) => { const f = feature(x); return wrapX(x, f.x + extra, f.k, body); };
      const ctx = { dir, view, near: dir > 0 ? 'L' : 'R', surfaceX, feature, bend, around, wrapX };
      geometry[view] = { eyes: { L: feature(features.L), R: feature(features.R) } };
      for (const p of front) {
        const base = p.id;
        let body;
        if (quarter[base]) body = quarter[base](ctx, p);
        else if (p.role === 'mouth') body = around(features.mouth, p.body);
        else if (p.side) body = around(features[p.side], p.body);
        else if (base === 'nose') body = around(features.nose, p.body, dir * 5);
        else body = bend(0.5)(p.body);
        if (body) viewParts.push({ ...p, id: `${base}@${view}`, name: `${p.name} (¾ ${view})`, view, body });
      }
    }
    for (const dir of [1, -1]) {
      const view = dir > 0 ? 'PR' : 'PL';
      const near = dir > 0 ? 'L' : 'R';
      const px = (dx) => cx + dir * dx;
      const ctx = { dir, view, near, px, wrapX };
      geometry[view] = { eyes: { [near]: { x: px(profileEye.dx), k: profileEye.k } } };
      const list = [];
      for (const p of front) {
        let body = null;
        if (profile[p.id]) body = profile[p.id](ctx, p);
        else if (p.role === 'mouth') body = wrapX(features.mouth, px(profileMouth.dx), profileMouth.k, p.body);
        else if (p.side) body = p.side === near ? wrapX(features[p.side], px(profileEye.dx), profileEye.k, p.body) : null;
        if (body) list.push({ ...p, id: `${p.id}@${view}`, name: `${p.name} (side ${dir > 0 ? 'R' : 'L'})`, view, body });
      }
      const faceAt = list.findIndex((q) => q.id === `face@${view}`);
      const moved = list.filter((q) => profileAfterFace.includes(q.id.split('@')[0]));
      const rest = list.filter((q) => !moved.includes(q));
      const at = rest.findIndex((q) => q.id === `face@${view}`);
      viewParts.push(...(faceAt >= 0 ? [...rest.slice(0, at + 1), ...moved, ...rest.slice(at + 1)] : list));
    }
    const all = [...parts.map((p) => (p.group === 'head' ? { view: 'F', ...p } : p))];
    const back = viewParts.filter((p) => behindBody.includes(p.id.split('@')[0]));
    const bodyAt = all.findIndex((p) => p.group === 'body');
    all.splice(bodyAt < 0 ? 0 : bodyAt, 0, ...back);
    all.push(...viewParts.filter((p) => !back.includes(p)));
    return {
      parts: all,
      turnViews: { angle: TURN_DEG, enter: 22, exit: 15, geometry, profile: { angle: PROFILE_DEG, enter: 48, exit: 40 } },
    };
  }

  /** Head-and-shoulders tile framing: the head (top → chin pivot) fills ~70% of a square. */
  // Tiles line every character's eyes up at the same height (as the 3D head sits), with `k` scaling the
  // character up inside the tile (the Flat heads read smaller than the 3D ones at the same box).
  const EYE_LINE = 0.47;
  function alignThumb(thumb, eyeY, k = 1, line = EYE_LINE) {
    const [x, , w] = thumb.split(' ').map(Number);
    const size = w / k, cx = x + w / 2;
    const r = (v) => Math.round(v * 10) / 10;
    return `${r(cx - size / 2)} ${r(eyeY - line * size)} ${r(size)} ${r(size)}`;
  }
  function thumbFor(top, pivot) {
    const size = (pivot.y - top) / 0.7;
    const r = (v) => Math.round(v * 10) / 10;
    return `${r(pivot.x - size / 2)} ${r(top - size * 0.08)} ${r(size)} ${r(size)}`;
  }

  const blurFilter = (id, v) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="-100" y="-100" width="600" height="700"><feGaussianBlur stdDeviation="${v}"/></filter>`;

  // ======================================================================
  //  Person (Theo's base)
  // ======================================================================

  /** Skin tones: [gradient light, mid, edge] plus the shadows drawn in that skin. */
  const THEO_SKIN = {
    s: ['#FAC7BD', '#F2AAA0', '#DC8D85'], ball: ['#FBC9BF', '#F0A49A', '#D8857D'],
    neckShadow: '#7A4A48', lidLine: '#C97C74', happy: '#B86C66', rim: '#B9706B', brim: '#9C5E5A',
    ear: '#D98A82', eyeShadow: '#A9625E', brow: '#C47A72', nose: '#9C5752',
  };
  const toneFrom = (light, mid, edge) => {
    const deep = mix(edge, '#3A1E1C', 0.45);
    return {
      s: [light, mid, edge], ball: [lighten(light, 0.08), mid, darken(edge, 0.03)],
      neckShadow: mix(edge, '#2A1414', 0.55), lidLine: mix(mid, deep, 0.35), happy: mix(edge, deep, 0.35), rim: mix(edge, deep, 0.3),
      brim: mix(edge, deep, 0.5), ear: mix(mid, edge, 0.6), eyeShadow: mix(edge, deep, 0.4), brow: mix(mid, deep, 0.4), nose: mix(edge, deep, 0.6),
    };
  };
  const SKIN_TONES = {
    rose: THEO_SKIN,
    porcelain: toneFrom('#FFE9DE', '#F7D3C3', '#E2B3A1'),
    sand: toneFrom('#F8D9B8', '#EDBF94', '#D49E72'),
    olive: toneFrom('#E8C29A', '#D2A273', '#B07F52'),
    brown: toneFrom('#C98E66', '#A86E48', '#865236'),
    deep: toneFrom('#9A6346', '#7A4A32', '#5C3524'),
    mint: toneFrom('#D7F5E4', '#AEE5C8', '#7FC8A2'),
    lilac: toneFrom('#ECE0FF', '#CDB8F5', '#A790DC'),
  };

  const PERSON_DEFAULT = {
    base: 'person', id: 'theo', name: 'Theo', prefix: 'theo',
    skin: 'rose', hair: 'cap', hairColor: '#F6F1E1', eyes: 'sleepy', irisColor: '#111111', brows: 'soft',
    nose: 'ball', mouth: 'smile', lipColor: '#B8645F', outfit: 'tee', outfitColor: '#262626',
    extras: ['earbuds'], extraColor: '#2A2A2A', thumbBg: '#6B9B78', headTop: 30,
  };

  // Where each hair style's top sits (canvas y), for the tile framing.
  // Designed colours of the two-colour outfits' second piece (overridden by cfg.outfitColor2).
  const OUTFIT_SECONDARY = { jacket: '#E9DCC6', cardigan: '#F3F0EA', varsity: '#F3F0EA', scarf: '#1F6B63' };
  // The Flat outfits' second piece: the shirt collar, undershirt panel or necklace.
  const FLAT_SECONDARY = { sweater: '#F4F1EC', cardigan: '#F4F1EC', bomber: '#F4F1EC', blouse: '#F4F1EC' };
  /** The designed secondary colour of an outfit on a base (undefined for one-colour outfits). */
  const outfitSecondary = (base, outfit) => (base === 'flat' ? FLAT_SECONDARY : base === 'person' ? OUTFIT_SECONDARY : {})[outfit];
  const HAIR_TOP = { cap: 30, none: 94, short: 62, curly: 52, bun: 34, long: 52, beanie: 22, centerPart: 34, spaceBuns: 30, curlyBob: 40, bob: 44, sweep: 56, bowl: 60, crop: 56, slick: 56, flattop: 48, fWavy: 16, fSweep: 18 };

  function person(options = {}) {
    const cfg = { ...PERSON_DEFAULT, ...options };
    const P = cfg.prefix || cfg.id;
    const tone = SKIN_TONES[cfg.skin] || (cfg.skin && cfg.skin.s ? cfg.skin : THEO_SKIN);
    const extras = new Set(cfg.extras || []);
    const M = refMapper(0.45, 200, 0, 408, 0);
    const { d, s, at } = M;
    const SKIN = `url(#${P}Skin)`;
    // Face shape: the round default, or oval (Skin → Oval face) — the same width at the ears (so ears,
    // hair and glasses fit) and full cheeks; only from the jaw down does it taper to a longer chin.
    // The face follows the body: Masculine is round, Feminine oval.
    const oval = cfg.build === 'woman';
    const JAW = oval
      ? ' C668,450 664,545 650,625 C628,745 525,848 410,850 C295,848 192,745 170,625 C156,545 150,450 152,330 Z'
      : ' C668,450 660,560 640,650 C615,760 530,830 410,832 C290,830 205,760 178,650 C158,560 150,450 152,330 Z';
    const HEAD_CAP = 'M152,330 C150,250 250,210 410,210 C570,210 668,250 666,330' + JAW;
    // With no hair the skull gets a rounded crown (the flat top is shaped to sit under a cap or hair).
    const HEAD = cfg.hair === 'none' ? 'M152,330 C150,180 262,118 410,118 C558,118 668,180 666,330' + JAW : HEAD_CAP;
    const eyeC = { L: [313, 462], R: [497, 462] };
    const EYE = { rx: 80, ry: 76 };
    const ellipse = (cx, cy, rx, ry, attrs) => `<ellipse cx="${at(cx, cy).x}" cy="${at(cx, cy).y}" rx="${s(rx)}" ry="${s(ry)}" ${attrs}/>`;

    // Hat / hair colours. Theo's cap keeps its exact cream tones. Headwear (cap, beanie, baseball cap,
    // hijab) takes the headwear colour when one is set, so brows and beard can keep the hair colour;
    // `hc` is the colour the hair layer is drawn in, `hairC` the hair's own.
    const headwear = ['cap', 'beanie', 'fBaseball', 'fHijab'].includes(cfg.hair);
    const hc = headwear && cfg.hatColor ? cfg.hatColor : cfg.hairColor;
    const hairC = cfg.hatColor || !headwear ? cfg.hairColor : null; // null: no hair colour of its own (old saves)
    const capTones = same(hc, '#F6F1E1')
      ? { cap: ['#F6F1E1', '#E6DEC6'], brim: ['#F3EDDA', '#D9CFB4'], seam: '#D6CCB0', button: '#ECE4CF' }
      : { cap: [hc, darken(hc, 0.1)], brim: [lighten(hc, 0.04), darken(hc, 0.14)], seam: darken(hc, 0.16), button: darken(hc, 0.05) };
    const hairTones = [lighten(hc, 0.22), hc, darken(hc, 0.28)];
    const oc = cfg.outfitColor;
    const outfitTones = same(oc, '#262626') ? { top: '#262626', bottom: '#0E0E0E', line: '#3A3A3A' } : { top: oc, bottom: darken(oc, 0.35), line: lighten(oc, 0.12) };

    // The Flat character's hairstyles, drawn on the 3D head: their art is scaled from the flat face
    // (119..281 × 90..274) onto this one (85..316 × 94.5..374), solid fills become this kit's hair
    // gradients (a light-to-dark sweep for the mass, rounded shading for curls and buns), and soft
    // highlights are added for depth and reflection.
    const FLAT_HAIR = { fCrop: 'cap', fQuiff: 'quiff', fSweep: 'sweep', fBowl: 'bowl', fCurls: 'curls', fBob: 'bob', fBangs: 'bangs', fWavy: 'wavy', fSide: 'longSide', fHijab: 'hijab', fBaseball: 'baseball' };
    const flatStyle = FLAT_HAIR[cfg.hair];
    const hideEars = flatStyle === 'hijab';
    const flatC = flatStyle && { id: `${P}F`, hair: hc, hairLight: mix(hc, '#FFFFFF', 0.05), skinShadow: '#010203', hairStyle: flatStyle, inner: '#F4F1EC', accent: '#3D3D3D', headband: false };
    const FX = 1.43, FY = 1.52;
    const toHead = (x, y) => [200.5 + (x - 200) * FX, 94.5 + (y - 90) * FY];
    const onHead = (body) => body
      .replace(/<(circle|ellipse)\b([^>]*?)\/>/g, (tag, name, attrs) => {
        const num = (k) => { const m = new RegExp(`\\b${k}="([-\\d.]+)"`).exec(attrs); return m ? +m[1] : null; };
        const [x, y] = toHead(num('cx'), num('cy'));
        const rx = (num('rx') ?? num('r')) * FX, ry = (num('ry') ?? num('r')) * FY;
        let rest = attrs.replace(/\b(cx|cy|rx|ry|r)="[^"]*"/g, '').trim();
        if (/fill="(#[0-9A-Fa-f]{6})"/.test(rest) && [hc, flatC.hairLight].some((h) => rest.toUpperCase().includes(`FILL="${h.toUpperCase()}"`))) rest = rest.replace(/fill="#[0-9A-Fa-f]{6}"/, `fill="url(#${P}HairBall)"`);
        return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" ${rest}/>`;
      })
      .replace(/\sd="([^"]+)"/g, (_, dd) => ` d="${warpSvg(`<path d="${dd}"/>`, toHead).match(/d="([^"]+)"/)[1]}"`)
      .replace(/stroke-width="([\d.]+)"/g, (_, w) => `stroke-width="${(+w * 1.47).toFixed(2)}"`)
      .split(`url(#${P}F-hair)`).join(HAIR)
      .replace(new RegExp(`fill="${hc}"`, 'gi'), `fill="${HAIR}"`)
      .replace(new RegExp(`fill="${flatC.hairLight}"`, 'gi'), `fill="${HAIR}"`);
    // On the rounder 3D head the Flat styles' square sideburns and side strips read as blocks, so
    // they taper here (into the temples for the crop and sweep, toward the jaw for the bangs).
    const TAPER = {
      cap: [['M116,170 L116,126 C116,96 140,72 172,72 L228,72 C260,72 284,96 284,126 L284,170 Q277,174 268,170 L268,112 L132,112 L132,170 Q123,174 116,170 Z', 'M114,158 C110,118 124,90 150,78 L250,78 C276,90 290,118 286,158 C282,140 276,124 268,114 L132,114 C124,124 118,140 114,158 Z'],
        [/<path d="M115,112 L133,112 L133,156 L115,156 Z M267,112 L285,112 L285,156 L267,156 Z"[^>]*\/>/, ''],
      ],
      sweep: [['M116,172 L116,122 C116,98 134,84 158,82 C168,58 200,40 238,42 C274,44 294,70 292,104 L286,172 L274,172 L272,128 C238,124 200,118 176,112 C150,116 132,124 130,150 L130,172 Z', 'M114,168 C112,124 120,96 158,82 C168,58 200,40 238,42 C274,44 294,70 292,104 C292,130 290,150 286,170 C282,150 278,138 272,128 C238,124 200,118 176,112 C150,116 132,124 124,140 C120,148 116,158 114,168 Z']],
      bangs: [['M106,128 L126,128 L124,214 L106,220 Z M294,128 L274,128 L276,214 L294,220 Z', 'M106,128 L128,128 C126,160 122,192 112,222 L106,222 Z M294,128 L272,128 C274,160 278,192 288,222 L294,222 Z']],
    };
    const flatHair = flatStyle ? Flat.hair(flatC) : null;
    if (flatHair && TAPER[flatStyle]) for (const [a, b] of TAPER[flatStyle]) flatHair.front = flatHair.front.replace(a, b);
    // The Flat styles' strand lines read as drawn-on ink on the 3D head, so the hair keeps only its
    // filled masses and lets the gradients and soft highlights give the volume (the cap's seams stay).
    if (flatHair && flatStyle !== 'baseball') for (const k of ['front', 'back']) if (flatHair[k]) flatHair[k] = flatHair[k].replace(/<path\b[^>]*fill="none"[^>]*\/>/g, '');
    const defs = [
      `<radialGradient id="${P}Skin" gradientUnits="userSpaceOnUse" cx="${at(360, 420).x}" cy="${at(360, 420).y}" r="${s(470)}"><stop offset="0" stop-color="${tone.s[0]}"/><stop offset="0.6" stop-color="${tone.s[1]}"/><stop offset="1" stop-color="${tone.s[2]}"/></radialGradient>`,
      `<radialGradient id="${P}Ball" cx="0.38" cy="0.32" r="0.8"><stop offset="0" stop-color="${tone.ball[0]}"/><stop offset="0.7" stop-color="${tone.ball[1]}"/><stop offset="1" stop-color="${tone.ball[2]}"/></radialGradient>`,
      `<radialGradient id="${P}White" cx="0.45" cy="0.7" r="0.7"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.8" stop-color="#F1EEEE"/><stop offset="1" stop-color="#D9D3D3"/></radialGradient>`,
      `<linearGradient id="${P}Cap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${capTones.cap[0]}"/><stop offset="1" stop-color="${capTones.cap[1]}"/></linearGradient>`,
      `<linearGradient id="${P}Brim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${capTones.brim[0]}"/><stop offset="1" stop-color="${capTones.brim[1]}"/></linearGradient>`,
      `<radialGradient id="${P}Pod" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#D8DADF"/></radialGradient>`,
      `<linearGradient id="${P}Tee" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${outfitTones.top}"/><stop offset="1" stop-color="${outfitTones.bottom}"/></linearGradient>`,
      blurFilter(`${P}BlurL`, 10), blurFilter(`${P}BlurM`, 5), blurFilter(`${P}BlurS`, 2),
      `<mask id="${P}Head" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${d(HEAD)}" fill="#FFFFFF"/></mask>`,
      ...['L', 'R'].map((side) => `<mask id="${P}Eye${side}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${ellipse(...eyeC[side], EYE.rx, EYE.ry, 'fill="#FFFFFF"')}</mask>`),
    ];
    if (flatStyle) {
      defs.push(`<radialGradient id="${P}HairBall" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="${hairTones[0]}"/><stop offset="0.6" stop-color="${hairTones[1]}"/><stop offset="1" stop-color="${hairTones[2]}"/></radialGradient>`);
      defs.push(`<linearGradient id="${P}F-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hc}"/><stop offset="1" stop-color="${hc}" stop-opacity="0"/></linearGradient>`);
    }
    if (cfg.hair !== 'cap' && cfg.hair !== 'none') {
      defs.push(`<radialGradient id="${P}Hair" gradientUnits="userSpaceOnUse" cx="${at(340, 160).x}" cy="${at(340, 160).y}" r="${s(420)}"><stop offset="0" stop-color="${hairTones[0]}"/><stop offset="0.55" stop-color="${hairTones[1]}"/><stop offset="1" stop-color="${hairTones[2]}"/></radialGradient>`);
    }
    const HAIR = `url(#${P}Hair)`;

    // ---- eyes
    const openEdge = { sleepy: 2, awake: -36, wide: -64 }[cfg.eyes] ?? 2;
    // bold: a half blink's lid edge reads as a lash line, like the shut eye's.
    const lid = (side, edgeY, bold = false) => {
      // The lid is skin cut to the eye's own outline (clipped here: Creator drops SVG masks), with a
      // soft shade under its edge and the edge line spanning the eye.
      const c = at(...eyeC[side]); const rx = s(EYE.rx); const ry = s(EYE.ry);
      const eye = ellipsePoly(c.x, c.y, rx, ry);
      const edge = at(0, edgeY).y;
      const cover = polyD(clipConvex(rectPoly(c.x - rx - 4, c.y - ry - 4, rx * 2 + 8, edge - (c.y - ry - 4)), eye));
      const shade = polyD(clipConvex(rectPoly(c.x - rx - 4, edge, rx * 2 + 8, 7), eye));
      const span = spanAt(eye, edge);
      return `<path d="${shade}" fill="${tone.neckShadow}" fill-opacity="0.25"/>` +
        `<path d="${cover}" fill="url(#${P}Ball)"/>` +
        (span ? `<path d="M${(span[0] + 1).toFixed(1)},${edge.toFixed(1)} L${(span[1] - 1).toFixed(1)},${edge.toFixed(1)}" fill="none" stroke="${bold ? LASH : tone.lidLine}" stroke-width="${bold ? 5.5 : s(5)}" stroke-linecap="round"/>` : '');
    };
    // Square eyes (Figma "Theo — Front" variants): rounded-square whites with square pupils, in canvas px.
    // Dots: round dark dots with no white (Figma "Eyes · Dots"); the lids are skin of the same shape.
    // Dots are centred on the same line as the Googly and Sleepy eyes (y 207.9).
    const SQ = { L: { x: 141, y: 193.4 }, R: { x: 229.9, y: 193.4 }, w: 27, h: 29, r: 13.5 };
    const boxEyes = cfg.eyes === 'dots';
    // Square (Figma "Eyes · Square"): a softly squared eye, a little lower at the outer corner, filled
    // by a big iris (with a dark pupil, rim shade and glint) that's clipped to it, under a soft crease.
    // Drawn for the left eye in the design's layer space and placed (mirrored for the right) on the canvas.
    const sqEye = (side, dd) => dd.replace(/(-?\d*\.?\d+)[ ,](-?\d*\.?\d+)/g, (_, x, y) => `${(side === 'L' ? +x + 115.61 : 278.47 - +x).toFixed(2)},${(+y + 187.85).toFixed(2)}`);
    const sqX = (side, x) => (side === 'L' ? x + 115.61 : 278.47 - x);
    const SQ_WHITE = 'M10.86 31.89C10.10 16.60 23.66 4.51 38.76 7.02L45.94 8.21C56.62 9.98 64.79 18.68 65.89 29.46L66.57 36.18C67.00 40.40 63.62 44.02 59.38 43.88L17.83 42.54C14.19 42.42 11.24 39.53 11.06 35.89L10.86 31.89Z';
    const SQ_SHADOW = 'M10.03 35.74C9.26 20.45 22.82 8.37 37.92 10.87L45.10 12.06C55.78 13.84 63.96 22.54 65.05 33.31L65.74 40.04C66.16 44.25 62.78 47.88 58.54 47.74L16.99 46.40C13.35 46.28 10.41 43.39 10.22 39.75L10.03 35.74Z';
    const SQ_CREASE = 'M65.88 29.64C65.05 21.31 58.38 10.54 47.88 8.68C30.88 5.68 19.88 5.18 11.38 25.18';
    // Googly and Sleepy (the Googly eye under a heavy, relaxed lid) share one eye: rim, white and iris.
    const goog = cfg.eyes === 'googly' || cfg.eyes === 'doll';
    const drowsy = cfg.eyes === 'doll';
    // The googly white is lit from the top: white fading to a soft grey at its lower edge, so the
    // rim of white left beside the pupil reads as a thin grey glint (as in the design).
    if (goog) defs.push(`<radialGradient id="${P}GoogIris" cx="0.5" cy="0.62" r="0.55"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`);
    if (goog) defs.push(`<radialGradient id="${P}GoogWhite" cx="0.5" cy="0.36" r="0.72"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.8" stop-color="#F1EEEE"/><stop offset="1" stop-color="#D9D3D3"/></radialGradient>`);
    if (cfg.eyes === 'square') {
      // Iris shading in canvas space (the iris is clipped to the eye, so its box isn't the iris's).
      for (const side of ['L', 'R']) {
        const ix = sqX(side, 38.13), iy = 28.64 + 187.85;
        defs.push(`<radialGradient id="${P}SqRim${side}" gradientUnits="userSpaceOnUse" cx="${(ix + (side === 'L' ? 2.85 : -2.85)).toFixed(2)}" cy="${(iy - 21.9).toFixed(2)}" r="39"><stop offset="0.48" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000"/></radialGradient>`,
          `<radialGradient id="${P}SqPupil${side}" gradientUnits="userSpaceOnUse" cx="${ix.toFixed(2)}" cy="${iy.toFixed(2)}" r="24.6"><stop offset="0" stop-color="#000000"/><stop offset="0.38" stop-color="#333333"/><stop offset="0.51" stop-color="#666666" stop-opacity="0"/></radialGradient>`);
      }
    }
    const sqBox = (side, pad = 0) => ({ x: SQ[side].x - pad, y: SQ[side].y - pad, w: SQ.w + pad * 2, h: SQ.h + pad * 2, r: SQ.r + pad });
    const sqPath = ({ x, y, w, h, r }, bottom = y + h) => (bottom >= y + h - r
      ? `M${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} Z`
      : `M${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${bottom} L${x},${bottom} Z`);
    // Shut eyes are just a bold line on the face: the rig hides the eye white and iris while an eye
    // is closed or happy (shutHidesEyes), so no lid shape shows behind it. Closed is a dark lash curve
    // with a soft shadow; happy is the same weight arched up.
    const LASH = darken(tone.lidLine, 0.35);
    const happyLine = (x0, x1, y, rise) => `<path d="M${x0.toFixed(2)},${y.toFixed(2)} Q${((x0 + x1) / 2).toFixed(2)},${(y + rise).toFixed(2)} ${x1.toFixed(2)},${y.toFixed(2)}" fill="none" stroke="${LASH}" stroke-width="6.5" stroke-linecap="round"/>`;
    const lash = (x0, x1, y, sag, w = 6.5) => {
      const pth = `M${x0.toFixed(2)},${y.toFixed(2)} Q${((x0 + x1) / 2).toFixed(2)},${(y + sag).toFixed(2)} ${x1.toFixed(2)},${y.toFixed(2)}`;
      return `<path d="${pth}" transform="translate(0 2.5)" fill="none" stroke="${tone.neckShadow}" stroke-opacity="0.35" stroke-width="${w + 3}" stroke-linecap="round" filter="url(#${P}BlurS)"/>` +
        `<path d="${pth}" fill="none" stroke="${LASH}" stroke-width="${w}" stroke-linecap="round"/>`;
    };
    // Googly (Figma "Eyes · Googly"): a tilted eye with a dark rim (the white sits a little low in a
    // dark outer shape, cut to it here since Creator drops masks), a big black pupil and a soft glint.
    // The design's own paths, placed with its transforms (canvas px; the right eye is the mirror image).
    const GOOG_OUTER = 'M66.14,31.43 C66.14,47.34 52.75,57.59 33.99,57.59 C15.22,57.59 0,44.7 0,28.79 C0,12.89 15.22,0 33.99,0 C52.75,0 66.14,15.53 66.14,31.43 Z';
    const GOOG_WHITE = 'M61,28.99 C61,43.66 48.66,53.11 31.35,53.11 C14.03,53.11 0,41.22 0,26.56 C0,11.89 14.03,0 31.35,0 C48.66,0 61,14.33 61,28.99 Z';
    const googPlace = (dd, side, tx, ty) => {
      const co = 0.96198, si = 0.27311, a = side === 'L' ? co : -co;
      return dd.replace(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g, (_, x, y) => `${(tx + a * +x - (side === 'L' ? si : -si) * +y).toFixed(2)},${(ty + si * +x + co * +y).toFixed(2)}`);
    };
    // Raised 10.8px from the Figma frame so the eye centres line up with the other 3D eyes (y 207.9).
    const GOOG_DY = -10.8;
    const googAt = (side) => (side === 'L' ? { x: 152.74, y: 218.73 + GOOG_DY } : { x: 248.22, y: 218.73 + GOOG_DY });
    const GOOG = { rx: 33.07, ry: 28.79 };
    const googOuterD = (side) => googPlace(GOOG_OUTER, side, side === 'L' ? 128.79 : 272.17, 182 + GOOG_DY);
    const googOuter = (side) => samplePath(googOuterD(side), 2)[0];
    const googWhiteD = (side) => polyD(clipConvex(samplePath(googPlace(GOOG_WHITE, side, side === 'L' ? 130.36 : 270.6, 188.3 + GOOG_DY), 2)[0], googOuter(side)));
    const noLid = (side) => `<circle cx="${at(...eyeC[side]).x}" cy="${at(...eyeC[side]).y}" r="1" fill="#000000" fill-opacity="0"/>`;
    const eyeState = (side, state) => {
      const cy = eyeC[side][1];
      if (cfg.eyes === 'square') {
        // No lid while open (the crease sits above); blinks are skin cut to the eye's own shape.
        if (state === 'open') return noLid(side);
        const shape = sqEye(side, SQ_WHITE);
        const mid = 25.5 + 187.85;
        const x0 = sqX(side, 8), x1 = sqX(side, 69);
        if (state === 'half') {
          const white = samplePath(shape)[0];
          const span = spanAt(white, mid);
          return `<path d="${polyD(clipConvex(rectPoly(Math.min(x0, x1), mid - 30, Math.abs(x1 - x0), 30), white))}" fill="${SKIN}"/>` +
            (span ? `<path d="M${(span[0] + 1).toFixed(1)},${mid.toFixed(1)} L${(span[1] - 1).toFixed(1)},${mid.toFixed(1)}" fill="none" stroke="${LASH}" stroke-width="5.5" stroke-linecap="round"/>` : '');
        }
        const a = sqX(side, 16), b = sqX(side, 61), c = sqX(side, 38.7);
        if (state === 'closed') return lash(a, b, 27 + 187.85, 9);
        return happyLine(a, b, 30 + 187.85, -12);
      }
      if (boxEyes) {
        // Lids are skin cut to the eye's own rounded-square shape.
        const b = sqBox(side, 1);
        const line = (y) => `<path d="M${b.x + 2},${y} L${b.x + b.w - 2},${y}" fill="none" stroke="${LASH}" stroke-width="4.5" stroke-linecap="round"/>`;
        if (state === 'open') return noLid(side);
        if (state === 'half') return `<path d="${sqPath(b, b.y + b.h / 2)}" fill="${SKIN}"/>` + line(b.y + b.h / 2);
        const cx = b.x + b.w / 2;
        const hw = Math.min(20, b.w / 2 + 2); // the closed-eye line spans the eye
        const shut = `<path d="${sqPath(b)}" fill="${SKIN}"/>`;
        if (state === 'closed') return lash(cx - hw, cx + hw, b.y + b.h * 0.55, b.h * 0.17);
        return happyLine(cx - hw, cx + hw, b.y + b.h * 0.6, -b.h * 0.22);
      }
      // Googly eyes are wide open: no lid until they blink; the lid is skin cut to the tilted eye.
      // Sleepy is the same eye with a relaxed lid over its top, so a blink lowers that lid further.
      if (goog) {
        const g = googAt(side), eye = googOuter(side);
        // `soft`: the open Sleepy lid is drawn like Awake's (a soft shade under it, a light lid line);
        // blinks keep the bold lash line every shut eye uses.
        const lidTo = (edge, soft = false) => {
          const span = spanAt(eye, edge);
          const white = samplePath(googWhiteD(side), 2)[0];
          return (soft
            ? `<path d="${polyD(clipConvex(rectPoly(g.x - 40, edge, 80, 7), white))}" fill="${tone.neckShadow}" fill-opacity="0.25"/>`
            : `<path d="${polyD(clipConvex(rectPoly(g.x - 40, edge, 80, 9), white))}" fill="#3A1E16" fill-opacity="0.22" filter="url(#${P}BlurS)"/>`) +
            `<path d="${polyD(clipConvex(rectPoly(g.x - 40, g.y - 40, 80, edge - (g.y - 40)), eye))}" fill="url(#${P}Ball)"/>` +
            (span ? `<path d="M${(span[0] + 1).toFixed(1)},${edge.toFixed(1)} L${(span[1] - 1).toFixed(1)},${edge.toFixed(1)}" fill="none" stroke="${soft ? tone.lidLine : LASH}" stroke-width="${soft ? s(5) : 5.5}" stroke-linecap="round"/>` : '');
        };
        if (state === 'open') return drowsy ? lidTo(g.y - 13, true) : noLid(side); // a light, relaxed lid over the top third
        if (state === 'half') return lidTo(drowsy ? g.y + 8 : g.y);
        if (state === 'closed') return lash(g.x - GOOG.rx + 4, g.x + GOOG.rx - 4, g.y + 2, 10);
        return happyLine(g.x - GOOG.rx + 8, g.x + GOOG.rx - 8, g.y + 8, -16);
      }
      if (state === 'open') return lid(side, cy + openEdge);
      if (state === 'half') return lid(side, cy + 30, true);
      const c = at(...eyeC[side]), rx = s(EYE.rx);
      if (state === 'closed') return lash(c.x - rx + 6, c.x + rx - 6, c.y + 4, 12);
      return happyLine(c.x - rx + 10, c.x + rx - 10, c.y + 12, -18);
    };
    // Googly iris: a smaller coloured iris (dark brown unless a colour is picked) with a black pupil.
    // `clipped` cuts it to the eye white (previews and SVG). In Creator the unclipped iris is matted by
    // a copy of the white instead (a track matte), so it stays inside the white while it moves.
    const googIris = (side, clipped) => {
      const white = samplePath(googWhiteD(side), 2)[0];
      const mx = white.reduce((t, q) => t + q[0], 0) / white.length, my = white.reduce((t, q) => t + q[1], 0) / white.length;
      const ix = mx + (side === 'L' ? 3 : -3), iy = my + 2; // a touch toward the nose: looking at the viewer
      const col = same(cfg.irisColor, '#111111') ? '#4A2C1E' : cfg.irisColor;
      const f1 = (v) => v.toFixed(1);
      const shape = (rx, ry) => (clipped ? polyD(clipConvex(ellipsePoly(ix, iy, rx, ry, 48), white)) : polyD(ellipsePoly(ix, iy, rx, ry, 48)));
      return `<path d="${shape(22, 23)}" fill="${darken(col, 0.45)}"/><path d="${shape(19.8, 20.8)}" fill="${col}"/>` +
        `<path d="${shape(19.8, 20.8)}" fill="url(#${P}GoogIris)"/>` +
        `<ellipse cx="${f1(ix)}" cy="${f1(iy + 1)}" rx="9.6" ry="10.2" fill="#0B0807"/>` +
        `<ellipse cx="${f1(ix + 6.8)}" cy="${f1(iy - 7.9)}" rx="5.8" ry="4.9" fill="#FFFFFF" fill-opacity="0.9"/>` +
        `<circle cx="${f1(ix - 5.7)}" cy="${f1(iy + 7.9)}" r="2.1" fill="#FFFFFF" fill-opacity="0.7"/>`;
    };
    const irisBody = (side) => {
      const [cx, cy] = eyeC[side];
      if (cfg.eyes === 'dots') {
        const { x, y } = SQ[side];
        return `<ellipse cx="${x + SQ.w / 2}" cy="${y + SQ.h / 2}" rx="${SQ.w / 2}" ry="${SQ.h / 2}" fill="${same(cfg.irisColor, '#111111') ? '#111111' : cfg.irisColor}"/>` +
          `<ellipse cx="${x + 20}" cy="${y + 6}" rx="5" ry="4" fill="#FFFFFF" fill-opacity="0.7" filter="url(#${P}BlurS)"/>`;
      }
      if (cfg.eyes === 'square') {
        // The iris fills the eye and is clipped to it (the rig's small gaze moves keep it inside).
        const ix = sqX(side, 38.13), iy = 28.64 + 187.85;
        const irisD = polyD(clipConvex(ellipsePoly(ix, iy, 23.74, 25.5), samplePath(sqEye(side, SQ_WHITE))[0]));
        return `<path d="${irisD}" fill="${cfg.irisColor}"/><path d="${irisD}" fill="url(#${P}SqRim${side})" fill-opacity="0.4"/><path d="${irisD}" fill="url(#${P}SqPupil${side})" fill-opacity="0.64"/>` +
          `<ellipse cx="${sqX(side, 45.88).toFixed(2)}" cy="${(17.31 + 187.85).toFixed(2)}" rx="10.2" ry="8.5" fill="#FFFFFF" fill-opacity="0.7" filter="url(#${P}BlurS)"/>`;
      }
      if (goog) return googIris(side, true);
      // One gloss language for every 3D eye (as on Googly and Doll): a soft glint up toward the light
      // plus a small crisp catchlight below it.
      const gloss = (gx, gy) => ellipse(gx, gy, 7, 6, `fill="#FFFFFF" fill-opacity="0.75" filter="url(#${P}BlurS)"`) + ellipse(gx - 10, gy + 16, 2.6, 2.6, 'fill="#FFFFFF" fill-opacity="0.7"');
      if (same(cfg.irisColor, '#111111')) return ellipse(cx + 3, cy + 14, 20, 20, 'fill="#111111"') + gloss(cx + 8, cy + 6);
      return ellipse(cx + 3, cy + 12, 28, 28, `fill="${cfg.irisColor}"`) + ellipse(cx + 3, cy + 14, 14, 14, 'fill="#111111"') + gloss(cx + 10, cy + 2);
    };

    // ---- mouth
    const MX = 405;
    const MY = 684; // the mouth's line (canvas y ~308: a little below the Figma "Eyes · Square" rest mouth at 301)
    const LIP = cfg.lipColor;
    const MOUTH = same(LIP, '#B8645F') ? '#5E2A2C' : mix(LIP, '#2A0E10', 0.6);
    // Raised / bold / short come from the Figma "Theo — Front" variants: the whole mouth sits higher
    // (so every lip-sync shape moves with the rest mouth), bold and short draw a heavier line,
    // and short is about half as wide.
    // 30% bigger than the original design so lip sync reads on the big 3D head.
    const mk = (cfg.mouth === 'small' ? 0.75 : cfg.mouth === 'short' ? 0.6 : 1) * 1.3;
    // Through a beard the mouth gets a thin ring of skin around it, so every shape still reads against
    // the dark hair (on bare skin, deep tones included, the lips stand on their own: a light halo there
    // read as a pink glow).
    const halo = extras.has('beard');
    const haloC = tone.s[1];
    defs.push(`<linearGradient id="${P}MouthShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0.45"/><stop offset="0.5" stop-color="#000000" stop-opacity="0"/></linearGradient>`);
    const lineK = cfg.mouth === 'short' ? 0.8 : 1; // the short line is narrower still than its open shapes
    const mouthLift = { raised: -6.7, bold: -7.7, short: -12 }[cfg.mouth] || 0; // canvas px, from the default mouth line
    const heavy = cfg.mouth === 'bold' || cfg.mouth === 'short';
    const strokeM = (path, w = heavy ? 17.8 : 9) => (halo ? `<path d="${d(path)}" fill="none" stroke="${haloC}" stroke-opacity="0.7" stroke-width="${s(w + 9)}" stroke-linecap="round"/>` : '') +
      `<path d="${d(path)}" fill="none" stroke="${LIP}" stroke-width="${s(w)}" stroke-linecap="round"/>` +
      `<path d="${d(path)}" transform="translate(0 ${s(8)})" fill="none" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="${s(8)}" stroke-linecap="round" filter="url(#${P}BlurS)"/>`;
    const open = (w0, h0, { teeth = false } = {}) => {
      const w = w0 * mk, h = h0 * mk;
      const l = MX - w / 2, r = MX + w / 2;
      const path = `M${l},${MY} Q${MX},${MY - 6} ${r},${MY} C${r},${MY + h * 0.8} ${MX + w * 0.3},${MY + h} ${MX},${MY + h} C${MX - w * 0.3},${MY + h} ${l},${MY + h * 0.8} ${l},${MY} Z`;
      // The inside of the mouth darkens toward the top (under the upper lip), so it reads as depth.
      let out = (halo ? `<path d="${d(path)}" fill="none" stroke="${haloC}" stroke-opacity="0.7" stroke-width="${s(15)}" stroke-linejoin="round"/>` : '') +
        `<path d="${d(path)}" fill="${MOUTH}"/><path d="${d(path)}" fill="url(#${P}MouthShade)"/>`;
      if (h > 30) out += ellipse(MX, MY + h * 0.78, w * 0.28, h * 0.18, 'fill="#D9767A"');
      if (teeth) out += `<path d="${d(`M${l + 8},${MY} Q${MX},${MY - 4} ${r - 8},${MY} L${r - 12},${MY + h * 0.35} Q${MX},${MY + h * 0.42} ${l + 12},${MY + h * 0.35} Z`)}" fill="#FFFFFF"/>`;
      return out + `<path d="${d(path)}" fill="none" stroke="${LIP}" stroke-width="${s(6)}" stroke-linejoin="round"/>`;
    };
    const round = (rx, ry) => (halo ? ellipse(MX, MY + ry * mk - 6, rx * mk, ry * mk, `fill="none" stroke="${haloC}" stroke-opacity="0.7" stroke-width="${s(15)}"`) : '') +
      ellipse(MX, MY + ry * mk - 6, rx * mk, ry * mk, `fill="${MOUTH}" stroke="${LIP}" stroke-width="${s(6)}"`) +
      ellipse(MX, MY + ry * mk - 6 - ry * mk * 0.35, rx * mk * 0.8, ry * mk * 0.5, `fill="#000000" fill-opacity="0.22" filter="url(#${P}BlurS)"`);
    const wm = (v) => v * mk * lineK;
    const mouthArt = {
      // Every resting mouth is a smile line (the old flat line read as a frown): Smile is the full
      // curve, the others a gentler one at their own width and weight.
      REST: cfg.mouth === 'smile'
        ? strokeM(`M${MX - wm(72)},${MY - 6} Q${MX},${MY + 22} ${MX + wm(72)},${MY - 6}`)
        : strokeM(`M${MX - wm(74)},${MY - 4} Q${MX},${MY + 14} ${MX + wm(74)},${MY - 4}`),
      MBP: strokeM(`M${MX - wm(66)},${MY + 2} Q${MX},${MY - 2} ${MX + wm(66)},${MY + 2}`, 11),
      A: open(110, 90),
      E: open(130, 50),
      I: open(140, 34, { teeth: true }),
      O: round(40, 50),
      U: round(26, 30),
      FV: open(100, 28, { teeth: true }),
      SMILE: strokeM(`M${MX - wm(84)},${MY - 8} Q${MX},${MY + 30} ${MX + wm(84)},${MY - 8}`),
      LAUGH: open(134, 80), // short enough to stay inside the turned jaw
      FROWN: strokeM(`M${MX - wm(70)},${MY + 12} Q${MX},${MY - 18} ${MX + wm(70)},${MY + 12}`),
    };

    // ---- ears (+ earbuds / earrings)
    const pod = (side) => {
      const x = side === 'L' ? 122 : 690;
      const dir = side === 'L' ? 1 : -1;
      return `<path d="${d(`M${x - 12 * dir},${520} C${x - 20 * dir},${560} ${x - 14 * dir},${610} ${x - 4 * dir},${630} C${x + 6 * dir},${646} ${x + 26 * dir},${640} ${x + 24 * dir},${620} C${x + 22 * dir},${590} ${x + 22 * dir},${560} ${x + 26 * dir},${525} Z`)}" fill="url(#${P}Pod)"/>` +
        ellipse(x + 10 * dir, 522, 30, 22, `fill="url(#${P}Pod)"`) + ellipse(x + 2 * dir, 515, 10, 6, 'fill="#FFFFFF" fill-opacity="0.9"');
    };
    const ring = (side) => {
      const x = side === 'L' ? 108 : 710;
      return `<circle cx="${at(x, 640).x}" cy="${at(x, 640).y}" r="${s(22)}" fill="none" stroke="#E8B23A" stroke-width="${s(9)}"/>`;
    };
    const earArt = (side, { pods = true } = {}) => {
      const x = side === 'L' ? 108 : 710;
      const inner = side === 'L' ? 118 : 700;
      return ellipse(x, 528, 56, 96, `fill="url(#${P}Ball)"`) + ellipse(inner, 532, 30, 62, `fill="${tone.ear}" fill-opacity="0.6" filter="url(#${P}BlurM)"`) +
        (extras.has('earrings') ? ring(side) : '') + (pods && extras.has('earbuds') ? pod(side) : '');
    };

    // Front view: each ear sits ~17 px in against the head and tilts 12° (top out), as in the
    // Figma "Theo — Front" design; earrings move with it. The ¾ views use earArt as is.
    const frontEar = (side) => {
      const c = at(side === 'L' ? 108 : 710, 528);
      const dx = side === 'L' ? 17 : -17;
      const tilt = side === 'L' ? -12 : 12;
      // Earbuds stay put: moved in with the ear they'd tuck under the cheek; where they are, they sit in its bowl.
      return `<g transform="translate(${dx} 0) rotate(${tilt} ${c.x} ${c.y})">${earArt(side, { pods: false })}</g>` +
        (extras.has('earbuds') ? pod(side) : '');
    };

    // ---- outfit (body layer: neck + torso)
    // The neck is its own layer (rig role 'neck'): its base stays in the collar while
    // its top follows the chin, so it never comes apart from the head in any view.
    // It runs up under the jaw and down behind the collar, and is narrow enough to
    // stay hidden under the jaw of the ¾ and side drawings.
    // The neck runs down into the deep, relaxed neckline (Figma "after" body: neck to y 454).
    const femme = cfg.build === 'woman';
    const MID = at(408, 0).x;
    const neckArt = `<path d="${d('M300,690 L516,690 L522,1010 L294,1010 Z')}" fill="${SKIN}"/>` +
      `<path d="${d('M294,770 C346,822 470,822 522,770 L522,826 C470,858 346,858 294,826 Z')}" fill="${tone.neckShadow}" fill-opacity="0.35" filter="url(#${P}BlurL)"/>`;
    const neckBase = '';
    // Light layers under or on an outfit (shirt collars, turtlenecks, sleeves) and their ribbing.
    const INNER = '#F3F0EA';
    const INNER_SHADE = '#DCD6CC';
    // Two-colour outfits (jacket, cardigan, varsity, coat + scarf) have a secondary colour for their
    // second piece: the tee under the jacket, the turtleneck under the cardigan, the varsity's sleeves
    // and rib, and the scarf. Unset, each keeps its designed colour.
    const sec = cfg.outfitColor2 || OUTFIT_SECONDARY[cfg.outfit] || INNER;
    const secShade = darken(sec, 0.1);
    // The relaxed body from the Figma "after" frame (reference space): wide shoulders that slope gently
    // down and out (just past the canvas edges), a narrower collar and a deep, soft U neckline, so the
    // shoulders don't read as hunched.
    // Every outfit is drawn on this silhouette.
    const TORSO = 'M-44,1089 C-34,1009 167,898 288,882 C341,991 474,991 528,882 C649,898 850,1009 860,1089 L860,1164 L-44,1164 Z';
    const NECKLINE = 'M288,882 C341,991 474,991 528,882';
    const torso = `<path d="${d(TORSO)}" fill="url(#${P}Tee)"/>`;
    const sheen = `<path d="${d('M70,1060 C150,980 222,924 290,906')}" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="${s(26)}" stroke-linecap="round" filter="url(#${P}BlurM)"/>`;
    const neckRib = (w, color, dy = 0) => `<path d="${d(NECKLINE)}" fill="none" stroke="${color}" stroke-width="${s(w)}" stroke-linecap="round"${dy ? ` transform="translate(0 ${s(dy)})"` : ''}/>`;
    // A roll collar that also fills the deep neckline (turtleneck, and the layers under a cardigan / varsity).
    const ROLL = 'M306,800 L514,800 C538,824 550,904 540,992 C474,1014 346,1014 280,992 C270,904 282,824 306,800 Z';
    const rollRibs = (stroke, top = 812, bottom = 1000) => [330, 360, 390, 420, 450, 480].map((x) => `<path d="${d(`M${x},${top} C${x - 2},${(top + bottom) / 2 - 20} ${x - 2},${(top + bottom) / 2 + 20} ${x},${bottom}`)}" fill="none" stroke="${stroke}" stroke-opacity="0.45" stroke-width="${s(5)}" stroke-linecap="round"/>`).join('');
    // Figma-exported paths (canvas px, relative to the exported layer's top edge) placed on the canvas.
    // (Figma writes absolute commands, including H/V, which become plain lines here.)
    const fig = (dd, oy) => {
      const t = dd.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
      const n = { M: 2, L: 2, C: 6, Q: 4, S: 4, H: 1, V: 1, Z: 0 };
      const out = []; let cmd = 'M'; let x = 0, y = 0;
      const pt = (px, py) => { x = px; y = py; return `${(+px).toFixed(1)},${(+py + oy).toFixed(1)}`; };
      for (let i = 0; i < t.length;) {
        if (/[A-Za-z]/.test(t[i])) { cmd = t[i++]; if (cmd === 'Z') out.push('Z'); else if (cmd !== 'H' && cmd !== 'V') out.push(cmd); continue; }
        if (cmd === 'H') { out.push('L', pt(+t[i++], y)); continue; }
        if (cmd === 'V') { out.push('L', pt(x, +t[i++])); continue; }
        const a = t.slice(i, i + n[cmd]).map(Number); i += n[cmd];
        for (let k = 0; k < a.length; k += 2) out.push(pt(a[k], a[k + 1]));
      }
      return out.join(' ');
    };
    // The Figma outfit frames light every garment from above: a soft white glow centred near the top
    // of each piece (in place of the old diagonal shine), at 12%.
    defs.push(`<radialGradient id="${P}Glow" cx="0.48" cy="0.13" r="0.6"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`);
    const glow = (pd) => `<path d="${pd}" fill="url(#${P}Glow)" fill-opacity="0.12"/>`;
    let outfit;
    switch (cfg.outfit) {
      case 'hoodie': {
        // From the Figma "Outfit · Hoodie" frame: the hood's two sides behind the neck and its front
        // wrapped round the neck, over the body, with a deep neckline band and loose drawstrings.
        const Y = 364.602;
        const piece = (dd, fill) => { const pd = fig(dd, Y); return `<path d="${pd}" fill="${fill}"/>` + glow(pd); };
        outfit = neckBase +
          piece('M149.82 35.30C140.32 37.23 131.16 39.80 122.6 43.09C122.6 22.39 133.66 8.71 150.47 0.57L149.82 35.30Z', darken(oc, 0.2)) +
          piece('M250.11 0C267.6 8.06 279.2 21.90 279.2 43.09C270.27 39.66 260.7 37.02 250.76 35.06L250.11 0Z', darken(oc, 0.2)) +
          piece('M-3.39 125.49C1.10 89.49 91.50 39.49 146 32.29C169.8 81.29 229.7 81.29 254 32.29C308.4 39.49 398.9 89.49 403.4 125.49V159.19H-3.39V125.49Z', `url(#${P}Tee)`) +
          piece('M170.5 85.39C143.3 76.99 127.5 50.23 123 37.89L149 30.39C156.16 41.56 176.6 64.09 201 64.89C225.4 65.69 244.16 42.23 250.5 30.39L278 37.89C274.8 56.69 248.66 77.39 236 85.39C225.5 88.89 197.7 93.79 170.5 85.39Z', darken(oc, 0.2)) +
          `<path d="${fig('M146 32.29C169.8 81.29 229.7 81.29 254 32.29', Y)}" fill="none" stroke="${darken(oc, 0.35)}" stroke-width="8.1" stroke-linecap="round"/>` +
          `<path d="${fig('M183.21 75.39C177.92 94.55 175.60 119.22 177.85 152.39M218.93 75.39C218.93 112.54 230.33 133.48 218.93 152.39', Y)}" fill="none" stroke="${lighten(oc, 0.65)}" stroke-width="3.6" stroke-linecap="round"/>`;
        break;
      }
      case 'collar': {
        // From the Figma "Outfit · Shirt" frame: soft rounded collar points with a faint top-lit
        // shade, and two buttons down the placket.
        const Y = 395;
        const point = (dd) => { const pd = fig(dd, Y); return `<path d="${pd}" fill="${lighten(oc, 0.18)}"/><path d="${pd}" fill="url(#${P}Lapel)" fill-opacity="0.2"/>`; };
        defs.push(`<linearGradient id="${P}Lapel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#000000"/></linearGradient>`);
        const body = fig('M-3.39 95.1C1.10 59.1 91.50 9.10 146 1.90C169.8 50.9 229.7 50.9 254 1.90C308.4 9.10 398.9 59.1 403.4 95.1V128.8H-3.39V95.1Z', Y);
        outfit = neckBase + `<path d="${body}" fill="url(#${P}Tee)"/>` + glow(body) +
          point('M149 0.31C149 0.31 154.51 16.88 164.4 25.31C176.38 35.54 195 38.81 195 38.81C182.57 48.99 176.63 56.60 171.68 68.64C170.17 72.31 165.28 73.15 162.95 69.94C158.08 63.23 151.21 53.13 147.5 44.81C140.76 29.71 137 3.81 137 3.81C137 3.81 140.05 1.02 142.5 0.31C144.93 -0.39 149 0.31 149 0.31Z') +
          point('M250.5 0.50C250.5 0.50 244.98 17.06 235.1 25.5C223.11 35.72 204.5 39 204.5 39C216.92 49.18 222.86 56.79 227.81 68.83C229.32 72.50 234.21 73.34 236.55 70.13C241.42 63.42 248.28 53.32 252 45C258.73 29.90 262.5 4.00 262.5 4.00C262.5 4.00 259.44 1.21 257 0.50C254.56 -0.20 250.5 0.50 250.5 0.50Z') +
          [75.9, 108.4].map((cy) => `<circle cx="201.8" cy="${(cy + Y).toFixed(1)}" r="6" fill="${lighten(oc, 0.5)}"/>`).join('');
        break;
      }
      case 'shirtSweater': // a removed option: characters saved with it get the plain sweater
      case 'sweater': {
        // From the Figma "Outfit · Sweater" frame: a plain crew neck, lit from above, with a knit hem line.
        const Y = 396.9;
        const body = fig('M-3.39 93.2C1.10 57.2 91.50 7.2 146 0C169.8 49 229.7 49 254 0C308.4 7.2 398.9 57.2 403.4 93.2V126.9H-3.39V93.2Z', Y);
        outfit = neckBase + `<path d="${body}" fill="url(#${P}Tee)"/>` + glow(body) +
          `<path d="${fig('M83.90 98.1C119.9 90 160.4 86.4 200.9 86.4C241.4 86.4 281.9 90 317.9 98.1', Y)}" fill="none" stroke="${darken(oc, 0.12)}" stroke-opacity="0.6" stroke-width="2.7"/>`;
        break;
      }
      case 'turtleneck': {
        // From the Figma "Outfit · Turtleneck" frame: a roll collar shaded dark to light, three soft
        // curved ribs fading downward, and a glow round its edge.
        const Y = 358.775;
        const roll = fig('M154.271 1.22522H247.729C258.512 10.549 263.904 28.6281 259.411 62.8151C247.729 94.2252 150.1 91.7252 142.589 62.8151C138.096 28.6281 143.488 10.549 154.271 1.22522Z', Y);
        const body = fig('M-3.39 131.32C1.10 95.32 91.50 45.32 146 38.12C169.8 87.12 229.7 87.12 254 38.12C308.4 45.32 398.9 95.32 403.4 131.32V165.02H-3.39V131.32Z', Y);
        // The roll is lit at its edges (a glow that's clear in the middle).
        defs.push(`<radialGradient id="${P}RollEdge" cx="0.48" cy="0.13" r="1.15"><stop offset="0.32" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="#FFFFFF"/></radialGradient>`);
        defs.push(`<linearGradient id="${P}Roll" gradientUnits="userSpaceOnUse" x1="201" y1="${(1.2 + Y).toFixed(1)}" x2="201" y2="${(85.4 + Y).toFixed(1)}"><stop offset="0" stop-color="${darken(oc, 0.35)}"/><stop offset="1" stop-color="${darken(oc, 0.16)}"/></linearGradient>`,
          `<linearGradient id="${P}Rib" gradientUnits="userSpaceOnUse" x1="0" y1="${(6.2 + Y).toFixed(1)}" x2="0" y2="${(79.2 + Y).toFixed(1)}"><stop offset="0" stop-color="${lighten(oc, 0.75)}"/><stop offset="1" stop-color="${lighten(oc, 0.75)}" stop-opacity="0"/></linearGradient>`);
        outfit = neckBase +
          `<path d="${body}" fill="url(#${P}Tee)"/>` + glow(body) +
          `<path d="${roll}" fill="url(#${P}Roll)"/><path d="${roll}" fill="url(#${P}RollEdge)" fill-opacity="0.12"/>` +
          ['M166.479 6.22522C160.919 36.1546 160.949 51.6853 166.479 79.2252', 'M201 6.22522C201 34.9593 201 50.4912 201 79.2252', 'M231.9 6.22522C237.46 36.1546 237.43 51.6853 231.9 79.2252']
            .map((r) => `<path d="${fig(r, Y)}" fill="none" stroke="url(#${P}Rib)" stroke-opacity="0.45" stroke-width="2.25" stroke-linecap="round" filter="url(#${P}BlurS)"/>`).join('');
        break;
      }
      case 'cardigan': {
        // From the Figma "Outfit · Cardigan" frame: a light ribbed turtleneck (shaded toward its edges)
        // under a cardigan whose fronts curve down to a low V.
        const Y = 359.175;
        const innerD = fig('M151.5 0.824951H250.5C255 25.325 263 49.825 263 87.2249V164.625H138.8L142.4 87.2249C142.4 33.325 146 27.325 151.5 0.824951Z', Y);
        // Each front is lit from its own upper inside corner.
        defs.push(...['L', 'R'].map((k) => `<radialGradient id="${P}Glow${k}" cx="${k === 'L' ? 0.52 : 0.48}" cy="0.13" r="0.6"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`));
        defs.push(`<radialGradient id="${P}Vig" cx="0.5" cy="0.16" r="0.84"><stop offset="0.38" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000"/></radialGradient>`,
          `<linearGradient id="${P}RibIn" gradientUnits="userSpaceOnUse" x1="0" y1="${(6.2 + Y).toFixed(1)}" x2="0" y2="${(164.6 + Y).toFixed(1)}"><stop offset="0" stop-color="${darken(sec, 0.18)}"/><stop offset="1" stop-color="${darken(sec, 0.18)}" stop-opacity="0"/></linearGradient>`);
        outfit = neckBase +
          `<path d="${innerD}" fill="${sec}"/><path d="${innerD}" fill="url(#${P}Vig)" fill-opacity="0.32"/>` +
          [164.9, 199, 233].map((x) => `<path d="${fig(`M${x} 6.22498V164.625`, Y)}" fill="none" stroke="url(#${P}RibIn)" stroke-opacity="0.45" stroke-width="2.25" stroke-linecap="round" filter="url(#${P}BlurS)"/>`).join('') +
          [fig('M-1.49 131.12C3.00 95.12 87.49 44.72 141.9 37.52C161.5 96.82 201 140.52 201 140.52V164.82H-1.49V131.12Z', Y),
            fig('M403.4 130.92C398.9 94.92 314.4 44.52 260 37.32C240.4 96.62 200.9 140.32 200.9 140.32V164.62H403.4V130.92Z', Y)]
            .map((pd, i) => `<path d="${pd}" fill="url(#${P}Tee)"/><path d="${pd}" fill="url(#${P}Glow${i ? 'R' : 'L'})" fill-opacity="0.12"/>`).join('');
        break;
      }
      case 'jacket': {
        // From the Figma "Outfit · Jacket" frame: matching rounded, softly shaded collar points standing
        // up round the neck over a tee, and a chest pocket with one button.
        const Y = 385;
        const lapelL = fig('M149.276 0.354624C156 18 176.5 57.5 176.5 57.5C176.5 57.5 159.332 72.7347 155.918 86.2916C154.877 90.4269 151.506 91.3725 149.897 87.7541C146.538 80.1989 141.8 68.8265 139.241 59.4586C134.599 42.4624 136 13.5 136 13.5C136 13.5 143.107 1.15488 144.793 0.354624C146.474 -0.44328 149.276 0.354624 149.276 0.354624Z', Y);
        const lapelR = fig('M250.875 0.354624C244.151 18 223.651 57.5 223.651 57.5C223.651 57.5 240.819 72.7347 244.233 86.2916C245.274 90.4269 248.645 91.3725 250.254 87.7541C253.613 80.1989 258.351 68.8265 260.91 59.4586C265.552 42.4624 264.151 13.5 264.151 13.5C264.151 13.5 257.044 1.15488 255.358 0.354624C253.677 -0.44328 250.875 0.354624 250.875 0.354624Z', Y);
        defs.push(`<linearGradient id="${P}Lapel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#000000"/></linearGradient>`);
        outfit = neckBase +
          `<path d="${fig('M-3.3999 105.1C1.1001 69.0999 91.5001 19.0999 146 11.8999C168.5 60 225.5 70 254 11.8999C308.4 19.0999 398.9 69.0999 403.4 105.1V138.8H-3.3999V105.1Z', Y)}" fill="url(#${P}Tee)"/>` +
          `<path d="${fig('M47.8999 91.9999C83.8999 55.9999 116.3 30.8 146.9 22.7', Y)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="11.7" stroke-linecap="round" filter="url(#${P}BlurM)"/>` +
          `<path d="${fig('M149.5 11.5L162.5 44.5L176.5 57.5L202.5 100.5L224 57.5L250.5 16.5C226 46.5 176.5 57.5 149.5 11.5Z', Y)}" fill="${sec}"/>` +
          [lapelL, lapelR].map((l) => `<path d="${l}" fill="${lighten(oc, 0.18)}"/><path d="${l}" fill="url(#${P}Lapel)" fill-opacity="0.2"/>`).join('') +
          `<path d="${fig('M263 101H318.8V138.8H263V101Z', Y)}" fill="none" stroke="${darken(oc, 0.2)}" stroke-width="2.25" stroke-linejoin="round"/>` +
          `<path d="${fig('M261.2 101H320.6L317 114.5H264.8L261.2 101Z', Y)}" fill="${darken(oc, 0.06)}" stroke="${darken(oc, 0.2)}" stroke-width="1.8" stroke-linejoin="round"/>` +
          `<circle cx="290.9" cy="${(109.1 + Y).toFixed(1)}" r="4.05" fill="${darken(oc, 0.45)}"/>`;
        break;
      }
      case 'varsity': {
        // From the Figma "Outfit · Varsity" frame: light sleeves and a ribbed white turtleneck, with a
        // soft U-shaped trim at the neck that fades as it dips, and one snap below it.
        const Y = 361;
        defs.push(`<linearGradient id="${P}Trim" gradientUnits="userSpaceOnUse" x1="0" y1="${36 + Y}" x2="0" y2="${121 + Y}"><stop offset="0" stop-color="${sec}"/><stop offset="1" stop-color="${sec}" stop-opacity="0.32"/></linearGradient>`);
        outfit = neckBase +
          `<path d="${fig('M150 0L250 2L256.871 85H145.129L150 0Z', Y)}" fill="${sec}"/>` +
          [169.4, 187.4, 205.4, 223.4].map((x) => `<path d="${fig(`M${x} 9.80005V81.8`, Y)}" fill="none" stroke="${secShade}" stroke-width="1.8"/>`).join('') +
          (() => { const pd = fig('M-3.3999 129.1C1.1001 93.1 91.5001 43.1 146 35.9C169.8 84.9 229.7 84.9 254 35.9C308.4 43.1 398.9 93.1 403.4 129.1V162.8H-3.3999V129.1Z', Y); return `<path d="${pd}" fill="url(#${P}Tee)"/>` + glow(pd); })() +
          `<path d="${fig('M-4.3999 132.1C0.100098 96.1001 68.5001 58.7001 108.1 45.2001L95.5001 165.8H-4.3999V132.1Z', Y)}" fill="${sec}"/>` +
          `<path d="${fig('M404.4 130.1C399.9 94.1001 332.1 59.5 292.5 46L304.5 163.8H404.4V130.1Z', Y)}" fill="${sec}"/>` +
          `<path d="${fig('M47.8999 116C83.8999 80.0001 116.3 54.8001 146.9 46.7001', Y)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="11.7" stroke-linecap="round" filter="url(#${P}BlurM)"/>` +
          `<path d="${fig('M147 36C147 36 162.85 122.012 201.497 120.991C239.513 119.987 253 36 253 36', Y)}" fill="none" stroke="url(#${P}Trim)" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>` +
          `<circle cx="200.9" cy="${129.5 + Y}" r="5.4" fill="${sec}"/>`;
        break;
      }
      case 'scarf': {
        // From the Figma "Outfit · Coat + scarf" frame: the coat's collar ends peeking out behind a
        // soft knitted wrap, with two tails crossing down the front; each piece has a faint sheen.
        const sc = sec; // the secondary colour (teal unless picked)
        const Y = 373;
        defs.push(`<radialGradient id="${P}Knit" cx="0.5" cy="0.27" r="0.9"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.16"/><stop offset="0.33" stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF"/></radialGradient>`,
          `<radialGradient id="${P}KnitIn" cx="0.5" cy="0.3" r="0.9"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.42" stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.16"/></radialGradient>`);
        const knit = (dd, g = 'Knit') => { const pd = fig(dd, Y); return `<path d="${pd}" fill="${sc}"/><path d="${pd}" fill="url(#${P}${g})" fill-opacity="0.2"/>`; };
        outfit = neckBase +
          knit('M149.296 19.6577C139.77 20.7354 130.583 22.1664 122 24C122 12.4726 133.095 4.85279 149.949 0.318129L149.296 19.6577Z') +
          knit('M249.837 0C267.371 4.4927 279 12.1981 279 24C270.055 22.089 260.453 20.6161 250.496 19.5239L249.837 0Z') +
          (() => { const pd = fig('M-3.39 117.1C1.10 81.09 91.50 31.09 146 23.89C169.8 72.89 229.7 72.89 254 23.89C308.4 31.09 398.9 81.09 403.4 117.1V150.8H-3.39V117.1Z', Y); return `<path d="${pd}" fill="url(#${P}Tee)"/>` + glow(pd); })() +
          knit('M202.517 72.1152C227.757 98.7861 247.72 139.125 260.335 209.226L312.443 201.983C297.795 137.913 275.873 83.4754 247.032 51.5565L202.517 72.1152Z') +
          knit('M186.313 54.4936C199.395 94.0707 196.334 143.062 185.109 190.36L231.373 199.952C243.959 152.935 241.907 94.3773 222.303 52.0303L186.313 54.4936Z', 'KnitIn') +
          knit('M122 28.9227C122 1.49868 166.328 25.295 202.333 25.3099C238.248 25.3248 277.725 -0.143591 281.581 28.9227C287.148 70.88 235.986 74 202.333 74C168.68 74 122 72.5221 122 28.9227Z');
        break;
      }
      default: // tee (Theo)
        outfit = neckBase + torso + glow(d(TORSO)) + neckRib(10, outfitTones.line);
    }

    // ---- face (skin, inner shadow, sheen; brim/fringe shadow; blush and freckles)
    const covered = cfg.hair !== 'none';
    // A hijab drapes over the shoulders in front of the outfit (part of the body layer, so it turns
    // and moves with the torso), its top tucked under the wrap around the face.
    if (flatStyle === 'hijab') {
      defs.push(`<linearGradient id="${P}Drape" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${darken(hc, 0.2)}"/><stop offset="1" stop-color="${darken(hc, 0.32)}"/></linearGradient>`);
      outfit += `<path d="M84,392 C112,360 156,346 200,346 C244,346 288,360 316,392 C330,414 326,450 306,472 C276,496 240,504 200,504 C160,504 124,496 94,472 C74,450 70,414 84,392 Z" fill="url(#${P}Drape)"/>` +
        glow('M84,392 C112,360 156,346 200,346 C244,346 288,360 316,392 C330,414 326,450 306,472 C276,496 240,504 200,504 C160,504 124,496 94,472 C74,450 70,414 84,392 Z');
    }
    const cheeks = (extras.has('blush') ? ellipse(268, 568, 70, 40, `fill="#FF7A8A" fill-opacity="0.35" filter="url(#${P}BlurM)"`) + ellipse(548, 568, 70, 40, `fill="#FF7A8A" fill-opacity="0.35" filter="url(#${P}BlurM)"`) : '') +
      (extras.has('freckles') ? [[250, 588], [282, 604], [262, 626], [300, 586], [566, 588], [534, 604], [554, 626], [516, 586]].map(([x, y]) => `<circle cx="${at(x, y).x}" cy="${at(x, y).y}" r="${s(6)}" fill="${tone.nose}" fill-opacity="0.55"/>`).join('') : '');
    // Face shading as gradient fills of the outline itself (Creator drops SVG masks, so nothing can
    // be clipped to the face): a soft inner rim, darker toward the top and the right; the shade under
    // the brim or fringe; and the cheek sheen (a soft spot well inside the face).
    const brimOp = cfg.hair === 'cap' ? 0.35 : 0.25;
    defs.push(`<radialGradient id="${P}FaceRim" cx="0.46" cy="0.56" r="0.6"><stop offset="0.72" stop-color="${tone.rim}" stop-opacity="0"/><stop offset="1" stop-color="${tone.rim}" stop-opacity="0.45"/></radialGradient>`,
      `<linearGradient id="${P}BrimShade" gradientUnits="userSpaceOnUse" x1="0" y1="124" x2="0" y2="198"><stop offset="0" stop-color="${tone.brim}" stop-opacity="0"/><stop offset="0.45" stop-color="${tone.brim}" stop-opacity="${brimOp}"/><stop offset="1" stop-color="${tone.brim}" stop-opacity="0"/></linearGradient>`);
    const faceShade = (outline) => `<path d="${outline}" fill="url(#${P}FaceRim)"/>` + (covered ? `<path d="${outline}" fill="url(#${P}BrimShade)"/>` : '');
    const faceBody = `<path d="${d(HEAD)}" fill="${SKIN}"/>` + faceShade(d(HEAD)) +
      ellipse(330, 410, 130, 70, `fill="#FFFFFF" fill-opacity="0.22" filter="url(#${P}BlurL)"`) + cheeks;

    const parts = [
      // Feminine: narrower, softer shoulders and a slimmer neck (both narrowed about the centre line).
      { id: 'neck', name: 'Neck', role: 'neck', group: 'body', allViews: true, body: femme ? `<g transform="translate(${MID} 0) scale(0.86 1) translate(${-MID} 0)">${neckArt}</g>` : neckArt },
      { id: 'body', name: 'Body', role: 'static', group: 'body', depth: 0, body: femme ? `<g transform="translate(${MID} 0) scale(0.84 1) translate(${-MID} 0)">${outfit}</g>` : outfit },
      // Depth 0: the ears ride the face as it turns and nods, so they stay against the head
      // (a negative depth slid them the other way and opened a gap).
      // Under a hijab the ears are hidden (the layer stays, drawing nothing).
      { id: 'ears', name: 'Ears', role: 'static', group: 'head', depth: 0, body: hideEars ? '<circle cx="200" cy="237" r="1" fill="#000000" fill-opacity="0"/>' : frontEar('L') + frontEar('R') },
      { id: 'face', name: 'Face', role: 'static', group: 'head', depth: 0, squash: true, body: faceBody },
    ];
    // Long hair hangs behind the head and shoulders.
    const LONG_BACK = 'M128,430 C104,220 250,128 408,126 C566,128 712,220 688,430 C696,600 712,760 728,900 C660,930 600,920 560,880 C556,780 552,700 548,640 L268,640 C264,700 260,780 256,880 C216,920 156,930 88,900 C104,760 120,600 128,430 Z';
    if (cfg.hair === 'long') {
      parts.unshift({ id: 'hair-back', name: 'Hair Back', role: 'static', group: 'head', depth: -0.45, squash: true, body: `<path d="${d(LONG_BACK)}" fill="${HAIR}"/>` });
    }
    if (flatHair && flatHair.back) {
      parts.unshift({ id: 'hair-back', name: 'Hair Back', role: 'static', group: 'head', depth: -0.45, squash: true, body: onHead(flatHair.back) });
    }
    // Chin-length styles have hair behind the head too: a rounded bob, or a cloud of curls.
    const BOB_BACK = 'M100,430 C88,220 246,104 408,102 C570,104 728,220 716,430 C722,560 712,676 664,744 C640,772 600,780 560,770 L256,770 C216,780 176,772 152,744 C104,676 94,560 100,430 Z';
    if (cfg.hair === 'bob') {
      parts.unshift({ id: 'hair-back', name: 'Hair Back', role: 'static', group: 'head', depth: -0.45, squash: true, body: `<path d="${d(BOB_BACK)}" fill="${HAIR}"/>` });
    }
    if (cfg.hair === 'curlyBob') {
      const ring = [];
      for (let i = 0; i < 15; i++) {
        const a = ((150 + (240 * i) / 14) * Math.PI) / 180;
        ring.push(ellipse(408 + 300 * Math.cos(a), 430 + 330 * Math.sin(a) * (Math.sin(a) > 0 ? 0.92 : 1), 74, 70, `fill="${i % 2 ? HAIR : hairTones[1]}"`));
      }
      parts.unshift({ id: 'hair-back', name: 'Hair Back', role: 'static', group: 'head', depth: -0.45, squash: true,
        body: `<path d="${d('M118,440 C100,230 250,110 408,108 C566,110 716,230 698,440 C706,560 690,680 640,740 L176,740 C126,680 110,560 118,440 Z')}" fill="${HAIR}"/>` + ring.join('') });
    }
    for (const side of ['L', 'R']) {
      const [cx, cy] = eyeC[side];
      parts.push({
        id: `eye-white-${side}`, name: `Eye White ${side}`, role: 'eyeWhite', side, group: 'head', depth: 0.7,
        body: cfg.eyes === 'dots'
          ? `<circle cx="${SQ[side].x + SQ.w / 2}" cy="${SQ[side].y + SQ.h / 2}" r="1" fill="#000000" fill-opacity="0"/>` // no white
          : cfg.eyes === 'square'
          ? `<path d="${sqEye(side, SQ_CREASE)}" fill="none" stroke="${tone.brow}" stroke-opacity="0.55" stroke-width="6.3" stroke-linecap="round" filter="url(#${P}BlurS)"/>` +
            `<path d="${sqEye(side, SQ_SHADOW)}" fill="${tone.eyeShadow}" fill-opacity="0.4" filter="url(#${P}BlurM)"/><path d="${sqEye(side, SQ_WHITE)}" fill="url(#${P}White)"/>`
          : goog
          ? (() => {
            const sh = side === 'L' ? 153.89 : 247.07;
            return `<ellipse cx="${sh}" cy="${(219.84 + GOOG_DY).toFixed(2)}" rx="35.68" ry="33.14" fill="#A9625E" fill-opacity="0.4" filter="url(#${P}BlurM)"/>` +
              `<path d="${googOuterD(side)}" fill="#111111"/><path d="${googWhiteD(side)}" fill="url(#${P}GoogWhite)"/>`;
          })()
          : ellipse(cx, cy + 10, EYE.rx + 4, EYE.ry + 2, `fill="${tone.eyeShadow}" fill-opacity="0.4" filter="url(#${P}BlurM)"`) + ellipse(cx, cy, EYE.rx, EYE.ry, `fill="url(#${P}White)"`),
      });
      parts.push({ id: `iris-${side}`, name: `Iris ${side}`, role: 'iris', side, group: 'head', depth: 0.7, body: irisBody(side),
        ...(goog ? { matte: { body: `<path d="${googWhiteD(side)}" fill="#FFFFFF"/>`, target: googIris(side, false) } } : {}) });
      for (const state of EYE_STATES) parts.push({ id: `eye-${side}-${state}`, name: `Eye ${side}${stateName(state)}`, role: 'eye', side, state, group: 'head', depth: 0.7, body: eyeState(side, state) });
    }
    const browY = cfg.eyes === 'sleepy' ? 0 : -18;
    // Bold and thick brows are hair: the hair colour (darkened), or a dark default when the hair is
    // hidden under headwear with no colour of its own (or there's no hair).
    const browInk = (fallback) => (cfg.hatColor ? darken(cfg.hairColor, 0.28) : cfg.hair === 'none' || headwear ? fallback : darken(cfg.hairColor, 0.28));
    for (const side of ['L', 'R']) {
      const [cx, cy] = eyeC[side];
      const path = d(`M${cx - 70},${cy - 92 + browY} Q${cx},${cy - 112 + browY} ${cx + 70},${cy - 92 + browY}`);
      // Thick: heavy dark-brown brows (Figma "Theo — Front" variant), in canvas px.
      const thick = side === 'L' ? 'M134,162.9 C153.2,154.9 170.7,157.4 170.7,157.4' : 'M262.7,162.9 C243.5,154.9 226,157.4 226,157.4';
      // Short: little rounded dabs set low, just over the inner half of each eye, tilting down toward the nose.
      const dab = side === 'L' ? 'M144,166 L165,172' : 'M253.4,166 L232.4,172';
      const body = cfg.brows === 'short'
        ? `<path d="${dab}" fill="none" stroke="${browInk('#3A2219')}" stroke-width="15" stroke-linecap="round"/>`
        : cfg.brows === 'thick'
        ? `<path d="${thick}" fill="none" stroke="${browInk('#50241F')}" stroke-width="20" stroke-linecap="round"/>`
        : cfg.brows === 'bold'
        ? `<path d="${path}" fill="none" stroke="${browInk(darken(tone.s[2], 0.45))}" stroke-width="${s(18)}" stroke-linecap="round"/>`
        : `<path d="${path}" fill="none" stroke="${tone.brow}" stroke-opacity="0.55" stroke-width="${s(14)}" stroke-linecap="round" filter="url(#${P}BlurS)"/>`;
      if (cfg.brows !== 'none') parts.push({ id: `brow-${side}`, name: `Brow ${side}`, role: 'brow', side, group: 'head', depth: 0.75, body });
    }
    const nk = { ball: 1, small: 0.72, tiny: 0.48 }[cfg.nose] ?? 1;
    const nz = (x, y, rx, ry, attrs) => ellipse(405 + (x - 405) * nk, 575 + (y - 575) * nk, rx * nk, ry * nk, attrs);
    // Button and tall noses come from the Figma "Theo — Front" variants (canvas px); none keeps an
    // empty nose layer so the rig and editor still have one.
    const NOSES = {
      button: `<ellipse cx="196.9" cy="265.4" rx="27.9" ry="23.4" fill="${tone.nose}" fill-opacity="0.35" filter="url(#${P}BlurM)"/>` +
        `<rect x="173" y="237" width="52" height="35" rx="11" fill="url(#${P}Ball)"/>` +
        `<ellipse cx="190.1" cy="248.4" rx="9" ry="6.3" fill="#FFFFFF" fill-opacity="0.35" filter="url(#${P}BlurS)"/>`,
      tall: `<circle cx="200.5" cy="262.5" r="22.5" fill="${tone.nose}" fill-opacity="0.28" filter="url(#${P}BlurM)"/>` +
        `<path d="M179.2,244.6 C181.1,237.9 183.8,231.4 187.3,225.4 L189,222.4 C193.2,215.1 203.8,215.1 208,222.4 L209.7,225.4 C213.2,231.4 215.9,237.9 217.8,244.6 L221.2,257.1 C223.1,264.1 217.8,271 210.6,271 L186.4,271 C179.2,271 173.9,264.1 175.8,257.1 Z" fill="url(#${P}Ball)"/>` +
        `<ellipse cx="194.1" cy="237.6" rx="5" ry="9.3" transform="rotate(12 194.1 237.6)" fill="#FFFFFF" fill-opacity="0.35" filter="url(#${P}BlurS)"/>`,
      none: `<circle cx="198.7" cy="258.8" r="1" fill="#000000" fill-opacity="0"/>`,
    };
    parts.push({
      id: 'nose', name: 'Nose', role: 'static', group: 'head', depth: 1,
      body: NOSES[cfg.nose] || nz(410, 598, 62, 52, `fill="${tone.nose}" fill-opacity="0.35" filter="url(#${P}BlurM)"`) + nz(405, 575, 64, 62, `fill="url(#${P}Ball)"`) + nz(386, 552, 20, 14, `fill="#FFFFFF" fill-opacity="0.35" filter="url(#${P}BlurS)"`),
    });
    // Beard and mustache (from the Flat character's extras), in the hair colour; with a hat or no hair
    // they take a dark brown. The beard is drawn past the face and clipped to the head outline, so it
    // follows this face's jaw in every view: sideburns down from the ears, round the jaw and chin, with
    // its top edge framing the mouth (the mouth draws over it). The mustache sits under the nose.
    // Beard and mustache always take the hair colour (bald too). Only an old save with headwear and no
    // headwear colour of its own, where the hair colour is really the hat's, falls back to dark brown.
    const beardC = headwear && !cfg.hatColor ? '#3B2418' : cfg.hairColor;
    const BEARD = 'M40,226 L97,226 C100,262 122,290 150,300 C166,292 184,290 200.9,292 C218,290 236,292 252,300 C280,290 301,262 304,226 L362,226 L362,440 L40,440 Z';
    defs.push(`<linearGradient id="${P}Beard" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lighten(beardC, 0.1)}"/><stop offset="1" stop-color="${darken(beardC, 0.2)}"/></linearGradient>`);
    const beardArt = (path) => `<path d="${path}" fill="url(#${P}Beard)"/>` +
      `<ellipse cx="200.9" cy="352" rx="62" ry="16" fill="#FFFFFF" fill-opacity="0.1" filter="url(#${P}BlurL)"/>`;
    // The beard is cut to the head grown ~8 px all round, with a fuller, rounded bottom under the chin,
    // so it wraps past the jaw line (no skin edge showing round it). Clipped here, not masked: Creator
    // drops SVG masks.
    const beardClip = (head, chin, c = { x: 200.9, y: 234 }) => {
      const grown = samplePath(head)[0].map(([x, y]) => [c.x + (x - c.x) * (1 + 8 / 116), c.y + (y - c.y) * (1 + 8 / 140)]);
      return hull([...grown, ...samplePath(chin)[0]]);
    };
    const beardOf = (path, head, chin, c) => beardArt(clipD(path, beardClip(head, chin, c)));
    if (extras.has('beard')) {
      const chinF = oval ? 'M92,289 C102,352 148,398 200.9,400 C254,398 300,352 310,289 Z' : 'M90,290 C100,352 146,394 200.9,396 C256,394 302,352 312,290 Z';
      parts.push({ id: 'beard', name: 'Beard', role: 'static', group: 'head', depth: 0.45, body: beardOf(BEARD, d(HEAD), chinF) });
    }
    for (const key of MOUTH_KEYS) {
      const body = mouthLift ? `<g transform="translate(0 ${mouthLift})">${mouthArt[key]}</g>` : mouthArt[key];
      parts.push({ id: `mouth-${key}`, name: mouthName(key), role: 'mouth', key, group: 'head', depth: 0.6, body });
    }
    // A fuller, more natural mustache: thickest under the nose with a small dip at the philtrum,
    // following the upper lip and tapering down past the mouth corners. Shaded like the beard (light
    // top, darker lower edge) with a soft contact shadow on the lip, a sheen along the top and a few
    // fine strands combed outward. It sits over the mouth, so open shapes tuck under it.
    const MCX = at(MX, 0).x;
    const mst = (pts) => pts.map(([x, y]) => `${(MCX + x).toFixed(1)},${y}`).join(' ');
    const MUSTACHE = `M${mst([[0, 288]])} C${mst([[8, 284], [22, 283.5], [34, 288.5]])} C${mst([[44, 292.5], [52, 300], [56, 310]])} C${mst([[48, 307.5], [38, 303.5], [26, 302.5]])} C${mst([[16, 301.5], [7, 303], [0, 304]])}` +
      ` C${mst([[-7, 303], [-16, 301.5], [-26, 302.5]])} C${mst([[-38, 303.5], [-48, 307.5], [-56, 310]])} C${mst([[-52, 300], [-44, 292.5], [-34, 288.5]])} C${mst([[-22, 283.5], [-8, 284], [0, 288]])} Z`;
    const strands = [-1, 1].map((o) => [6, 15, 24, 33].map((dx, i) => `M${(MCX + o * dx).toFixed(1)},${290 + i * 0.6} q${o * (4 + i)},5 ${o * (7 + i * 1.5)},${10 - i * 0.8}`).join(' ')).join(' ');
    if (extras.has('mustache')) parts.push({ id: 'mustache', name: 'Mustache', role: 'static', group: 'head', depth: 0.65,
      body: `<path d="${MUSTACHE}" transform="translate(0 3)" fill="#000000" fill-opacity="0.2" filter="url(#${P}BlurS)"/>` +
        `<path d="${MUSTACHE}" fill="url(#${P}Beard)"/>` +
        `<path d="${strands}" fill="none" stroke="${darken(beardC, 0.35)}" stroke-opacity="0.45" stroke-width="1.4" stroke-linecap="round"/>` +
        `<path d="M${(MCX - 30).toFixed(1)},290 Q${MCX.toFixed(1)},284.5 ${(MCX + 30).toFixed(1)},290" fill="none" stroke="#FFFFFF" stroke-opacity="0.2" stroke-width="3" stroke-linecap="round" filter="url(#${P}BlurS)"/>` });

    // ---- glasses (over the eyes)
    const frame = cfg.extraColor || '#2A2A2A';
    if (extras.has('glasses')) {
      // Round frames from the Figma "Extras · Glasses" design (canvas px): circular lenses, a thick
      // rim, a straight bridge and short arms; the frame takes the accent colour.
      // (Ellipses, not circles, so the ¾ turn can narrow them.)
      const lens = (cx) => `<ellipse cx="${cx}" cy="210" rx="45" ry="45" fill="#FFFFFF" fill-opacity="0.08" stroke="${frame}" stroke-width="12"/>`;
      parts.push({
        id: 'glasses', name: 'Glasses', role: 'static', group: 'head', depth: 0.85,
        body: lens(148) + lens(251) +
          `<path d="M193,206 L204,206" fill="none" stroke="${frame}" stroke-width="12" stroke-linecap="round"/>` +
          `<path d="M101,202 L83.9,192.8 M295.5,206.5 L316.1,192.8" fill="none" stroke="${frame}" stroke-width="12" stroke-linecap="round"/>` +
          `<path d="M117,189.5 C123,181.7 131.4,177.2 142.1,176 M222,186.5 C228,178.7 236.4,174.2 247.2,173" fill="none" stroke="#FFFFFF" stroke-opacity="0.6" stroke-width="3.6" stroke-linecap="round"/>`,
      });
    }

    // ---- hair / hats (front drawings, reference space)
    const hl = (x, y, rx, ry) => ellipse(x, y, rx, ry, `fill="#FFFFFF" fill-opacity="0.22" filter="url(#${P}BlurL)"`);
    const SHORT = 'M146,420 C120,230 250,150 408,148 C566,150 696,230 670,420 C650,350 620,300 570,280 C520,312 450,322 400,306 C350,322 290,316 250,290 C200,310 170,350 146,420 Z';
    const curls = () => {
      let out = '';
      const n = 11;
      for (let i = 0; i < n; i++) {
        const a = ((196 + (148 * i) / (n - 1)) * Math.PI) / 180;
        const x = 408 + 268 * Math.cos(a);
        const y = 330 + 190 * Math.sin(a);
        out += ellipse(x, y, 66, 62, `fill="${i % 2 ? HAIR : hairTones[1]}"`);
      }
      return out;
    };
    let hairFront = '';
    switch (cfg.hair) {
      case 'cap':
        hairFront = `<path d="${d('M150,330 C150,170 260,70 408,68 C556,70 666,170 666,330 Z')}" fill="url(#${P}Cap)"/>` +
          `<path d="${d('M408,72 L408,248 M300,96 C270,160 262,230 268,256 M516,96 C546,160 554,230 548,256')}" fill="none" stroke="${capTones.seam}" stroke-width="${s(4)}" stroke-opacity="0.8"/>` +
          ellipse(405, 72, 30, 12, `fill="${capTones.button}"`) +
          `<path d="${d('M146,350 C150,280 260,236 408,236 C556,236 668,280 670,350 C672,372 650,372 630,360 C560,320 480,306 408,306 C336,306 256,320 186,360 C166,372 144,372 146,350 Z')}" fill="url(#${P}Brim)"/>` +
          `<path d="${d('M160,346 C250,300 330,284 408,284 C486,284 566,300 656,346')}" fill="none" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="${s(6)}" filter="url(#${P}BlurS)"/>`;
        break;
      case 'short':
      case 'long':
        hairFront = `<path d="${d(SHORT)}" fill="${HAIR}"/>` + hl(330, 210, 120, 40);
        break;
      case 'bun':
        hairFront = ellipse(408, 116, 96, 82, `fill="${HAIR}"`) + `<path d="${d('M330,182 Q408,206 486,182')}" fill="none" stroke="${hairTones[2]}" stroke-width="${s(16)}" stroke-linecap="round"/>` +
          `<path d="${d(SHORT)}" fill="${HAIR}"/>` + hl(330, 210, 120, 40) + hl(380, 90, 40, 20);
        break;
      case 'curly':
        hairFront = `<path d="${d('M150,400 C140,220 260,140 408,138 C556,140 676,220 666,400 C640,330 560,296 408,296 C256,296 176,330 150,400 Z')}" fill="${HAIR}"/>` + curls() + hl(330, 190, 120, 40);
        break;
      case 'centerPart':
      case 'spaceBuns': {
        // A centre parting: two sweeps meet in a V over the forehead; with a top bun, or two buns.
        const buns = cfg.hair === 'spaceBuns'
          ? ellipse(214, 168, 86, 80, `fill="${HAIR}"`) + ellipse(602, 168, 86, 80, `fill="${HAIR}"`) + hl(190, 140, 30, 18) + hl(578, 140, 30, 18)
          : ellipse(408, 118, 102, 88, `fill="${HAIR}"`) + `<path d="${d('M330,186 Q408,210 486,186')}" fill="none" stroke="${hairTones[2]}" stroke-width="${s(16)}" stroke-linecap="round"/>` + hl(380, 92, 42, 20);
        hairFront = buns + `<path d="${d('M146,448 C120,244 250,150 408,148 C566,150 696,244 670,448 C644,352 566,292 436,262 Q416,252 408,236 Q400,252 380,262 C250,292 172,352 146,448 Z')}" fill="${HAIR}"/>` +
          `<path d="${d('M408,160 L408,232')}" fill="none" stroke="${hairTones[2]}" stroke-width="${s(5)}" stroke-opacity="0.5" stroke-linecap="round"/>` + hl(300, 220, 90, 34) + hl(520, 220, 90, 34);
        break;
      }
      case 'curlyBob':
        // A crown of curls over the forehead (the rest of the curls sit behind the head).
        hairFront = `<path d="${d('M150,420 C140,220 260,140 408,138 C556,140 676,220 666,420 C640,340 560,300 408,300 C256,300 176,340 150,420 Z')}" fill="${HAIR}"/>` + curls() + hl(330, 190, 120, 40);
        break;
      case 'bob':
        // A blunt fringe just over the brows; the bob itself is the back layer.
        hairFront = `<path d="${d('M138,430 C126,232 252,158 408,156 C564,158 690,232 678,430 L676,372 C600,354 216,354 140,372 Z')}" fill="${HAIR}"/>` + hl(320, 210, 120, 40);
        break;
      case 'sweep':
        // Swept to one side with lift at the front.
        hairFront = `<path d="${d('M146,440 C118,226 250,124 424,122 C604,124 708,236 670,440 C656,330 604,268 526,246 C452,300 330,302 252,290 C202,318 170,368 146,440 Z')}" fill="${HAIR}"/>` +
          `<path d="${d('M526,246 C560,214 610,214 646,240 C620,206 570,190 520,204 Z')}" fill="${hairTones[2]}" fill-opacity="0.5"/>` + hl(360, 186, 130, 40);
        break;
      case 'bowl':
        // A rounded bowl cut down to the ears, with a little side parting.
        hairFront = `<path d="${d('M138,476 C118,228 250,136 408,134 C566,136 698,228 678,476 C670,404 652,362 622,342 C560,320 482,316 444,330 L424,298 L404,332 C330,318 252,326 196,344 C166,364 148,404 138,476 Z')}" fill="${HAIR}"/>` + hl(320, 196, 120, 40);
        break;
      case 'crop': {
        // A short crop with a ruffled, lumpy top.
        let lumps = '';
        for (let i = 0; i < 7; i++) {
          const a = ((205 + (130 * i) / 6) * Math.PI) / 180;
          lumps += ellipse(408 + 236 * Math.cos(a), 292 + 140 * Math.sin(a), 70, 54, `fill="${i % 2 ? HAIR : hairTones[1]}"`);
        }
        hairFront = `<path d="${d(SHORT)}" fill="${HAIR}"/>` + lumps + hl(340, 170, 110, 34);
        break;
      }
      case 'slick':
        // Combed straight back from a high hairline, with comb lines.
        hairFront = `<path d="${d('M150,410 C138,224 260,132 408,130 C556,132 678,224 666,410 C652,324 618,272 560,252 C480,234 336,234 256,252 C198,272 164,324 150,410 Z')}" fill="${HAIR}"/>` +
          [300, 360, 420, 480].map((x) => `<path d="${d(`M${x},${248 - Math.abs(x - 408) * 0.04} C${x - 6},${200} ${x - 2},${164} ${x + 10},${140}`)}" fill="none" stroke="${hairTones[0]}" stroke-width="${s(6)}" stroke-opacity="0.55" stroke-linecap="round"/>`).join('') + hl(330, 180, 110, 34);
        break;
      case 'flattop':
        // A tall, squared-off top.
        hairFront = `<path d="${d('M150,392 C146,196 226,112 408,110 C590,112 670,196 666,392 L644,392 C622,302 560,280 408,280 C256,280 194,302 172,392 Z')}" fill="${HAIR}"/>` + hl(340, 160, 130, 36);
        break;
      case 'beanie':
        hairFront = `<path d="${d('M156,330 C150,150 270,60 408,58 C546,60 666,150 660,330 Z')}" fill="url(#${P}Cap)"/>` +
          [250, 320, 408, 496, 566].map((x) => `<path d="${d(`M${x},${110 + Math.abs(x - 408) * 0.3} Q${x + (x - 408) * 0.06},${200} ${x + (x - 408) * 0.08},${290}`)}" fill="none" stroke="${capTones.seam}" stroke-width="${s(6)}" stroke-opacity="0.7"/>`).join('') +
          ellipse(408, 50, 56, 50, `fill="url(#${P}Brim)"`) +
          `<path d="${d('M140,300 C260,268 556,268 676,300 L682,380 C556,348 260,348 134,380 Z')}" fill="url(#${P}Brim)"/>` +
          `<path d="${d('M150,312 C260,282 556,282 666,312')}" fill="none" stroke="#FFFFFF" stroke-opacity="0.4" stroke-width="${s(6)}" filter="url(#${P}BlurS)"/>`;
        break;
      default:
        // Flat styles: the scaled drawing plus a sheen across the crown and a soft glint.
        hairFront = flatHair && flatHair.front ? onHead(flatHair.front) + hl(330, 200, 120, 38) + hl(470, 170, 46, 16) : '';
    }
    const hairId = cfg.hair === 'cap' ? 'cap' : cfg.hair === 'beanie' ? 'hat' : 'hair-front';
    const hairName = cfg.hair === 'cap' ? 'Cap' : cfg.hair === 'beanie' ? 'Hat' : 'Hair Front';
    if (hairFront) parts.push({ id: hairId, name: hairName, role: 'static', group: 'head', depth: 0.3, body: hairFront });

    // ---- turn views (canvas units): ¾ wraps the features; side profiles are drawn
    const HEAD_CX = 200;
    const HEAD_RAD = s(259);
    const fx = { L: at(...eyeC.L).x, R: at(...eyeC.R).x, nose: at(405, 0).x, mouth: at(MX, 0).x };
    const turned = (dir) => {
      const th = (dir * TURN_DEG * Math.PI) / 180;
      const sphereU = (u) => {
        if (Math.abs(u) <= HEAD_RAD) return HEAD_RAD * Math.sin(Math.max(-Math.PI / 2, Math.min(Math.PI / 2, Math.asin(u / HEAD_RAD) + th)));
        const g = Math.sign(u);
        return sphereU(g * HEAD_RAD) + (u - g * HEAD_RAD) * Math.cos(th);
      };
      const surfaceX = (x) => x + (sphereU(x - HEAD_CX) + HEAD_CX - x) * 0.8;
      return { surfaceX, feature: (x) => ({ x: surfaceX(x), k: Math.abs(surfaceX(x + 1) - surfaceX(x - 1)) / 2 }) };
    };
    const wrapX = (cx, nx, k, body) => `<g transform="translate(${nx.toFixed(2)} 0) scale(${k.toFixed(3)} 1) translate(${(-cx).toFixed(2)} 0)">${body}</g>`;
    // ¾ drawings from the design (Figma "Theo ¾ left"), in canvas px for the left turn;
    // the right turn mirrors them. Paths are moved/mirrored point by point.
    const placed = (path, dx, dy, mirror) => path.replace(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g, (_, x, y) => {
      const nx = +x + dx;
      return `${(mirror ? W - nx : nx).toFixed(1)},${(+y + dy).toFixed(1)}`;
    });
    // The cap turns less than the head: the crown and button stay nearly centred while the
    // brim swings out past the near cheek and stops short on the far side.
    const quarterCap = (dir, seamW = 1.8) => {
      const m = dir > 0;
      const P0 = (path) => placed(path, 0, 0, m);
      const bx = m ? W - 194.5 : 194.5;
      const crown = P0('M83.5,148.5 C83.6,76.5 136.9,32.9 193,32 C260.7,32.9 303.6,76.5 301.4,148.5 Z');
      return `<path d="${crown}" fill="url(#${P}Cap)"/>` +
        // The seams are trimmed to stay inside the crown, so their ends never poke out past its edge.
        `<path d="${clipLine(P0('M166.4,30 L159.7,111.6 M121.6,40 C111.7,72 107.2,103.5 108.3,115.2 M216.4,40 C226.2,72 227.5,103.5 223.4,115.2'), crown, seamW / 2 + 3)}" fill="none" stroke="${capTones.seam}" stroke-width="${seamW}" stroke-opacity="0.8" stroke-linecap="round"/>` +
        `<ellipse cx="${bx}" cy="32.4" rx="12.5" ry="5.4" fill="${capTones.button}"/>` +
        `<path d="${placed('M0.114,28.494 C1.515,10.998 24.332,0 78.172,0 C146.323,0 224.681,10.998 224.981,28.494 C225.782,33.992 201.163,33.992 186.052,30.993 C145.122,20.995 106.493,17.496 75.27,17.496 C47.549,17.496 20.83,20.995 4.818,30.993 C2.916,33.992 -0.686,33.992 0.114,28.494 Z', 53.92, 124, m)}" fill="url(#${P}Brim)"/>` +
        `<path d="${placed('M4.73,20.35 C22.02,9.22 48.51,5.35 78.59,5.35 C112.48,5.35 151.26,9.22 208.73,20.35', 51.19, 130.65, m)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="2.7" filter="url(#${P}BlurS)"/>`;
    };
    const front = parts.filter((p) => p.group === 'head');
    const viewParts = [];
    const geometry = {};
    const quarterDefs = [];
    for (const dir of [1, -1]) {
      const view = dir > 0 ? 'R' : 'L';
      const { surfaceX, feature } = turned(dir);
      // A face isn't a ball: below the eyes the jaw and chin swing toward the turn.
      const swing = (y) => dir * 9 * Math.max(0, Math.min(1, (y - 205) / 140));
      const faceMap = (x, y) => [surfaceX(x) + swing(y), y];
      // The ¾ outline is the design's (Figma "Theo ¾ left", mirrored for the right): the far side
      // runs straight down into a rounder chin. The face's inner shading is clipped by it too.
      // Under hair (or bare) the skull gets a rounded crown; hats sit on the design's flatter top.
      const hatted = ['cap', 'fBaseball', 'beanie'].includes(cfg.hair);
      const crownQ = hatted ? 'M1.7,54 C1.5,18 18.9,0 75,0 C149.9,0 224,18 219.4,54' : 'M1.7,54 C0,-8 50,-46 112,-46 C176,-46 222,-8 219.4,54';
      // The ¾ jaw (from the design); the oval face keeps the cheek and tapers from the jaw to a longer chin.
      const jawQ = oval
        ? ' C224,108 228,170 214,208 C196,258 150,290 94,291.3 C50,290 6,256 2.8,205 C-1,156 1.5,108 1.7,54 Z'
        : ' C224,108 229.7,173 209.5,213.5 C189.2,263 148.1,281.6 94,282.5 C49.9,281.6 2.5,249 1.7,199.5 C-2,152 1.5,108 1.7,54 Z';
      const quarterHead = placed(crownQ + jawQ, 82, 94.5, dir > 0);
      const turnedHead = `<path d="${quarterHead}" fill="#FFFFFF"/>`;
      quarterDefs.push(`<mask id="${P}Head${view}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${turnedHead}</mask>`);
      // Local (design) coords for the ¾ head: x 0..220 from the far cheek to the back, y 0 at the brow line of the cap.
      const Lq = (path) => placed(path, 82, 94.5, dir > 0);
      const scaleQ = (cx, cy, sx, sy, ox = 0, oy = 0) => (crownQ + jawQ)
        .replace(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g, (_, x, y) => `${(cx + (+x - cx) * sx + ox).toFixed(1)},${(cy + (+y - cy) * sy + oy).toFixed(1)}`);
      // The back of the skull, seen in ¾, is covered by hair: a cap of hair over the crown that
      // comes down behind the temple to just above the near ear (under the style's own front).
      // Its dome rises to the style's own top (peaking where the style peaks), so a tall quiff or
      // sweep reads as one rounded mass rather than a style stuck on a smaller skull; behind the
      // temple it comes down to the top of the near ear, so short hair always meets the ear.
      const backHair = (styled) => {
        const pts = [];
        for (const el of styled.match(/<(path|ellipse)\b[^>]*>/g) || []) {
          if (/filter=|fill="none"/.test(el)) continue;
          const dd = /\sd="([^"]+)"/.exec(el);
          if (dd) samplePath(dd[1], 6).forEach((poly) => pts.push(...poly));
          const num = (k) => { const m2 = new RegExp(`\\b${k}="([-\\d.]+)"`).exec(el); return m2 ? +m2[1] : null; };
          if (el.startsWith('<ellipse')) pts.push(...ellipsePoly(num('cx'), num('cy'), num('rx'), num('ry'), 24));
        }
        const local = pts.map(([x, y]) => [dir > 0 ? W - x - 82 : x - 82, y - 94.5]).filter(([x]) => x > -10 && x < 240);
        const top = local.reduce((a, q) => (q[1] < a[1] ? q : a), [112, -46]);
        const t = Math.min(-46, -46 + (top[1] + 44) * 0.25); // hugs the skull; only a little lift under a tall style
        const px = Math.max(70, Math.min(160, top[1] < -46 ? top[0] : 112));
        // (Plus the plain skull cover, so a dome peaking off-centre never bares the crown.)
        // Its front edge runs round the forehead under the style's hairline; a middle part (wavy)
        // needs it higher, so the parting still shows.
        const volume = false;
        // Short styles get volume at the back of the head (Figma 382-1005): a rounded mass from the crown
        // back past the skull and down to the top of the near ear, its front edge a straight line back
        // up to the crown, so the temple behind the hairline is covered.
        const wedge = ['cap', 'quiff', 'sweep', 'bowl', 'curls'].includes(flatStyle)
          ? ` ${Lq(`M${px},${t} C${px + 70},${t} 236,${t + 26} 234,40 C233,62 230,82 230,98 C228,94 222,88 214,93 L${px},${t} Z`)}` : '';
        const brow = flatStyle === 'wavy' ? 'C180,30 150,-14 112,-18 C70,-18 24,8 2,40' : 'C180,42 150,24 110,22 C60,22 24,28 2,40';
        return `<path d="${Lq(`M2,40 C0,-6 52,-46 112,-46 C178,-46 226,-6 221,62 L192,70 ${brow} Z`)} ${Lq(`M2,40 C0,${t + 40} ${px - 60},${t} ${px},${t} ${volume ? `C${px + 72},${t} 248,${t + 8} 256,${t + 48} C263,${t + 84} 260,88 248,100 C240,108 231,114 227,124` : `C${px + 66},${t} 226,${t + 40} 221,62 C224,90 228,110 227,124`} C219,128 210,124 205,113 C200,100 197,86 192,70 ${brow} Z`)}${wedge}" fill="${HAIR}"/>`;
      };
      const near = dir > 0 ? 'L' : 'R';
      geometry[view] = { eyes: { L: feature(fx.L), R: feature(fx.R) } };
      // Hats and hair turn with the head (their crown a little less than the brim),
      // so they stay seated on the turned outline.
      const capMap = (x, y) => [x + (surfaceX(x) - x) * (0.75 + 0.25 * Math.max(0, Math.min(1, (y - 30) / 120))), y];
      // Ears: the near one slides in with the cheek; the far one peeks out behind it.
      const far = near === 'L' ? 'R' : 'L';
      const farX = at(far === 'L' ? 108 : 710, 0).x;
      // From the Figma "Theo ¾ left" design (canvas px, mirrored for ¾ right): the far ear is a curved
      // sliver behind the cheek; the near one is a round ear tilted 12° against the side of the head.
      // Earbuds and earrings stay on the near ear, tilted with it.
      const m = dir > 0;
      const mx = (x) => (m ? W - x : x);
      const farEar = `<g transform="${m ? `translate(${W} 0) scale(-1 1) ` : ''}translate(58 200)">` +
        `<path d="M32.4,71.6 C44.1,69.6 51.1,52.8 48,34 C44.9,15.2 32.9,1.6 21.2,3.5 C9.5,5.4 2.5,22.2 5.6,41 C8.7,59.8 20.7,73.5 32.4,71.6 Z" fill="url(#${P}Ball)"/>` +
        `<path d="M33.7,69 C39.9,67.9 43,54.8 40.5,39.6 C38,24.4 30.9,12.9 24.6,13.9 C18.4,14.9 15.3,28.1 17.8,43.3 C20.3,58.5 27.4,70 33.7,69 Z" fill="${tone.ear}" fill-opacity="0.6" filter="url(#${P}BlurM)"/></g>`;
      const nc = { x: mx(313), y: 237.5 };
      const tilt = m ? -12.08 : 12.08;
      const nearC = at(near === 'L' ? 108 : 710, 528);
      const nearEar = `<g transform="rotate(${tilt} ${nc.x} ${nc.y})">` +
        `<ellipse cx="${nc.x}" cy="${nc.y}" rx="28.5" ry="43.5" fill="url(#${P}Ball)"/>` +
        `<ellipse cx="${mx(311.5)}" cy="239.1" rx="13.5" ry="27.9" fill="${tone.ear}" fill-opacity="0.6" filter="url(#${P}BlurM)"/>` +
        // The ear's own extras, moved from where they sit on the front ear to this one.
        // (Shifted toward the ear's outer edge: its inner side is tucked under the turned cheek.)
        `<g transform="translate(${(nc.x - nearC.x + (m ? -12 : 12)).toFixed(2)} ${(nc.y - nearC.y).toFixed(2)})">${(extras.has('earrings') ? ring(near) : '') + (extras.has('earbuds') ? pod(near) : '')}</g></g>`;
      const ears = farEar + nearEar;
      for (const p of front) {
        let body;
        if (p.id === 'ears') body = hideEars ? p.body : ears;
        // The outline turns as far as the features on it, so they stay on the face.
        else if (p.id === 'face') {
          // Turned outline, plus a soft shade on the far cheek (it faces away from us).
          const farEdge = dir > 0 ? 96 : 304;
          // The design's ¾ face (Figma "Theo ¾ left", mirrored for the right): its outline, a soft rim
          // shade offset up and toward the near side, a cheek highlight, the shade under the brim or
          // fringe, and the far-cheek shade; blush and freckles turn with the face.
          const Q = (path, dx, dy) => placed(path, dx, dy, dir > 0);
          const hiX = dir > 0 ? W - 126.4 : 126.4;
          // Shading as gradient fills of the turned outline (no masks): the rim and brim shade as in
          // front, plus the far cheek darkening toward its edge; the cheek sheen sits well inside.
          defs.push(`<linearGradient id="${P}FarShade${view}" x1="${farEdge < 200 ? 0 : 1}" y1="0" x2="${farEdge < 200 ? 0.35 : 0.65}" y2="0"><stop offset="0" stop-color="${tone.rim}" stop-opacity="0.3"/><stop offset="1" stop-color="${tone.rim}" stop-opacity="0"/></linearGradient>`);
          body = `<path d="${quarterHead}" fill="${SKIN}"/>` + faceShade(quarterHead) + `<path d="${quarterHead}" fill="url(#${P}FarShade${view})"/>` +
            `<ellipse cx="${hiX}" cy="184.5" rx="46.1" ry="31.5" fill="#FFFFFF" fill-opacity="0.22" filter="url(#${P}BlurL)"/>` +
            warpSvg(cheeks, faceMap);
        }
        else if (p.id === 'cap' && cfg.hair === 'cap') body = quarterCap(dir);
        else if (p.id === 'hair-front' && flatStyle === 'baseball') {
          // The baseball cap turns like Theo's cap, sitting a little lower, with bold seams.
          const k = 1.187;
          body = `<g transform="translate(0 ${(33.7 - 32 * k).toFixed(2)}) scale(1 ${k})">${quarterCap(dir, 5)}</g>`;
        } else if (p.id === 'hair-front' && flatStyle === 'hijab') {
          // The scarf is drawn from the turned head: a wrap a size up, offset toward the back of the
          // head, around an opening that follows the turned face.
          // The opening is the turned face itself, drawn in a little (more on the near cheek, where
          // the scarf wraps round toward the ear) so the wrap frames the face evenly from every side.
          const faceQ = 'M1.7,54 C0,-8 50,-46 112,-46 C176,-46 222,-8 219.4,54' + jawQ;
          const opening = Lq(faceQ.replace(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g, (_, x, y) => `${(100 + (+x - 100) * 0.9 - 10).toFixed(1)},${(150 + (+y - 150) * (+y < 150 ? 0.78 : 0.97)).toFixed(1)}`));
          body = `<path d="${Lq(scaleQ(110, 141, 1.36, 1.216, 10, 28))} ${opening}" fill="${HAIR}" fill-rule="evenodd"/>` +
            hl(330, 200, 120, 38);
        } else if (p.id === 'hair-front' && flatStyle) {
          const styled = warpSvg(p.body, capMap);
          body = backHair(styled) + styled;
        }
        else if (p.id === 'cap' || p.id === 'hat' || p.id === 'hair-front') body = warpSvg(p.body, capMap);
        // Faux 3D: the hair behind the head is further back than the face, so in ¾ it slides the
        // other way (parallax) — more of it shows behind the near ear, less past the far cheek.
        else if (p.id === 'hair-back') body = warpSvg(p.body, (x, y) => [x - dir * 18 + (surfaceX(x) - x) * 0.15, y]);
        else if (p.id === 'glasses') body = warpSvg(p.body, (x, y) => [surfaceX(x), y]);
        else if (p.id === 'beard') {
          // A fuller, rounded chin that carries on from the jaw (the ¾ chin sits toward the far side).
          const chinU = placed(oval ? 'M-4,193 C4,254 49,302 96,304.3 C146,302 211,254 221,193 Z' : 'M-6,195.5 C2,255 48,299.5 96,301.5 C148,299.5 214,255 224,195.5 Z', 82, 94.5, dir > 0);
          body = beardOf(warpSvg(`<path d="${BEARD}"/>`, faceMap).match(/d="([^"]+)"/)[1], quarterHead, chinU, { x: dir > 0 ? W - 192 : 192, y: 236 });
        }
        else if (p.id === 'mustache') { const f = feature(fx.mouth); body = wrapX(fx.mouth, f.x + swing(295), f.k, p.body); }
        else if (p.id === 'nose') { const f = feature(fx.nose); body = wrapX(fx.nose, f.x + dir * 9 + swing(258), f.k, p.body); }
        else if (p.role === 'mouth') { const f = feature(fx.mouth); body = wrapX(fx.mouth, f.x + swing(315), f.k, p.body); }
        else if (p.side) { const f = feature(fx[p.side]); body = wrapX(fx[p.side], f.x, f.k, p.body); }
        else body = p.body;
        const sideWrap = p.side && !['mouth'].includes(p.role) ? (b) => { const f = feature(fx[p.side]); return wrapX(fx[p.side], f.x, f.k, b); } : null;
        const matte = p.matte && sideWrap ? { body: sideWrap(p.matte.body), target: sideWrap(p.matte.target) } : undefined;
        viewParts.push({ ...p, id: `${p.id}@${view}`, name: `${p.name} (¾ ${view})`, view, body, ...(p.matte ? { matte } : {}) });
      }
    }
    const profileDefs = [];
    for (const dir of [1, -1]) {
      const view = dir > 0 ? 'PR' : 'PL';
      const near = dir > 0 ? 'L' : 'R';
      // Drawn facing right in (dx, y): +dx toward the face; mirrored for the left.
      const X = (path) => path.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, dx, y) => `${(200 + dir * +dx).toFixed(1)},${y}`);
      const px = (dx) => 200 + dir * dx;
      const el = (cx, cy, rx, ry, attrs) => `<ellipse cx="${px(cx).toFixed(1)}" cy="${cy}" rx="${rx}" ry="${ry}" ${attrs}/>`;
      const HEADP = X('M-80,150 C-84,100 -40,84 6,84 C60,84 98,108 104,150 L108,196 C110,212 112,224 108,236 C112,262 110,288 104,306 C98,334 82,360 56,370 C22,380 -18,374 -40,352 C-66,326 -86,280 -90,230 C-92,196 -88,170 -80,150 Z');
      const maskId = `${P}Head${view}`;
      profileDefs.push(`<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${HEADP}" fill="#FFFFFF"/></mask>`);
      geometry[view] = { eyes: { [near]: { x: px(78), k: 0.55 } } };
      const SHORTP = 'M-96,214 C-106,118 -50,72 10,72 C70,72 106,102 112,152 C96,140 80,138 64,144 C40,130 8,132 -12,146 C-42,152 -72,172 -86,214 Z';
      for (const p of front) {
        let body = null;
        if (p.id === 'face') {
          // Nape and throat: side on, the neck leaves the head behind the jaw and
          // slopes down into the collar (drawn under the head silhouette).
          const nape = `<path d="${X('M-64,300 C-56,330 -52,360 -54,388 L40,388 C38,372 42,360 50,350 C20,360 -20,356 -64,300 Z')}" fill="${SKIN}"/>` +
            `<path d="${X('M-60,330 C-40,352 10,362 46,352 L44,374 C10,380 -40,372 -58,352 Z')}" fill="${tone.neckShadow}" fill-opacity="0.3" filter="url(#${P}BlurM)"/>`;
          body = nape + `<path d="${HEADP}" fill="${SKIN}"/>` + faceShade(HEADP) +
            el(30, 196, 52, 30, `fill="#FFFFFF" fill-opacity="0.22" filter="url(#${P}BlurL)"`) +
            (extras.has('blush') ? el(56, 254, 26, 16, `fill="#FF7A8A" fill-opacity="0.35" filter="url(#${P}BlurM)"`) : '') +
            (extras.has('freckles') ? [[50, 262], [64, 270], [56, 280]].map(([x, y]) => `<circle cx="${px(x).toFixed(1)}" cy="${y}" r="2.7" fill="${tone.nose}" fill-opacity="0.55"/>`).join('') : '');
        } else if (p.id === 'ears' && hideEars) {
          body = p.body;
        } else if (p.id === 'ears') {
          body = el(-20, 244, 27, 45, `fill="${tone.nose}" fill-opacity="0.35" filter="url(#${P}BlurM)"`) + el(-16, 240, 24, 42, `fill="url(#${P}Ball)"`) + el(-12, 242, 12, 26, `fill="${tone.ear}" fill-opacity="0.6" filter="url(#${P}BlurM)"`) +
            (extras.has('earrings') ? `<circle cx="${px(-16).toFixed(1)}" cy="288" r="10" fill="none" stroke="#E8B23A" stroke-width="4"/>` : '') +
            (extras.has('earbuds') ? `<path d="${X('M-24,250 C-26,266 -24,286 -20,298 C-16,308 -6,306 -6,296 C-6,282 -8,264 -8,250 Z')}" fill="url(#${P}Pod)"/>` +
              el(-14, 248, 14, 10, `fill="url(#${P}Pod)"`) + el(-18, 245, 5, 3, 'fill="#FFFFFF" fill-opacity="0.9"') : '');
        } else if (p.id === 'cap') {
          body = `<path d="${X('M-98,160 C-104,84 -46,30 12,30 C70,30 106,70 108,124 L108,152 C54,150 -20,156 -98,172 Z')}" fill="url(#${P}Cap)"/>` +
            `<path d="${X('M100,128 L162,138 C172,142 170,154 158,156 L100,154 Z')}" fill="url(#${P}Brim)"/>` +
            `<path d="${X('M12,32 C26,70 30,110 26,150')}" fill="none" stroke="${capTones.seam}" stroke-width="2" stroke-opacity="0.8"/>` +
            `<path d="${X('M104,134 L160,142')}" fill="none" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="3" filter="url(#${P}BlurS)"/>` +
            el(12, 31, 14, 6, `fill="${capTones.button}"`);
        } else if (p.id === 'hat') {
          body = `<path d="${X('M-100,172 C-106,90 -48,36 10,36 C68,36 104,78 108,134 L108,160 C54,156 -20,160 -100,176 Z')}" fill="url(#${P}Cap)"/>` +
            el(14, 30, 22, 20, `fill="url(#${P}Brim)"`) +
            `<path d="${X('M-104,150 C-20,136 54,132 112,138 L114,172 C54,166 -20,170 -104,186 Z')}" fill="url(#${P}Brim)"/>`;
        } else if (p.id === 'hair-front' && flatStyle) {
          body = onHead(Flat.profileHair(flatC, dir)) + el(10, 96, 50, 16, `fill="#FFFFFF" fill-opacity="0.2" filter="url(#${P}BlurL)"`);
        } else if (p.id === 'hair-back' && flatStyle) {
          body = onHead(flatHair.back);
        } else if (p.id === 'hair-front') {
          let extra = '';
          if (cfg.hair === 'curly') {
            extra = [[-88, 196], [-82, 150], [-56, 108], [-18, 84], [24, 78], [64, 90], [96, 118]].map(([x, y], i) => el(x, y, 24, 22, `fill="${i % 2 ? HAIR : hairTones[1]}"`)).join('');
          }
          if (cfg.hair === 'curlyBob') {
            extra = [[-88, 196], [-82, 150], [-56, 108], [-18, 84], [24, 78], [64, 90], [96, 118]].map(([x, y], i) => el(x, y, 26, 24, `fill="${i % 2 ? HAIR : hairTones[1]}"`)).join('');
          }
          const bun = cfg.hair === 'bun' || cfg.hair === 'centerPart' ? el(-34, 60, 34, 30, `fill="${HAIR}"`)
            : cfg.hair === 'spaceBuns' ? el(-30, 70, 32, 30, `fill="${HAIR}"`) : '';
          body = bun + `<path d="${X(SHORTP)}" fill="${HAIR}"/>` + extra + el(10, 96, 50, 16, `fill="#FFFFFF" fill-opacity="0.2" filter="url(#${P}BlurL)"`);
        } else if (p.id === 'hair-back') {
          // Long hair falls past the shoulders; a bob or curly bob stops at the jaw.
          const end = cfg.hair === 'long' ? 404 : 344;
          body = `<path d="${X(`M-112,190 C-122,104 -52,68 10,68 C70,68 106,100 112,150 L100,164 C60,154 22,154 -8,172 C-28,240 -36,${end - 84} -44,${end} L-122,${end} C-128,${end - 84} -126,256 -112,190 Z`)}" fill="${HAIR}"/>` +
            (cfg.hair === 'curlyBob' ? [[-110, 300], [-80, 330], [-40, 340], [-120, 240]].map(([x, y], i) => el(x, y, 28, 26, `fill="${i % 2 ? HAIR : hairTones[1]}"`)).join('') : '');
        } else if (p.id === 'glasses') {
          // Side on, the round lens is a narrow upright ellipse with the same thick rim, and one arm.
          body = el(80, 210, 20, 45, `fill="#FFFFFF" fill-opacity="0.08" stroke="${frame}" stroke-width="10"`) +
            `<path d="${X('M64,200 L-12,214')}" fill="none" stroke="${frame}" stroke-width="10" stroke-linecap="round"/>`;
        } else if (p.id === 'nose') {
          const pn = (x, y, rx, ry, attrs) => el(112 + (x - 112) * nk, 257 + (y - 257) * nk, rx * nk, ry * nk, attrs);
          const shade = pn(116, 268, 22, 12, `fill="${tone.nose}" fill-opacity="0.35" filter="url(#${P}BlurM)"`);
          const shine = (x, y) => el(x, y, 7, 5, `fill="#FFFFFF" fill-opacity="0.35" filter="url(#${P}BlurS)"`);
          // Side-on versions of the button and tall noses; no nose draws nothing.
          if (cfg.nose === 'none') body = `<circle cx="${px(100).toFixed(1)}" cy="257" r="1" fill="#000000" fill-opacity="0"/>`;
          else if (cfg.nose === 'button') body = shade + `<path d="${X('M94,248 C94,241 99,238 106,238 L116,238 C124,238 128,243 128,250 L128,260 C128,267 124,272 116,272 L106,272 C99,272 94,268 94,262 Z')}" fill="url(#${P}Ball)"/>` + shine(104, 246);
          else if (cfg.nose === 'tall') body = shade + `<path d="${X('M94,271 L98,240 C100,226 106,216 112,216 C118,216 122,230 124,246 L127,262 C128,268 124,271 118,271 Z')}" fill="url(#${P}Ball)"/>` + shine(106, 232);
          else body = shade + pn(112, 257, 25, 27, `fill="url(#${P}Ball)"`) + pn(106, 247, 8, 6, `fill="#FFFFFF" fill-opacity="0.35" filter="url(#${P}BlurS)"`);
        } else if (p.id === 'beard') {
          // Side on: from the sideburn down the jaw and round the chin's front, under the mouth.
          body = `<path d="${clipD(X('M-130,224 L-30,224 C-26,256 6,286 50,298 C62,300 74,298 84,302 C96,306 106,312 140,314 L140,440 L-130,440 Z'), beardClip(HEADP, X('M-84,300 C-74,362 -22,394 30,394 C72,394 104,362 110,300 Z'), { x: px(10), y: 230 }))}" fill="url(#${P}Beard)"/>`;
        } else if (p.id === 'mustache') body = wrapX(fx.mouth, px(92), 0.45, p.body);
        else if (p.role === 'mouth') body = wrapX(fx.mouth, px(86), 0.4, p.body);
        else if (p.side) body = p.side === near ? wrapX(fx[p.side], px(78), 0.55, p.body) : null;
        if (body) viewParts.push({ ...p, id: `${p.id}@${view}`, name: `${p.name} (side ${dir > 0 ? 'R' : 'L'})`, view, body, matte: undefined });
      }
      const ear = viewParts.findIndex((q) => q.id === `ears@${view}`);
      const face = viewParts.findIndex((q) => q.id === `face@${view}`);
      if (ear >= 0 && face > ear) viewParts.splice(face, 0, ...viewParts.splice(ear, 1));
      // Side on, the beard runs back under the ear, so the ear sits over it.
      const earAt = viewParts.findIndex((q) => q.id === `ears@${view}`);
      const beardAt = viewParts.findIndex((q) => q.id === `beard@${view}`);
      if (earAt >= 0 && beardAt > earAt) viewParts.splice(beardAt, 0, ...viewParts.splice(earAt, 1));
    }

    // Back hair (every view's) goes behind the body, so it never covers the neck.
    let all = [...parts.map((p) => (p.group === 'head' ? { view: 'F', ...p } : p)), ...viewParts];
    {
      // Every outfit has a ¾ drawing: the same wide, relaxed body, with the low point of the neckline
      // sliding toward the turn (the Figma "Theo ¾ left" tee). The collar corners stay put so the
      // neck still fills the opening; the side views keep the front body.
      const torso = all.find((p) => p.id === 'body');
      const turnBody = (dir) => warpSvg(torso.body, (x, y) => {
        const across = Math.max(0, 1 - ((x - 200) / 56) ** 2); // 1 at the centre, 0 at the collar corners
        const down = Math.max(0, Math.min(1, (480 - y) / 90)); // only around the neckline
        return [x + dir * 11 * across * down, y];
      });
      const perView = ['F', 'R', 'L', 'PR', 'PL'].map((view) => ({
        ...torso,
        ...(view === 'F' ? {} : { id: `body@${view}`, name: `Body (${view.startsWith('P') ? 'side' : '¾'} ${view.slice(-1)})` }),
        view,
        body: view === 'R' ? turnBody(1) : view === 'L' ? turnBody(-1) : torso.body,
      }));
      const at = all.indexOf(torso);
      all = [...all.slice(0, at), ...perView, ...all.slice(at + 1)];
    }
    const backs = all.filter((p) => p.id.split('@')[0] === 'hair-back');
    const ordered = backs.length ? [...backs, ...all.filter((p) => !backs.includes(p))] : all;

    const pivot = at(410, 830);
    return {
      id: cfg.id, name: cfg.name, size: { width: W, height: H }, pivot,
      eyes: { L: at(...eyeC.L), R: at(...eyeC.R) },
      gaze: { x: 3, y: 1 }, socket: null, iris: { r: 9 }, shutHidesEyes: true, mouth: { x: at(MX, MY + 10).x, y: at(MX, MY + 10).y + mouthLift },
      faceHalfWidth: 115, turn: 0.5, thumb: thumbFor(Math.min(...Object.values(HAIR_TOP)), pivot), thumbBg: cfg.thumbBg, // one framing for every hairstyle, so tiles share a scale
      turnViews: { angle: TURN_DEG, enter: 22, exit: 15, geometry, profile: { angle: PROFILE_DEG, enter: 48, exit: 40 } },
      defs: defs.join('') + quarterDefs.join('') + profileDefs.join(''),
      parts: ordered,
      ...(options.kit ? { kit: options.kit } : {}),
    };
  }

  // ======================================================================
  //  Head (Orb's base)
  // ======================================================================

  /** Palettes: body gradient, rim shadow, lilac tint, glow, socket/brow/shadow ink. */
  const ORB_PALETTE = {
    base: ['#9FD8FA', '#6DB6F2', '#7E9CEB'], glow: ['#FF8DC2', '#F6A3D6', '#C9A8F2'], tint: '#B7A6F4',
    rim: '#3E63C9', socket: '#3557B8', brow: '#3F6BCF', shadow: '#5B79D6', white: '#9FB0D6',
  };
  const paletteFrom = (light, mid, edge, glow) => ({
    base: [light, mid, edge], glow: [glow, lighten(glow, 0.25), mix(glow, edge, 0.5)], tint: mix(mid, glow, 0.5),
    rim: darken(edge, 0.45), socket: darken(edge, 0.5), brow: darken(mid, 0.4), shadow: darken(edge, 0.2), white: mix(edge, '#FFFFFF', 0.45),
  });
  const HEAD_PALETTES = {
    sky: ORB_PALETTE,
    mint: paletteFrom('#B8F2D8', '#6FD3AA', '#4FB39A', '#FFD27A'),
    peach: paletteFrom('#FFD9C2', '#FFAE8A', '#F08A74', '#FF7FA8'),
    lilac: paletteFrom('#E3D4FF', '#B79BF5', '#8E78E0', '#FF9AD5'),
    lemon: paletteFrom('#FFF2A8', '#FFD84D', '#F2B33A', '#FF8F6B'),
    coral: paletteFrom('#FFC1C8', '#FF7F92', '#E35D7B', '#FFC36B'),
    slate: paletteFrom('#D6DEE8', '#9AA9BD', '#6F7F96', '#8EC5FF'),
    aqua: paletteFrom('#A9CEFF', '#00C6FF', '#009ECC', '#7FE3FF'), // from the Figma "generating" blob
  };

  const HEAD_DEFAULT = {
    base: 'head', id: 'orb', name: 'Orb', prefix: 'orb',
    shape: 'cloud', palette: 'sky', glow: true, eyes: 'sleepy', mouth: 'default', inkColor: '#2A2453',
    extras: [], extraColor: '#2A2A2A', thumbBg: '#E3ECFB',
  };
  const SHAPE_TOP = { cloud: 80, round: 82, bean: 96, square: 92, hexagon: 108 };

  function head(options = {}) {
    const cfg = { ...HEAD_DEFAULT, ...options };
    const P = cfg.prefix || cfg.id;
    const pal = HEAD_PALETTES[cfg.palette] || ORB_PALETTE;
    const extras = new Set(cfg.extras || []);
    const n = (v) => +v.toFixed(1);
    const C = { x: 200, y: 232 };
    const lobeOutline = (lobes) => {
      const meet = (a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
        const along = (a.r * a.r - b.r * b.r + dist * dist) / (2 * dist);
        const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
        const mx = a.x + (dx * along) / dist, my = a.y + (dy * along) / dist;
        const p1 = { x: mx + (h * dy) / dist, y: my - (h * dx) / dist };
        const p2 = { x: mx - (h * dy) / dist, y: my + (h * dx) / dist };
        return Math.hypot(p1.x - C.x, p1.y - C.y) > Math.hypot(p2.x - C.x, p2.y - C.y) ? p1 : p2;
      };
      const joins = lobes.map((l, i) => meet(lobes[(i + lobes.length - 1) % lobes.length], l));
      let out = `M${n(joins[0].x)},${n(joins[0].y)}`;
      lobes.forEach((l, i) => {
        const from = joins[i], to = joins[(i + 1) % lobes.length];
        let sweep = Math.atan2(to.y - l.y, to.x - l.x) - Math.atan2(from.y - l.y, from.x - l.x);
        while (sweep <= 0) sweep += 2 * Math.PI;
        out += ` A${l.r},${l.r} 0 ${sweep > Math.PI ? 1 : 0},1 ${n(to.x)},${n(to.y)}`;
      });
      return `${out} Z`;
    };
    const OUTLINES = {
      cloud: () => lobeOutline([
        { x: 160, y: 158, r: 72 }, { x: 250, y: 152, r: 64 }, { x: 302, y: 222, r: 58 },
        { x: 262, y: 300, r: 70 }, { x: 148, y: 300, r: 72 }, { x: 98, y: 222, r: 58 },
      ]),
      round: () => 'M52,240 A148,148 0 1,1 348,240 A148,148 0 1,1 52,240 Z',
      bean: () => lobeOutline([{ x: 140, y: 196, r: 98 }, { x: 260, y: 196, r: 98 }, { x: 262, y: 290, r: 92 }, { x: 138, y: 290, r: 92 }]),
      square: () => 'M128,92 L272,92 C318,92 344,118 344,164 L344,314 C344,360 318,386 272,386 L128,386 C82,386 56,360 56,314 L56,164 C56,118 82,92 128,92 Z',
      // A soft hexagon, wider than tall, pointed at the sides (the Figma "generating" blob, scaled up).
      hexagon: () => 'M238,107.9 C261.5,107.9 283.2,120.1 295.4,140.2 L334.9,205 C348,226.5 348,253.5 334.9,275 L295.4,339.8 C283.2,359.8 261.5,372.1 238,372.1 L162,372.1 C138.5,372.1 116.8,359.8 104.5,339.8 L65.1,275 C52,253.5 52,226.5 65.1,205 L104.5,140.2 C116.8,120.1 138.5,107.9 162,107.9 L238,107.9 Z',
    };
    const OUTLINE = (OUTLINES[cfg.shape] || OUTLINES.cloud)();

    const eyes = { L: { x: 164, y: 220 }, R: { x: 238, y: 220 } };
    const EYE = { oval: { rx: 22, ry: 28 }, round: { rx: 25, ry: 25 }, small: { rx: 15, ry: 19 }, sleepy: { rx: 22, ry: 28 }, beads: { rx: 10, ry: 13 }, googly: { rx: 27, ry: 33 }, droopy: { rx: 24, ry: 23 }, pill: { rx: 19, ry: 28 } }[cfg.eyes] || { rx: 22, ry: 28 };
    const pill = cfg.eyes === 'pill'; // tall black capsules (the Figma "generating" blob)
    const beads = cfg.eyes === 'beads' || pill; // solid dark eyes, no eye white
    // "None": the eye and mouth layers stay (so blinks and lip sync still run), but draw nothing.
    const noEyes = cfg.eyes === 'none';
    const noMouth = cfg.mouth === 'none';
    const blank = (x, y) => `<circle cx="${x}" cy="${y}" r="1" fill="#000000" fill-opacity="0"/>`;
    const INK = same(cfg.inkColor, '#2A2453') ? '#1E2448' : darken(cfg.inkColor, 0.2);
    const MOUTH = cfg.inkColor;
    const TONGUE = '#F37FB0';
    const blur = (id, v) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="-100" y="-100" width="600" height="700"><feGaussianBlur stdDeviation="${v}"/></filter>`;
    const eyeShape = (side, grow = 0) => {
      const { x, y } = eyes[side];
      const rx = EYE.rx + grow;
      const ry = EYE.ry + grow;
      if (!pill) return `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"`;
      // A capsule: straight sides, round ends.
      return `<path d="M${x - rx},${y - ry + rx} A${rx},${rx} 0 0,1 ${x + rx},${y - ry + rx} L${x + rx},${y + ry - rx} A${rx},${rx} 0 0,1 ${x - rx},${y + ry - rx} Z"`;
    };
    let defs = [
      `<radialGradient id="${P}Base" gradientUnits="userSpaceOnUse" cx="170" cy="150" r="250"><stop offset="0" stop-color="${pal.base[0]}"/><stop offset="0.55" stop-color="${pal.base[1]}"/><stop offset="1" stop-color="${pal.base[2]}"/></radialGradient>`,
      `<radialGradient id="${P}Pink" gradientUnits="userSpaceOnUse" cx="205" cy="322" r="135"><stop offset="0" stop-color="${pal.glow[0]}"/><stop offset="0.6" stop-color="${pal.glow[1]}" stop-opacity="0.7"/><stop offset="1" stop-color="${pal.glow[2]}" stop-opacity="0"/></radialGradient>`,
      `<linearGradient id="${P}Lilac" gradientUnits="userSpaceOnUse" x1="0" y1="200" x2="0" y2="330"><stop offset="0" stop-color="${pal.tint}" stop-opacity="0"/><stop offset="1" stop-color="${pal.tint}" stop-opacity="0.55"/></linearGradient>`,
      `<radialGradient id="${P}EyeWhite" cx="0.42" cy="0.35" r="0.75"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.75" stop-color="#F3F6FC"/><stop offset="1" stop-color="#DCE3F1"/></radialGradient>`,
      `<radialGradient id="${P}Pupil" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#2E3A5E"/><stop offset="1" stop-color="#0B0F1F"/></radialGradient>`,
      blur(`${P}BlurXL`, 18), blur(`${P}BlurL`, 12), blur(`${P}BlurM`, 6), blur(`${P}BlurS`, 2.5),
      `<radialGradient id="${P}RimDark" cx="0.5" cy="0.36" r="0.64"><stop offset="0.7" stop-color="${pal.rim}" stop-opacity="0"/><stop offset="1" stop-color="${pal.rim}" stop-opacity="0.42"/></radialGradient>`,
      `<radialGradient id="${P}RimLight" cx="0.5" cy="0.66" r="0.66"><stop offset="0.74" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.5"/></radialGradient>`,
      `<radialGradient id="${P}Sheen" gradientUnits="userSpaceOnUse" cx="150" cy="146" r="74"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.4"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`,
      `<linearGradient id="${P}EyeRim" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="${pal.white}" stop-opacity="0"/><stop offset="1" stop-color="${pal.white}" stop-opacity="0.8"/></linearGradient>`,
    ].join('');

    // Every layer of shading is a fill of the outline itself (Creator drops SVG masks): the lilac
    // tint low down, the pink glow, a darker inner rim toward the bottom, a light rim toward the top,
    // and a soft sheen up on the left (a gradient spot, so nothing spills past the edge).
    // The pink glow is its own layer (between the tint and the rims) so the rig can make it breathe.
    const body = `<path d="${OUTLINE}" fill="url(#${P}Base)"/>` +
      `<path d="${OUTLINE}" fill="url(#${P}Lilac)"/>`;
    const glowBody = cfg.glow ? `<path d="${OUTLINE}" fill="url(#${P}Pink)"/>` : '';
    const shadeBody = `<path d="${OUTLINE}" fill="url(#${P}RimDark)"/>` +
      `<path d="${OUTLINE}" fill="url(#${P}RimLight)"/>` +
      `<path d="${OUTLINE}" fill="url(#${P}Sheen)"/>`;

    // The eye's outline as a polygon (ellipse, or the pill's capsule), for clipping lids to it.
    const eyePoly = (side) => { const { x, y } = eyes[side]; return pill ? samplePath(eyeShape(side).match(/d="([^"]+)"/)[1])[0] : ellipsePoly(x, y, EYE.rx, EYE.ry); };
    const lid = (side, dd) => `<path d="${clipD(dd, eyePoly(side))}" fill="url(#${P}Base)"/>`;
    const eyeState = (side, state) => {
      const { x, y } = eyes[side];
      if (noEyes) return blank(x, y);
      const rim = `${eyeShape(side)} fill="none" stroke="#FFFFFF" stroke-opacity="0.7" stroke-width="1.5"/>`;
      const line = (dd) => `<path d="${dd}" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
      const halfLid = lid(side, `M${x - 30},${y - 34} L${x + 30},${y - 34} L${x + 30},${y + 1} L${x - 30},${y + 1} Z`) +
        `<path d="M${x - EYE.rx + 1},${y + 1} L${x + EYE.rx - 1},${y + 1}" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;
      if (state === 'open') {
        if (cfg.eyes === 'sleepy') return lid(side, `M${x - 30},${y - 34} L${x + 30},${y - 34} L${x + 30},${y - 8} L${x - 30},${y - 8} Z`) + line(`M${x - EYE.rx + 2},${y - 8} L${x + EYE.rx - 2},${y - 8}`);
        if (cfg.eyes === 'droopy') {
          // A heavy lid in the body colour, drooping toward the outer corner, with a soft edge.
          const o = side === 'L' ? -1 : 1; // outer direction
          const edge = `M${x - o * 30},${y - 6} Q${x},${y - 10} ${x + o * 30},${y + 6}`;
          return lid(side, `M${x - 32},${y - 36} L${x + 32},${y - 36} ${side === 'L' ? `L${x + 32},${y - 6} Q${x},${y - 10} ${x - 32},${y + 6}` : `L${x + 32},${y + 6} Q${x},${y - 10} ${x - 32},${y - 6}`} Z`) +
            // The lid's soft edge, kept inside the eye.
            `<path d="${(() => { const poly = eyePoly(side); const pts = samplePath(edge, 2)[0].filter(([px, py]) => clipConvex([[px, py], [px + 0.01, py], [px, py + 0.01]], poly).length); return pts.length > 1 ? `M${pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')}` : 'M0,0'; })()}" fill="none" stroke="${pal.rim}" stroke-opacity="0.55" stroke-width="4" stroke-linecap="round"/>`;
        }
        if (beads) return `${eyeShape(side)} fill="none" stroke="#FFFFFF" stroke-opacity="0"/>`; // nothing over a bead
        return rim;
      }
      if (state === 'half') return halfLid;
      // Shut eyes are a bold line on the body (the rig hides the eye white while shut).
      const bold = (dd) => `<path d="${dd}" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;
      if (state === 'closed') return bold(`M${x - 16},${y + 2} Q${x},${y + 12} ${x + 16},${y + 2}`);
      return bold(`M${x - 16},${y + 6} Q${x},${y - 8} ${x + 16},${y + 6}`);
    };

    const MX = 201;
    // The mouth sits halfway between its old line (y 276) and the bottom of the eyes.
    const MY = Math.round(276 - (276 - (220 + EYE.ry)) / 2);
    // The mouth carries lip sync, so it's drawn big enough to read at small sizes: 1.6× the old size
    // by default, 2.1× for Big; Wide is wider still. Strokes thicken with it.
    const base = cfg.mouth === 'big' ? 2.1 : 1.6;
    const mk = base * (cfg.mouth === 'wide' ? 1.25 : 1);
    const strokeM = (dd, w = 4.5) => `<path d="${dd}" fill="none" stroke="${MOUTH}" stroke-width="${n(w * (0.55 + base * 0.3))}" stroke-linecap="round"/>`;
    const open = (w0, h0, { teeth = false, tongue = true } = {}) => {
      const w = w0 * mk, h = h0 * mk;
      const l = MX - w / 2, r = MX + w / 2;
      const dd = `M${l},${MY} Q${MX},${MY - h * 0.12} ${r},${MY} C${r},${MY + h * 0.75} ${MX + w * 0.3},${MY + h} ${MX},${MY + h} C${MX - w * 0.3},${MY + h} ${l},${MY + h * 0.75} ${l},${MY} Z`;
      let out = `<path d="${dd}" fill="${MOUTH}"/>`;
      if (tongue && h > 12) out += `<ellipse cx="${MX}" cy="${n(MY + h * 0.8)}" rx="${n(w * 0.26)}" ry="${n(h * 0.18)}" fill="${TONGUE}"/>`;
      if (teeth) out += `<path d="M${l + 4},${MY + 0.5} Q${MX},${MY - h * 0.1} ${r - 4},${MY + 0.5} L${r - 6},${n(MY + h * 0.38)} Q${MX},${n(MY + h * 0.3)} ${l + 6},${n(MY + h * 0.38)} Z" fill="#FFFFFF"/>`;
      return out;
    };
    const round = (rx0, ry0) => {
      const rx = rx0 * mk, ry = ry0 * mk;
      return `<ellipse cx="${MX}" cy="${MY + ry - 2}" rx="${rx}" ry="${ry}" fill="${MOUTH}"/><ellipse cx="${MX}" cy="${n(MY + ry * 1.45)}" rx="${n(rx * 0.55)}" ry="${n(ry * 0.35)}" fill="${TONGUE}"/>`;
    };
    const wm = (v) => v * mk;
    const mouthArt = {
      REST: cfg.mouth === 'cat'
        ? strokeM(`M${n(MX - 14 * base)},${MY} Q${n(MX - 7 * base)},${n(MY + 9 * base)} ${MX},${n(MY + base)} Q${n(MX + 7 * base)},${n(MY + 9 * base)} ${n(MX + 14 * base)},${MY}`)
        : strokeM(`M${MX - wm(13)},${MY} Q${MX},${MY + 9} ${MX + wm(13)},${MY}`),
      MBP: strokeM(`M${MX - wm(12)},${MY + 3} Q${MX},${MY + 6} ${MX + wm(12)},${MY + 3}`, 5),
      A: open(30, 26),
      E: open(32, 15),
      I: open(34, 12, { teeth: true, tongue: false }),
      O: round(11, 13),
      U: round(7, 8),
      FV: open(26, 9, { teeth: true, tongue: false }),
      SMILE: cfg.mouth === 'cat'
        ? strokeM(`M${n(MX - 18 * base)},${n(MY - 2 * base)} Q${n(MX - 9 * base)},${n(MY + 12 * base)} ${MX},${n(MY + 2 * base)} Q${n(MX + 9 * base)},${n(MY + 12 * base)} ${n(MX + 18 * base)},${n(MY - 2 * base)}`)
        : strokeM(`M${MX - wm(18)},${MY - 2} Q${MX},${MY + 15} ${MX + wm(18)},${MY - 2}`),
      LAUGH: open(42, 32),
      FROWN: strokeM(`M${MX - wm(12)},${MY + 7} Q${MX},${MY - 2} ${MX + wm(12)},${MY + 7}`),
    };

    const parts = [
      { id: 'shadow', name: 'Shadow', role: 'static', group: 'body', depth: 0, body: `<ellipse cx="205" cy="402" rx="118" ry="14" fill="${pal.shadow}" fill-opacity="0.28" filter="url(#${P}BlurL)"/>` },
    ];
    // Extras that sit behind the head (antenna stalk).
    const accent = cfg.extraColor || '#2A2A2A';
    const top = SHAPE_TOP[cfg.shape] ?? 80;
    if (extras.has('antenna')) {
      defs += `<radialGradient id="${P}AntennaSheen" cx="0.38" cy="0.3" r="0.62"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`;
      parts.push({
        id: 'antenna', name: 'Antenna', role: 'static', group: 'head', depth: -0.3, spring: { pivot: { x: 200, y: top + 20 }, k: 1.6 }, // wobbles from its base
        // From the Figma "Extras · Antenna" frame: a curved stalk and a coral ball with a soft sheen.
        body: `<path d="M200,${top + 20} C196,${top - 2.7} 200.7,${top - 22.7} 214,${top - 40}" fill="none" stroke="${darken(pal.base[2], 0.25)}" stroke-width="5" stroke-linecap="round"/>` +
          `<circle cx="215" cy="${top - 44}" r="11" fill="#FA7373"/><circle cx="215" cy="${top - 44}" r="11" fill="url(#${P}AntennaSheen)"/>`,
      });
    }
    parts.push({ id: 'face', name: 'Face', role: 'static', group: 'head', depth: 0, squash: true, body });
    if (glowBody) parts.push({ id: 'glow', name: 'Glow', role: 'glow', group: 'head', depth: 0, squash: true, body: glowBody });
    parts.push({ id: 'shade', name: 'Shading', role: 'static', group: 'head', depth: 0, squash: true, body: shadeBody });
    if (extras.has('blush')) {
      parts.push({
        id: 'cheeks', name: 'Cheeks', role: 'static', group: 'head', depth: 0.6,
        body: `<ellipse cx="134" cy="262" rx="20" ry="11" fill="#FF6FA8" fill-opacity="0.45" filter="url(#${P}BlurS)"/><ellipse cx="268" cy="262" rx="20" ry="11" fill="#FF6FA8" fill-opacity="0.45" filter="url(#${P}BlurS)"/>`,
      });
    }
    for (const side of ['L', 'R']) {
      const { x, y } = eyes[side];
      parts.push({
        id: `eye-white-${side}`, name: `Eye White ${side}`, role: 'eyeWhite', side, group: 'head', depth: 0.7,
        body: noEyes ? blank(x, y) : beads
          // A bead sits in a soft dimple; there's no white.
          ? `<ellipse cx="${x}" cy="${y + 4}" rx="${EYE.rx + 4}" ry="${EYE.ry + 3}" fill="${pal.socket}" fill-opacity="0.18" filter="url(#${P}BlurM)"/>`
          : `<ellipse cx="${x}" cy="${y + 6}" rx="${EYE.rx + 3}" ry="${EYE.ry + 2}" fill="${pal.socket}" fill-opacity="0.32" filter="url(#${P}BlurM)"/>` +
            `${eyeShape(side)} fill="url(#${P}EyeWhite)"/>` +
            `${eyeShape(side)} fill="url(#${P}EyeRim)"/>`, // light caught low in the eye
      });
      const ik = EYE.rx / 22;
      const iris = pill
        ? `${eyeShape(side)} fill="#0E0E12"/><ellipse cx="${x - 5}" cy="${y - EYE.ry + 14}" rx="3.5" ry="6" fill="#FFFFFF" fill-opacity="0.18"/>`
        : beads
        ? `${eyeShape(side)} fill="#16161C"/><ellipse cx="${x - 3}" cy="${y - 5}" rx="3" ry="3.8" fill="#FFFFFF" fill-opacity="0.9"/>`
        : cfg.eyes === 'googly'
          // Big solid pupils, a little low, like a toy's.
          ? `<ellipse cx="${x + 1}" cy="${y + 5}" rx="14" ry="18" fill="#141416"/><ellipse cx="${x - 4}" cy="${y - 3}" rx="3.4" ry="4.2" fill="#FFFFFF" fill-opacity="0.85"/>`
          : `<ellipse cx="${x + 1}" cy="${y + 3}" rx="${n(11 * ik)}" ry="${n(15 * Math.min(ik, EYE.ry / 28))}" fill="url(#${P}Pupil)"/>` +
            `<ellipse cx="${x - 3}" cy="${y - 4}" rx="3.6" ry="4.4" fill="#FFFFFF" fill-opacity="0.95"/>` +
            `<circle cx="${x + 5}" cy="${y + 9}" r="1.6" fill="#FFFFFF" fill-opacity="0.6"/>`;
      parts.push({ id: `iris-${side}`, name: `Iris ${side}`, role: 'iris', side, group: 'head', depth: 0.7, body: noEyes ? blank(x, y) : iris });
      for (const state of EYE_STATES) {
        parts.push({ id: `eye-${side}-${state}`, name: `Eye ${side}${stateName(state)}`, role: 'eye', side, state, group: 'head', depth: 0.7, body: eyeState(side, state) });
      }
    }
    for (const side of noEyes || cfg.brows === 'none' ? [] : ['L', 'R']) { // optional; no eyes, no brows
      const { x, y } = eyes[side];
      const dir = side === 'L' ? -1 : 1;
      parts.push({
        id: `brow-${side}`, name: `Brow ${side}`, role: 'brow', side, group: 'head', depth: 0.75,
        body: `<path d="M${x - dir * 12},${y - 40} Q${x + dir * 2},${y - 46} ${x + dir * 14},${y - 41}" fill="none" stroke="${pal.brow}" stroke-opacity="0.5" stroke-width="5" stroke-linecap="round" filter="url(#${P}BlurS)"/>`,
      });
    }
    for (const key of MOUTH_KEYS) {
      parts.push({ id: `mouth-${key}`, name: mouthName(key), role: 'mouth', key, group: 'head', depth: 0.6, body: noMouth ? blank(MX, MY) : mouthArt[key] });
    }
    if (extras.has('glasses')) {
      parts.push({
        id: 'glasses', name: 'Glasses', role: 'static', group: 'head', depth: 0.85,
        body: ['L', 'R'].map((side) => `<ellipse cx="${eyes[side].x}" cy="${eyes[side].y}" rx="${EYE.rx + 12}" ry="${EYE.ry + 10}" fill="#FFFFFF" fill-opacity="0.1" stroke="${accent}" stroke-width="5"/>`).join('') +
          `<path d="M${eyes.L.x + EYE.rx + 10},${eyes.L.y - 4} Q201,${eyes.L.y - 12} ${eyes.R.x - EYE.rx - 10},${eyes.R.y - 4}" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>`,
      });
    }
    if (extras.has('bow')) {
      // From the Figma "Extras · Bow" design: tilted loops with a soft shade and a top sheen,
      // and a round knot with a glint, drawn at the design's spot (261.6, 95.2) and moved onto this shape.
      const bx = 262, by = top + 16;
      defs += [`<radialGradient id="${P}BowShade" gradientUnits="userSpaceOnUse" cx="262.9" cy="94.8" r="24"><stop offset="0" stop-color="#2A2A2A"/><stop offset="1" stop-color="#2A2A2A" stop-opacity="0"/></radialGradient>`,
        `<linearGradient id="${P}BowSheen" gradientUnits="userSpaceOnUse" x1="269.2" y1="71.5" x2="257.7" y2="94.5"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`,
        `<radialGradient id="${P}BowKnot" gradientUnits="userSpaceOnUse" cx="272.5" cy="85.5" r="18.4"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`].join('');
      const LOOPS = 'M261.6,95.2 C234.3,8.6 184.9,129.4 261.6,95.2 C341.4,49.6 295.1,183.6 261.6,95.2 Z';
      const KNOT = 'M256.8,111.8 C265.9,114.2 275.2,108.8 277.7,99.8 C280.1,90.7 274.7,81.4 265.7,78.9 C256.6,76.5 247.3,81.9 244.8,90.9 C242.4,100 247.8,109.3 256.8,111.8 Z';
      parts.push({
        id: 'bow', name: 'Bow', role: 'static', group: 'head', depth: 0.4, spring: { pivot: { x: bx, y: by }, k: 1.2 }, // swings from its knot
        body: `<g transform="translate(${(bx - 261.6).toFixed(1)} ${(by - 95.2).toFixed(1)})">` +
          `<path d="${LOOPS}" fill="${accent}"/><path d="${LOOPS}" fill="url(#${P}BowShade)" fill-opacity="0.32"/><path d="${LOOPS}" fill="url(#${P}BowSheen)" fill-opacity="0.64"/>` +
          `<path d="${KNOT}" fill="${accent}"/><path d="${KNOT}" fill="url(#${P}BowKnot)"/></g>`,
      });
    }

    const turned = withTurnViews(parts, {
      radius: 118,
      features: { L: eyes.L.x, R: eyes.R.x, nose: MX, mouth: MX },
      profileEye: { dx: 74, k: 0.5 },
      profileMouth: { dx: 86, k: 0.45 },
      // In ¾ a soft highlight slides toward the turn, so the body reads as a ball rotating, not
      // features sliding over a flat shape (it sits well inside the outline, so no edge shows).
      quarter: { face: (_, p) => p.body, glow: (_, p) => p.body, antenna: (_, p) => p.body, bow: (_, p) => p.body,
        shade: (ctx, p) => p.body + `<ellipse cx="${200 + ctx.dir * 46}" cy="196" rx="58" ry="44" fill="#FFFFFF" fill-opacity="0.16" filter="url(#${P}BlurL)"/>` },
      profile: { face: (_, p) => p.body, glow: (_, p) => p.body, shade: (_, p) => p.body, antenna: (_, p) => p.body, bow: (_, p) => p.body },
    });

    const pivot = { x: 200, y: 368 };
    return {
      id: cfg.id,
      name: cfg.name,
      size: { width: W, height: H },
      pivot,
      eyes,
      gaze: { x: 4, y: 3 },
      shutHidesEyes: true,
      squashTalk: true, // the soft body squashes and stretches as it talks (see Rig)
      socket: null,
      iris: { r: 11 },
      mouth: { x: MX, y: MY + Math.round(8 * base) },
      faceHalfWidth: 150,
      turn: 0.5,
      thumb: alignThumb(thumbFor(extras.has('antenna') ? top - 58 : top, pivot), eyes.L.y, 0.92), // room for the antenna ball; eyes on the shared line
      thumbBg: cfg.thumbBg,
      turnViews: turned.turnViews,
      defs,
      parts: turned.parts,
      ...(options.kit ? { kit: options.kit } : {}),
    };
  }

  // ======================================================================
  //  Flat (Kai's base)
  // ======================================================================

  /**
   * Kai's flat, geometric look: solid fills, sleepy eyes, a skin ring around each
   * eye for gaze. The drawing code is shared by every option; `flat(cfg)` turns
   * builder options into the colours and styles it reads.
   */
  const Flat = (() => {
  // (Shared with scripts/characters.mjs — kept unindented so template strings match it exactly.)
const W = 400;
const H = 500;
const EYE_Y = 176;
const EYES = { L: 166, R: 234 };
const BROW_Y = 146;
const BROW_Y_BASE = BROW_Y;
const MOUTH_Y = 229;
// Big enough to hide the iris at full gaze (9 px radius + 5 px travel), small
// enough to stay inside the face outline on strong head turns.
const SOCKET = { rx: 22, ry: 16 };
// ¾ views: the eye (and its iris) is narrowed, so a tighter ring still hides the
// iris and keeps the far eye's ring inside the head outline.
const SOCKET_3Q = { rx: 17, ry: 15 };

// ------------------------------------------------------------------ palette

// Mouth shapes: the 8 visemes plus expression mouths (smile, laugh, frown).
const MOUTH_KEYS = ['REST', 'MBP', 'A', 'E', 'I', 'O', 'U', 'FV', 'SMILE', 'LAUGH', 'FROWN'];
// Eye states: blink stages plus "happy" (squeezed arcs while laughing).
const EYE_STATES = ['open', 'half', 'closed', 'happy'];
const mouthName = (key) => (key === 'REST' ? 'Mouth Rest' : key.length > 3 ? `Mouth ${key[0]}${key.slice(1).toLowerCase()}` : `Mouth ${key}`);
const stateName = (state) => (state === 'open' ? '' : ` ${state[0].toUpperCase()}${state.slice(1)}`);

// ------------------------------------------------------------------ helpers

const stroke = (color, width, extra = '') =>
  `fill="none" ${strokeAttrs(color, width, extra)}`;
/** Stroke attributes only, for shapes that also carry their own fill. */
function strokeAttrs(color, width, extra = '') {
  return `stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}`;
}

function defs(c) {
  const id = c.id;
  return `
    <radialGradient id="${id}-skin" gradientUnits="userSpaceOnUse" cx="200" cy="146" r="132">
      <stop offset="0" stop-color="${c.skinLight}"/><stop offset="1" stop-color="${c.skin}"/>
    </radialGradient>
    <radialGradient id="${id}-iris" cx="0.5" cy="0.4" r="0.6">
      <stop offset="0" stop-color="${c.iris}" stop-opacity="0.75"/><stop offset="0.75" stop-color="${c.iris}"/><stop offset="1" stop-color="#1C120D"/>
    </radialGradient>
    <linearGradient id="${id}-hair" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.hairLight}"/><stop offset="0.6" stop-color="${c.hair}"/>
    </linearGradient>
    <linearGradient id="${id}-fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.hair}"/><stop offset="1" stop-color="${c.hair}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${id}-cloth" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.cloth}"/><stop offset="1" stop-color="${c.clothDark}"/>
    </linearGradient>
`;
}

const SQUARE_FACE = 'M156,90 L244,90 C264,90 281,107 281,127 L281,236 C281,257 264,274 244,274 L156,274 C136,274 119,257 119,236 L119,127 C119,107 136,90 156,90 Z';

// The face is the same for both builds: square, or the oval (body type changes the body, hair and
// brows, not the head).
const OVAL_FACE = 'M200,70 C252,70 281,104 282,158 C283,204 267,239 241,255 C227,264 213,268 200,268 C187,268 173,264 159,255 C133,239 117,204 118,158 C119,104 148,70 200,70 Z';
const facePath = (c) => (c.faceShape === 'square' ? SQUARE_FACE : OVAL_FACE);

// ------------------------------------------------------------------ body

/**
 * The neck is its own layer, rigged like a real neck (see Rig, role 'neck'): its
 * base stays planted in the collar while its top follows the chin, so it bends
 * and stretches between them instead of sliding out from under the jaw. It runs
 * well up under the chin and down behind the shirt so neither end ever shows.
 * A turtleneck's collar wraps the neck, so it is drawn here, not on the body.
 */
function neck(c) {
  const [l, r] = c.build === 'woman' ? [176, 224] : [171, 229]; // a slimmer neck on the female build
  const skin = `<path d="M${l},232 L${l},340 L${r},340 L${r},232 Z" fill="${c.skin}"/>
    <path d="M${l},246 Q200,286 ${r},246 L${r},266 Q200,302 ${l},266 Z" fill="${c.skinShadow}" opacity="0.75"/>`;
  if (c.outfit !== 'turtleneck') return skin;
  return `${skin}<path d="M164,264 L236,264 L236,340 L164,340 Z" fill="${c.clothDark}"/>
    <path d="M166,270 Q200,276 234,270" ${stroke(c.cloth, 2, 'opacity="0.5"')}/>`;
}

// Male: broad, square shoulders. Female: narrower, softer shoulders that slope down and taper in a
// little toward the waist (the neckline is the same, so every outfit's collar still fits).
const TORSO = {
  man: 'M48,500 L48,404 C48,350 84,318 138,304 L170,296 Q200,312 230,296 L262,304 C316,318 352,350 352,404 L352,500 Z',
  woman: 'M74,500 C70,466 72,436 76,410 C82,362 106,330 148,312 L172,298 Q200,312 228,298 L252,312 C294,330 318,362 324,410 C328,436 330,466 326,500 Z',
};

function body(c) {
  const woman = c.build === 'woman';
  const torso = TORSO[woman ? 'woman' : 'man'];
  const seams = woman
    ? `<path d="M118,360 C110,398 108,446 112,500" ${stroke(c.clothDark, 3, 'opacity="0.55"')}/>
    <path d="M282,360 C290,398 292,446 288,500" ${stroke(c.clothDark, 3, 'opacity="0.55"')}/>`
    : `<path d="M104,352 C96,392 94,446 96,500" ${stroke(c.clothDark, 3, 'opacity="0.55"')}/>
    <path d="M296,352 C304,392 306,446 304,500" ${stroke(c.clothDark, 3, 'opacity="0.55"')}/>`;

  let outfit = '';
  // Matched to the Figma sheet "Kai · Flat outfits": an undershirt panel under open fronts,
  // a soft rim light on the sweater's neckline, and a bare-skin V / scoop on the others.
  const inner = `<path d="M239.1,298.3 L223.2,500 L176.8,500 L160.9,298.3 L170,296 C190,306.7 210,306.7 230,296 Z" fill="${c.inner}"/>`;
  switch (c.outfit) {
    case 'bomber':
      outfit = `<path d="${torso}" fill="url(#${c.id}-cloth)"/>
        <path d="${woman ? 'M73,470 L327,470 L327,500 L74,500 Z' : 'M52,470 L348,470 L348,500 L52,500 Z'}" fill="${c.clothDark}" opacity="0.6"/>
        ${inner}
        <path d="M169.7,296.1 L160.9,298.3 L163,330.6 C151.2,324 143,314.3 140.7,303.2 Z M259.3,303.4 C256.9,314.4 248.7,324 237,330.6 L239.1,298.4 Z M229.8,296.1 C219.8,301.4 209.8,304 199.7,304 C209.7,304 219.6,301.3 229.5,296 Z" fill="${c.clothDark}"/>
        <path d="M169.7,296.1 L160.9,298.3 L163,330.6 C151.2,324 143,314.3 140.7,303.2 Z M259.3,303.4 C256.9,314.4 248.7,324 237,330.6 L239.1,298.4 Z M229.8,296.1 C219.8,301.4 209.8,304 199.7,304 C209.7,304 219.6,301.3 229.5,296 Z" fill="#FFFFFF" fill-opacity="0.32"/>`;
      break;
    case 'sweater': {
      // The sweater's neckline dips into a soft V around the shirt collar.
      const dipped = woman
        ? torso.replace('L172,298 Q200,312 228,298', 'L172,298 C181,303 190,318.9 200,319.1 C210,319.3 219,303 228,298')
        : torso.replace('L170,296 Q200,312 230,296', 'L170,296 C179.6,301.1 189.8,318.9 199.4,319.1 C209.8,319.4 219.6,301.6 230,296');
      outfit = `<path d="${dipped}" fill="url(#${c.id}-cloth)"/>
        <path d="M250.7,301.2 C216.9,337.6 183.1,337.6 149.3,301.2 L156.8,299.3 C185.6,325.9 214.4,325.9 243.2,299.3 Z" fill="#FFFFFF" fill-opacity="0.32"/>
        <path d="M171,284.8 L200,319.8 L182,331.8 L156.9,299.1 Z M229,284.8 L200,319.8 L218,331.8 L243.1,299.1 Z" fill="${c.inner}"/>
        <path d="M120,440 L120,500 M280,440 L280,500" ${stroke(c.clothDark, 2, 'opacity="0.4"')}/>`;
      break;
    }
    case 'blouse':
      outfit = `<path d="${torso}" fill="url(#${c.id}-cloth)"/>
        <path d="M166,297.4 C166,297.4 156.9,351.6 200,351.6 C243.1,351.6 234,297.4 234,297.4 L228.1,293.5 L171.9,294.8 Z" fill="${c.skin}"/>
        <path d="M168.8,296 C173.8,345.4 228.1,341 231.3,296" ${stroke(c.inner, 2)}/>
        <circle cx="200" cy="336" r="4" fill="${c.inner}"/>`;
      break;
    case 'vneck':
      outfit = `<path d="${torso}" fill="url(#${c.id}-cloth)"/>
        <path d="M166,298 L200,377.9 L234,298 L228.1,294.1 L171.9,295.4 Z" fill="${c.skin}"/>`;
      break;
    case 'cardigan':
      outfit = `<path d="${torso}" fill="${c.cloth}"/>
        ${inner}`;
      break;
    case 'turtleneck':
      // The rolled collar itself is part of the neck layer (it moves with the neck).
      outfit = `<path d="${torso}" fill="${c.cloth}"/>
        <path d="M168,300 Q200,312 232,300" ${stroke(c.clothDark, 3, 'opacity="0.6"')}/>`;
      break;
    default:
      outfit = `<path d="${torso}" fill="url(#${c.id}-cloth)"/>${seams}`;
  }
  return outfit;
}

// ------------------------------------------------------------------ head

function ears(c) {
  if (c.hairStyle === 'hijab') return ''; // the scarf covers them
  if (c.earDots) {
    return [114, 286].map((x) => `<circle cx="${x}" cy="196" r="20" fill="${c.skin}"/><circle cx="${x + (x < 200 ? -3 : 3)}" cy="200" r="5.5" fill="${c.skinShadow}"/>`).join('');
  }
  return [121, 279]
    .map((x) => `<ellipse cx="${x}" cy="180" rx="13" ry="21" fill="${c.skin}"/>
      <path d="M${x + (x < 200 ? 4 : -4)},170 Q${x + (x < 200 ? -4 : 4)},180 ${x + (x < 200 ? 3 : -3)},192" ${stroke(c.skinShadow, 3)}/>`)
    .join('');
}

function earrings(c, only = null) {
  if (c.hairStyle === 'hijab') return '';
  // Dot ears hang lower and wider than drawn ones. `only` ('L' or 'R') draws one ear's.
  const pick = (xs) => (only === 'L' ? [xs[0]] : only === 'R' ? [xs[1]] : xs);
  const hoops = c.hoops ? pick(c.earDots ? [114, 286] : [121, 279]).map((x) => `<circle cx="${x}" cy="${c.earDots ? 226 : 214}" r="15" ${stroke(HOOP, 6)}/>`).join('') : '';
  if (!c.earrings) return hoops;
  return hoops + pick([121, 279]).map((x) => `<circle cx="${x}" cy="208" r="9" ${stroke('#E8B23A', 3)}/>`).join('');
}
/** Where an earring hangs from (its lobe), so it can swing from there. */
const earLobe = (c, side) => ({ x: (side === 'L' ? 0 : 1) * (c.earDots ? 172 : 158) + (c.earDots ? 114 : 121), y: c.earDots ? 210 : 198 });

const HOOP = '#F2B630';

/** A mustache over the upper lip; it sits above the mouth so open shapes tuck under it. */
function mustache(c) {
  if (!c.mustache) return '';
  // Set a little higher and smaller than the lip line, so closed mouths (rest, M/B/P) still show under it.
  const y = MOUTH_Y - 14;
  return `<path transform="translate(200 ${y + 3}) scale(0.85) translate(-200 ${-(y + 3)})" d="M164,${y + 2} C170,${y - 12} 190,${y - 12} 200,${y - 4} C210,${y - 12} 230,${y - 12} 236,${y + 2} C240,${y + 14} 226,${y + 18} 214,${y + 12} C208,${y + 8} 204,${y + 6} 200,${y + 6} C196,${y + 6} 192,${y + 8} 186,${y + 12} C174,${y + 18} 160,${y + 14} 164,${y + 2} Z" fill="${c.hair}"/>`;
}

function face(c) {
  const tone = c.blush === undefined ? '#FF6F6F' : c.blush;
  const strength = c.blush ? 0.75 : c.build === 'man' ? 0.14 : 0.24;
  const blush = tone ? [150, 250].map((x) => `<ellipse cx="${x}" cy="214" rx="17" ry="${c.blush ? 10 : 9}" fill="${tone}" opacity="${strength}"/>`).join('') : '';
  return `<path d="${facePath(c)}" fill="url(#${c.id}-skin)"/>${blush}`;
}

function nose(c) {
  if (c.noseStyle === 'line') {
    return `<path d="M201,186 Q197,203 192,210 Q197,215 205,212" ${stroke(c.iris, 2.6)}/>`;
  }
  if (c.noseStyle === 'triangle') {
    return `<path d="M200,190 Q205,190 208,197 L214,212 Q216,220 207,221 L193,221 Q184,220 186,212 L192,197 Q195,190 200,190 Z" fill="${c.noseFill}"/>`;
  }
  if (c.noseStyle === 'rect') {
    return `<path d="M194,190 L206,190 Q210,190 210,194 L210,217 Q210,221 206,221 L194,221 Q190,221 190,217 L190,194 Q190,190 194,190 Z" fill="${c.noseFill}"/>`;
  }
  if (c.noseStyle === 'circle') return `<circle cx="200" cy="208" r="12" fill="${c.noseFill}"/>`;
  // Pill (Figma 380-848; stored as 'trapezoid', the style it replaced): a small rounded bar, low on the face.
  if (c.noseStyle === 'trapezoid') return `<rect x="189.3" y="208.7" width="21.4" height="10" rx="5" fill="${c.noseFill}"/>`;
  return `<path d="M200,188 Q197,200 196,206" ${stroke(c.noseFill, 2, 'opacity="0.45"')}/>
    <path d="M192,209 Q200,215 208,209" ${stroke(c.noseFill, 2.6)}/>
    <ellipse cx="203" cy="203" rx="3" ry="2" fill="#FFFFFF" opacity="0.25"/>`;
}

function beard(c) {
  if (!c.beard) return '';
  if (c.faceShape === 'square') {
    // Along the square jaw: down both sides of the face, round the corners, under the chin,
    // with the inner edge framing the mouth.
    return `<path d="M119,178 L119,236 C119,257 136,274 156,274 L244,274 C264,274 281,257 281,236 L281,178 L268,178 C266,212 254,234 234,244 C222,236 212,234 200,236 C188,234 178,236 166,244 C146,234 134,212 132,178 Z" fill="${c.hair}"/>
    <path d="M178,219 Q200,208 222,219 Q213,224 200,221 Q187,224 178,219 Z" fill="${c.hair}"/>`;
  }
  return `<path d="M123,186 C127,236 160,272 200,275 C240,272 273,236 277,186 C270,212 255,236 238,242 C226,234 213,232 200,234 C187,232 174,234 162,242 C145,236 130,212 123,186 Z" fill="${c.hair}"/>
    <path d="M178,219 Q200,208 222,219 Q213,224 200,221 Q187,224 178,219 Z" fill="${c.hair}"/>`;
}

// ------------------------------------------------------------------ eyes

/** A big rounded-rectangle eye (40 × 48), optionally grown by `pad`. */
const bigEye = (x, y, pad = 0) => {
  const l = x - 20 - pad; const r = x + 20 + pad; const t = y - 24 - pad; const b = y + 24 + pad; const k = 16 + pad;
  return `M${l + k},${t} L${r - k},${t} Q${r},${t} ${r},${t + k} L${r},${b - k} Q${r},${b} ${r - k},${b} L${l + k},${b} Q${l},${b} ${l},${b - k} L${l},${t + k} Q${l},${t} ${l + k},${t} Z`;
};

const almond = (x, y) => `M${x - 17},${y} C${x - 11},${y - 12} ${x + 11},${y - 12} ${x + 17},${y} C${x + 11},${y + 10} ${x - 11},${y + 10} ${x - 17},${y} Z`;

function lashFlick(c, x, y, side, dy = 0) {
  if (!c.lashes) return '';
  const dir = side === 'L' ? -1 : 1;
  return `<path d="M${x + dir * 16},${y - 1 + dy} L${x + dir * 22},${y - 6 + dy}" ${stroke(INK, 2.6)}/>`;
}

const INK = '#1E1412';

/** Eye white with a soft shadow where the lid meets it. */
function eyeWhite(c, side) {
  const x = EYES[side];
  const y = EYE_Y;
  if (c.eyeStyle === 'dot') return '';
  if (c.eyeStyle === 'big') return `<path d="${bigEye(x, y)}" fill="#FFFFFF"/>`;
  if (c.eyeStyle === 'sleepy') return `<path d="M${x - 16},${y} A16,16 0 0,0 ${x + 16},${y} Z" fill="#FFFFFF"/>`;
  return `<path d="${almond(x, y)}" fill="#FFFFFF"/>
    <path d="M${x - 16},${y - 1} C${x - 10},${y - 11} ${x + 10},${y - 11} ${x + 16},${y - 1} C${x + 10},${y - 6} ${x - 10},${y - 6} ${x - 16},${y - 1} Z" fill="${c.skinShadow}" opacity="0.35"/>`;
}

/** Iris + pupil + catchlights — this layer moves for gaze. */
function iris(c, side) {
  const x = EYES[side];
  const y = EYE_Y + 1;
  if (c.eyeStyle === 'dot') return `<ellipse cx="${x}" cy="${y}" rx="6.5" ry="8" fill="${c.iris}"/>`;
  if (c.eyeStyle === 'big') return `<ellipse cx="${x}" cy="${y + 2}" rx="10" ry="14" fill="${c.iris}"/><ellipse cx="${x - 3.5}" cy="${y - 5}" rx="3.6" ry="4.4" fill="#FFFFFF"/>`;
  if (c.eyeStyle === 'sleepy') return `<circle cx="${x}" cy="${y + 4}" r="10" fill="${c.iris}"/>`;
  return `<circle cx="${x}" cy="${y}" r="9" fill="url(#${c.id}-iris)"/>
    <circle cx="${x}" cy="${y}" r="4.6" fill="#140C0A"/>
    <circle cx="${x + 3.2}" cy="${y - 3.6}" r="2.6" fill="#FFFFFF"/>
    <circle cx="${x - 3}" cy="${y + 3}" r="1.2" fill="#FFFFFF" opacity="0.8"/>`;
}

/**
 * A skin-coloured ring with an almond hole: it hides whatever part of the
 * iris travels outside the eye, so gaze works without masks or mattes.
 */
function socket(c, side, { rx, ry } = SOCKET) {
  const x = EYES[side];
  const y = EYE_Y;
  if (c.eyeStyle === 'dot' || c.eyeStyle === 'big') return ''; // the iris never leaves the big white
  if (c.eyeStyle === 'sleepy') {
    const ring = `M${x - rx},${y + 1} A${rx},${ry} 0 1,0 ${x + rx},${y + 1} A${rx},${ry} 0 1,0 ${x - rx},${y + 1} Z`;
    return `<path d="${ring} M${x - 16},${y} A16,16 0 0,0 ${x + 16},${y} Z" fill="url(#${c.id}-skin)" fill-rule="evenodd"/>`;
  }
  const ring = `M${x - rx},${y + 1} A${rx},${ry} 0 1,0 ${x + rx},${y + 1} A${rx},${ry} 0 1,0 ${x - rx},${y + 1} Z`;
  return `<path d="${ring} ${almond(x, y)}" fill="url(#${c.id}-skin)" fill-rule="evenodd"/>`;
}

/** An invisible mark: a lid state that draws nothing still needs a layer to switch to. */
const noLid = (x, y) => `<circle cx="${x}" cy="${y}" r="1" fill="#000000" fill-opacity="0"/>`;

/** Lid states drawn over the eye: open (lash line), half (lid down), closed. No eyelid creases. */
function lid(c, side, state) {
  const x = EYES[side];
  const y = EYE_Y;
  if (c.eyeStyle === 'dot') {
    // Dot eyes: open draws nothing over the dot (an invisible placeholder keeps the layer);
    // the lid is a patch of skin plus a line.
    const skin = `url(#${c.id}-skin)`;
    if (state === 'open') return noLid(x, y);
    if (state === 'half') return `<rect x="${x - 11}" y="${y - 11}" width="22" height="12" fill="${skin}"/><path d="M${x - 8},${y + 1} L${x + 8},${y + 1}" ${stroke(c.iris, 2.6)}/>`;
    if (state === 'happy') return `<rect x="${x - 11}" y="${y - 11}" width="22" height="23" fill="${skin}"/><path d="M${x - 8},${y + 3} Q${x},${y - 6} ${x + 8},${y + 3}" ${stroke(c.iris, 2.8)}/>`;
    return `<rect x="${x - 11}" y="${y - 11}" width="22" height="23" fill="${skin}"/><path d="M${x - 8},${y + 1} Q${x},${y + 7} ${x + 8},${y + 1}" ${stroke(c.iris, 2.6)}/>`;
  }
  if (c.eyeStyle === 'big') {
    // Big googly eyes: the lid is a patch of skin cut to the eye's own shape.
    const lidTo = (bottom) => `<path d="M${x - 21},${bottom} L${x - 21},${y - 12} Q${x - 21},${y - 25} ${x - 8},${y - 25} L${x + 8},${y - 25} Q${x + 21},${y - 25} ${x + 21},${y - 12} L${x + 21},${bottom} Z" fill="url(#${c.id}-skin)"/>`;
    if (state === 'open') return noLid(x, y);
    if (state === 'half') return `${lidTo(y)}<path d="M${x - 19},${y} L${x + 19},${y}" ${stroke(c.iris, 3)}/>`;
    if (state === 'happy') return `<path d="${bigEye(x, y, 2)}" fill="url(#${c.id}-skin)"/><path d="M${x - 15},${y + 6} Q${x},${y - 8} ${x + 15},${y + 6}" ${stroke(c.iris, 3.4)}/>`;
    return `<path d="${bigEye(x, y, 2)}" fill="url(#${c.id}-skin)"/><path d="M${x - 15},${y + 2} Q${x},${y + 12} ${x + 15},${y + 2}" ${stroke(c.iris, 3.2)}/>`;
  }
  if (c.eyeStyle === 'sleepy') {
    // Heavy-lidded: the open state is already a relaxed half-lid.
    const cover = (bottom) => `<path d="M${x - 18},${y - 2} L${x + 18},${y - 2} L${x + 18},${bottom} L${x - 18},${bottom} Z" fill="url(#${c.id}-skin)"/>`;
    // "Lidded" eyes add a shaded lid above the eye, kept in every state so blinks don't flash it.
    const patch = c.lidPatch ? `<path d="M${x - 19},${y} L${x - 19},${y - 9} Q${x - 19},${y - 17} ${x - 11},${y - 17} L${x + 11},${y - 17} Q${x + 19},${y - 17} ${x + 19},${y - 9} L${x + 19},${y} Z" fill="${c.skinShadow}" opacity="0.8"/>` : '';
    if (state === 'open') return `${patch}<path d="M${x - 16},${y} L${x + 16},${y}" ${stroke(c.skinShadow, 2, 'opacity="0.7"')}/>`;
    if (state === 'half') return `${cover(y + 7)}${patch}<path d="M${x - 15},${y + 7} L${x + 15},${y + 7}" ${stroke(c.iris, 2.6)}/>`;
    if (state === 'happy') return `${cover(y + 17)}${patch}<path d="M${x - 15},${y + 8} Q${x},${y - 4} ${x + 15},${y + 8}" ${stroke(c.iris, 2.8)}/>`;
    return `${cover(y + 17)}${patch}<path d="M${x - 15},${y + 4} Q${x},${y + 13} ${x + 15},${y + 4}" ${stroke(c.iris, 2.6)}/>`;
  }
  const lower = `<path d="M${x - 11},${y + 8} Q${x},${y + 12} ${x + 11},${y + 8}" ${stroke(c.skinShadow, 1.4, 'opacity="0.6"')}/>`;
  const skin = `url(#${c.id}-skin)`;
  if (state === 'open') {
    return `<path d="M${x - 18},${y + 1} C${x - 11},${y - 13} ${x + 11},${y - 13} ${x + 18},${y - 1}" ${stroke(INK, 3.2)}/>
      ${lower}${lashFlick(c, x, y, side)}`;
  }
  if (state === 'half') {
    return `<path d="M${x - 19},${y + 2} C${x - 11},${y - 14} ${x + 11},${y - 14} ${x + 19},${y - 1} Q${x},${y - 3} ${x - 19},${y + 2} Z" fill="${skin}"/>
      <path d="M${x - 18},${y + 1} Q${x},${y - 3} ${x + 18},${y}" ${stroke(INK, 3.2)}/>
      ${lower}${lashFlick(c, x, y, side, 2)}`;
  }
  if (state === 'happy') {
    // Laughing: the lid covers the eye and the lash line arches up (^ ^).
    return `<path d="${almond(x, y)}" fill="${skin}" stroke="${c.skin}" stroke-width="2.5"/>
    <path d="M${x - 16},${y + 4} Q${x},${y - 10} ${x + 16},${y + 4}" ${stroke(INK, 3.4)}/>
    <path d="M${x - 11},${y + 9} Q${x},${y + 12} ${x + 11},${y + 9}" ${stroke(c.skinShadow, 1.4, 'opacity="0.6"')}/>`;
  }
  // closed: lid covers the eye; a soft downward arc reads as relaxed, not squeezed
  return `<path d="${almond(x, y)}" fill="${skin}" stroke="${c.skin}" stroke-width="2.5"/>
    <path d="M${x - 17},${y + 1} Q${x},${y + 9} ${x + 17},${y + 1}" ${stroke(INK, 3.2)}/>${lashFlick(c, x, y, side, 3)}`;
}

function brow(c, side) {
  if (c.browStyle === 'none') return '';
  const x = EYES[side];
  const dir = side === 'L' ? -1 : 1; // outer direction
  const BROW_Y = c.eyeStyle === 'big' ? 136 : BROW_Y_BASE; // clear of the big eye's top
  // One arch for both styles (Figma "Kai · Flat outfits"); only the weight differs.
  const width = c.browStyle === 'thin' ? 5.3 : 12;
  return `<path d="M${x - dir * 16},${BROW_Y + 3} C${x - dir * 4},${BROW_Y - 3.7} ${x + dir * 7.7},${BROW_Y - 4.3} ${x + dir * 19},${BROW_Y + 1}" ${stroke(c.hair, width)}/>`;
}

/** One lens of each glasses style, centred on an eye; `ink` is the frame colour. */
function lens(c, side) {
  const x = EYES[side];
  if (c.glasses === 'shades') {
    return `<rect x="${x - 32}" y="${EYE_Y - 22}" width="64" height="46" rx="12" fill="#2F3033" ${strokeAttrs(c.accent, 6)}/>
      <path d="M${x + 6},${EYE_Y - 14} L${x - 16},${EYE_Y + 12}" ${stroke('#FFFFFF', 5, 'opacity="0.18"')}/>`;
  }
  if (c.glasses === 'frames') return `<rect x="${x - 30}" y="${EYE_Y - 22}" width="60" height="46" rx="8" fill="#FFFFFF" fill-opacity="0.12" ${strokeAttrs(c.accent, 7)}/>`;
  if (c.glasses === 'round') return `<rect x="${x - 31}" y="${EYE_Y - 26}" width="62" height="56" rx="20" fill="${c.skinShadow}" fill-opacity="0.22" ${strokeAttrs(c.accent, 7)}/>`;
  return `<rect x="${x - 25}" y="${EYE_Y - 18}" width="50" height="36" rx="15" fill="#FFFFFF" fill-opacity="0.12" ${strokeAttrs('#2A211D', 3.4)}/>`;
}
/** Frame metrics per style: lens half-width, bridge and arm widths, arm height, ink. */
function frame(c) {
  if (c.glasses === 'round') return { half: 31, bar: 9, arm: 10, armY: EYE_Y - 18, ink: c.accent, big: true };
  if (c.glasses === 'shades' || c.glasses === 'frames') return { half: c.glasses === 'shades' ? 32 : 30, bar: 8, arm: 8, armY: EYE_Y - 14, ink: c.accent, big: true };
  return { half: 25, bar: 3.4, arm: 3, armY: EYE_Y - 8, ink: '#2A211D', big: false };
}

function glasses(c) {
  if (!c.glasses) return '';
  if (c.glasses === 'shades' || c.glasses === 'frames') {
    const f = frame(c);
    return `${lens(c, 'L')}${lens(c, 'R')}
      <path d="M${EYES.L + f.half},${EYE_Y - 4} L${EYES.R - f.half},${EYE_Y - 4}" ${stroke(f.ink, f.bar)}/>
      <path d="M${EYES.L - f.half},${f.armY} L118,${f.armY - 2} M${EYES.R + f.half},${f.armY} L282,${f.armY - 2}" ${stroke(f.ink, f.arm)}/>
      <circle cx="${EYES.L - f.half + 6}" cy="${f.armY + 2}" r="3" fill="#B8B8B8"/><circle cx="${EYES.R + f.half - 6}" cy="${f.armY + 2}" r="3" fill="#B8B8B8"/>`;
  }
  if (c.glasses === 'round') {
    const ink = c.accent;
    const ring = (x) => `<rect x="${x - 31}" y="${EYE_Y - 26}" width="62" height="56" rx="20" fill="${c.skinShadow}" fill-opacity="0.22" ${strokeAttrs(ink, 7)}/>`;
    return `${ring(EYES.L)}${ring(EYES.R)}
      <path d="M197,${EYE_Y - 4} L203,${EYE_Y - 4}" ${stroke(ink, 9)}/>
      <path d="M135,${EYE_Y - 18} L118,${EYE_Y - 18} M265,${EYE_Y - 18} L282,${EYE_Y - 18}" ${stroke(ink, 10)}/>
      <circle cx="122" cy="${EYE_Y - 18}" r="3" fill="#9C9C9C"/><circle cx="278" cy="${EYE_Y - 18}" r="3" fill="#9C9C9C"/>`;
  }
  const ring = (x) => `<rect x="${x - 25}" y="${EYE_Y - 18}" width="50" height="36" rx="15" fill="#FFFFFF" fill-opacity="0.12" ${strokeAttrs('#2A211D', 3.4)}/>`;
  return `${ring(EYES.L)}${ring(EYES.R)}
    <path d="M190,${EYE_Y - 4} Q200,${EYE_Y - 9} 210,${EYE_Y - 4}" ${stroke('#2A211D', 3.4)}/>
    <path d="M141,${EYE_Y - 8} L124,${EYE_Y - 12} M259,${EYE_Y - 8} L276,${EYE_Y - 12}" ${stroke('#2A211D', 3)}/>
    <path d="M${EYES.L - 16},${EYE_Y - 10} L${EYES.L - 8},${EYE_Y - 14}" ${stroke('#FFFFFF', 2.4, 'opacity="0.55"')}/>`;
}

// ------------------------------------------------------------------ mouths

function mouths(c) {
  const y = MOUTH_Y;
  const inside = '#5A1E28';
  const tongue = '#E77583';
  const line = c.lipLine;
  const lip = c.lips;
  const rest = c.mouthRest === 'smirk'
    ? `<path d="M185,${y - 4} Q194,${y + 9} 215,${y + 4}" ${stroke(line, 5)}/>`
    : c.mouthRest === 'smile'
      ? `<path d="M183,${y - 3} Q200,${y + 11} 217,${y - 3}" ${stroke(line, 2.8)}/>`
      : `<path d="M184,${y - 1} Q200,${y + 7} 216,${y - 1}" ${stroke(line, 3)}/>`;
  return {
    REST: rest,
    MBP: `<path d="M183,${y} Q192,${y - 5} 200,${y - 3} Q208,${y - 5} 217,${y} Q200,${y + 8} 183,${y} Z" fill="${lip}"/>
      <path d="M183,${y} Q200,${y + 3} 217,${y}" ${stroke(line, 2)}/>`,
    A: `<path d="M178,${y - 5} Q200,${y - 11} 222,${y - 5} Q225,${y + 21} 200,${y + 28} Q175,${y + 21} 178,${y - 5} Z" fill="${inside}"/>
      <path d="M182,${y - 4} Q200,${y - 9} 218,${y - 4} L217,${y + 2} Q200,${y} 183,${y + 2} Z" fill="#FFFFFF"/>
      <path d="M186,${y + 21} Q200,${y + 11} 214,${y + 21} Q200,${y + 28} 186,${y + 21} Z" fill="${tongue}"/>
      <path d="M178,${y - 5} Q200,${y - 11} 222,${y - 5} Q225,${y + 21} 200,${y + 28} Q175,${y + 21} 178,${y - 5} Z" ${stroke(line, 2.6)}/>`,
    E: `<path d="M178,${y - 4} Q200,${y - 9} 222,${y - 4} Q218,${y + 12} 200,${y + 14} Q182,${y + 12} 178,${y - 4} Z" fill="${inside}"/>
      <path d="M181,${y - 3.5} Q200,${y - 7.5} 219,${y - 3.5} L218,${y + 3} Q200,${y + 1} 182,${y + 3} Z" fill="#FFFFFF"/>
      <path d="M190,${y + 10} Q200,${y + 6} 210,${y + 10} Q200,${y + 14} 190,${y + 10} Z" fill="${tongue}"/>
      <path d="M178,${y - 4} Q200,${y - 9} 222,${y - 4} Q218,${y + 12} 200,${y + 14} Q182,${y + 12} 178,${y - 4} Z" ${stroke(line, 2.6)}/>`,
    I: `<path d="M175,${y - 3} Q200,${y - 7} 225,${y - 3} Q214,${y + 9} 200,${y + 10} Q186,${y + 9} 175,${y - 3} Z" fill="#FFFFFF"/>
      <path d="M179,${y + 1} Q200,${y + 3} 221,${y + 1}" ${stroke('#D9C9C4', 1.4)}/>
      <path d="M175,${y - 3} Q200,${y - 7} 225,${y - 3} Q214,${y + 9} 200,${y + 10} Q186,${y + 9} 175,${y - 3} Z" ${stroke(line, 2.6)}/>`,
    O: `<ellipse cx="200" cy="${y + 5}" rx="12.5" ry="14.5" fill="${inside}"/>
      <path d="M190,${y - 3} Q200,${y - 8} 210,${y - 3} L209,${y} Q200,${y - 2} 191,${y} Z" fill="#FFFFFF"/>
      <path d="M192,${y + 14} Q200,${y + 8} 208,${y + 14} Q200,${y + 19} 192,${y + 14} Z" fill="${tongue}"/>
      <ellipse cx="200" cy="${y + 5}" rx="12.5" ry="14.5" ${stroke(lip, 3.6)}/>`,
    U: `<ellipse cx="200" cy="${y + 3}" rx="7.5" ry="8" fill="${inside}"/>
      <ellipse cx="200" cy="${y + 3}" rx="7.5" ry="8" ${stroke(lip, 4.4)}/>
      <path d="M190,${y - 1} Q187,${y + 3} 190,${y + 7} M210,${y - 1} Q213,${y + 3} 210,${y + 7}" ${stroke(line, 1.4, 'opacity="0.6"')}/>`,
    FV: `<path d="M185,${y - 3} Q200,${y - 7} 215,${y - 3} L214,${y + 3} Q200,${y + 1} 186,${y + 3} Z" fill="#FFFFFF"/>
      <path d="M182,${y - 3} Q200,${y - 8} 218,${y - 3}" ${stroke(line, 2.6)}/>
      <path d="M184,${y + 4} Q200,${y + 12} 216,${y + 4}" ${stroke(lip, 4.2)}/>`,
    // Expressions
    SMILE: `<path d="M179,${y - 6} Q200,${y + 13} 221,${y - 6}" ${stroke(line, 3.2)}/>`,
    LAUGH: `<path d="M174,${y - 7} Q200,${y - 3} 226,${y - 7} Q225,${y + 25} 200,${y + 30} Q175,${y + 25} 174,${y - 7} Z" fill="${inside}"/>
      <path d="M178,${y - 6} Q200,${y - 2} 222,${y - 6} L221,${y + 2} Q200,${y + 5} 179,${y + 2} Z" fill="#FFFFFF"/>
      <path d="M186,${y + 22} Q200,${y + 11} 214,${y + 22} Q200,${y + 30} 186,${y + 22} Z" fill="${tongue}"/>
      <path d="M174,${y - 7} Q200,${y - 3} 226,${y - 7} Q225,${y + 25} 200,${y + 30} Q175,${y + 25} 174,${y - 7} Z" ${stroke(line, 2.6)}/>`,
    FROWN: `<path d="M184,${y + 6} Q200,${y - 5} 216,${y + 6}" ${stroke(line, 3.2)}/>
      <path d="M194,${y + 9} Q200,${y + 8} 206,${y + 9}" ${stroke(lip, 2, 'opacity="0.5"')}/>`,
  };
}

// ------------------------------------------------------------------ hair

function curlRing(cx, cy, rx, ry, from, to, count, r, fill) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const a = ((from + ((to - from) * i) / (count - 1)) * Math.PI) / 180;
    out += `<circle cx="${(cx + rx * Math.cos(a)).toFixed(1)}" cy="${(cy + ry * Math.sin(a)).toFixed(1)}" r="${r}" fill="${fill}"/>`;
  }
  return out;
}

function hair(c) {
  const h = hairStyle(c);
  // Flat colour only: drop the skin-coloured hairline shading (it reads as a stray outline once turned).
  const front = h.front.replace(new RegExp(`<[^>]*stroke="${c.skinShadow}"[^>]*>`, 'g'), '');
  return { ...h, front: front + headband(c) };
}

// Headwear (the hijab, the baseball cap) takes its own colour, so hair, brows and beard can differ.
const HEADWEAR = ['hijab', 'baseball'];
const wearing = (c) => (HEADWEAR.includes(c.hairStyle) && c.hat ? { ...c, hair: c.hat, hairLight: mix(c.hat, '#FFFFFF', 0.05) } : c);

function hairStyle(c) {
  c = wearing(c);
  const g = `url(#${c.id}-hair)`;
  switch (c.hairStyle) {
    case 'quiff': {
      const fringe = 'M140,122 C168,124 196,116 212,102 C214,110 214,116 210,122 C226,124 240,118 248,108 C262,116 272,130 276,150';
      return {
        back: '',
        front: `<path d="${fringe}" ${stroke(c.skinShadow, 9, 'opacity="0.35" transform="translate(0 5)"')}/>
          <path d="M116,170 C104,100 146,44 204,42 C262,42 300,92 284,170 L276,150 C272,130 262,116 248,108 C240,118 226,124 210,122 C214,116 214,110 212,102 C196,116 168,124 140,122 C130,136 122,152 116,170 Z" fill="${g}"/>
          <path d="M150,84 C176,58 228,52 262,76" ${stroke(c.hairLight, 7, 'opacity="0.9"')}/>
          <path d="M168,70 C190,60 214,58 236,62" ${stroke('#9A6A4C', 2.4, 'opacity="0.55"')}/>
          <path d="M214,100 C228,88 248,90 262,100" ${stroke('#9A6A4C', 2.2, 'opacity="0.45"')}/>`,
      };
    }
    case 'curls':
      return {
        back: '',
        front: `<path d="M134,112 C160,106 240,106 266,112" ${stroke(c.skinShadow, 6, 'opacity="0.2" transform="translate(0 4)"')}/>
          <path d="M120,168 C116,104 150,66 200,64 C250,66 284,104 280,168 C276,140 266,120 252,108 L148,108 C134,120 124,140 120,168 Z" fill="${c.hair}"/>
          ${curlRing(200, 106, 74, 46, 192, 348, 13, 15, c.hair)}
          ${curlRing(200, 100, 54, 34, 205, 335, 8, 12, c.hairLight)}`,
      };
    case 'long':
      return {
        back: `<path d="M110,160 C102,82 152,42 200,42 C248,42 298,82 290,160 C288,240 300,318 318,386 Q268,404 238,364 L162,364 Q132,404 82,386 C100,318 112,240 110,160 Z" fill="${c.hair}"/>`,
        front: `<path d="M124,170 C148,130 174,98 200,70 C226,98 252,130 276,170" ${stroke(c.skinShadow, 9, 'opacity="0.3" transform="translate(0 6)"')}/>
          <path d="M114,182 C104,96 150,44 200,44 C250,44 296,96 286,182 L276,170 C252,130 226,98 200,72 C174,98 148,130 124,170 Z" fill="${g}"/>
          <path d="M122,150 C106,214 110,292 130,352 Q146,372 158,352 C140,300 134,232 142,166 Z" fill="${c.hair}"/>
          <path d="M278,150 C294,214 290,292 270,352 Q254,372 242,352 C260,300 266,232 258,166 Z" fill="${c.hair}"/>
          <path d="M150,84 C164,66 184,56 198,54" ${stroke(c.hairLight, 4, 'opacity="0.9"')}/>
          <path d="M214,58 C236,62 256,76 266,92" ${stroke(c.hairLight, 3, 'opacity="0.7"')}/>
          <path d="M132,196 C126,240 130,290 142,330" ${stroke(c.hairLight, 2.4, 'opacity="0.6"')}/>`,
      };
    case 'puff':
      return {
        back: `${curlRing(200, 74, 74, 40, 150, 390, 16, 30, c.hair)}<ellipse cx="200" cy="80" rx="88" ry="54" fill="${c.hair}"/>
          <path d="M150,52 C170,36 196,32 214,36 M236,40 C252,46 266,56 272,66" ${stroke(c.hairLight, 3.4, 'opacity="0.8"')}/>`,
        front: `<path d="M134,128 C160,112 240,112 266,128" ${stroke(c.skinShadow, 9, 'opacity="0.3" transform="translate(0 6)"')}/>
          <path d="M124,158 C120,96 158,64 200,64 C242,64 280,96 276,158 C264,124 236,108 200,108 C164,108 136,124 124,158 Z" fill="${c.hair}"/>
          <path d="M128,118 Q200,84 272,118 L270,128 Q200,96 130,128 Z" fill="${c.inner}"/>`,
      };
    case 'longSide':
      // Flat long hair, deep side part sweeping across the forehead; ears stay visible.
      return {
        back: `<path d="M106,170 C98,86 148,44 200,44 C252,44 302,86 294,170 C296,250 312,330 332,392 Q300,410 262,392 L250,330 L150,330 L138,392 Q100,410 68,392 C88,330 104,250 106,170 Z" fill="${c.hair}"/>`,
        front: `<path d="M116,176 C106,96 150,50 204,50 C260,50 296,96 284,176 L276,166 C268,124 244,100 208,96 C190,124 158,140 126,148 C121,158 118,166 116,176 Z" fill="${c.hair}"/>`,
      };
    case 'cap': {
      // Short curly cap with faded temples (Kai).
      const fade = `url(#${c.id}-fade)`;
      return {
        back: '',
        front: `<path d="M116,170 L116,126 C116,96 140,72 172,72 L228,72 C260,72 284,96 284,126 L284,170 Q277,174 268,170 L268,112 L132,112 L132,170 Q123,174 116,170 Z" fill="${c.hair}"/>
          ${curlRing(200, 92, 66, 26, 196, 344, 6, 24, c.hair)}
`,
      };
    }
    case 'wavy':
      // Big wavy hair to the shoulders, parted in the middle: it falls away from the part on both
      // sides, framing the forehead in a soft arch.
      return {
        back: `<path d="M200,38 C126,38 86,82 84,150 C82,200 66,228 60,268 C54,308 78,330 72,370 C66,410 50,432 58,500 L342,500 C350,432 334,410 328,370 C322,330 346,308 340,268 C334,228 318,200 316,150 C314,82 274,38 200,38 Z" fill="${c.hair}"/>`,
        front: `<path d="M110,192 C100,100 148,54 200,54 C252,54 300,100 290,192 C282,168 272,148 260,132 C244,112 222,100 203,94 L200,90 L197,94 C178,100 156,112 140,132 C128,148 118,168 110,192 Z" fill="${c.hair}"/>`,
      };
    case 'bob':
      // Blunt bob to the jaw; the fringe sweeps across one side of the forehead.
      return {
        back: `<path d="M98,152 C98,84 144,50 200,50 C256,50 302,84 302,152 L316,300 Q317,312 304,312 L96,312 Q83,312 84,300 Z" fill="${c.hair}"/>`,
        front: `<path d="M110,176 C104,94 148,58 200,58 C254,58 296,94 292,150 C282,118 252,104 206,104 C188,104 172,110 164,122 C152,140 150,196 152,262 L122,262 C114,232 110,204 110,176 Z" fill="${c.hair}"/>`,
      };
    case 'bangs':
      // Long and straight with a blunt fringe just above the brows.
      return {
        back: `<path d="M94,150 C94,78 142,44 200,44 C258,44 306,78 306,150 L314,500 L86,500 Z" fill="${c.hair}"/>`,
        front: `<path d="M106,134 C104,80 148,50 200,50 C252,50 296,80 294,134 Z" fill="${c.hair}"/>
          <path d="M106,128 L126,128 L124,214 L106,220 Z M294,128 L274,128 L276,214 L294,220 Z" fill="${c.hair}"/>`,
      };
    case 'bowl':
      return {
        back: '',
        // The sides come down the temples to the top of the ears, so no skin shows between hair and ear.
        front: `<path d="M111,176 L112,140 C108,92 150,60 200,60 C250,60 292,92 288,140 L289,176 Q282,183 273,180 C270,160 268,142 262,130 C232,120 168,120 138,130 C132,142 130,160 127,180 Q118,183 111,176 Z" fill="${c.hair}"/>`,
      };
    case 'sweep':
      // A tall swept-back wave, higher on one side.
      return {
        back: '',
        front: `<path d="M116,172 L116,122 C116,98 134,84 158,82 C168,58 200,40 238,42 C274,44 294,70 292,104 L286,172 L274,172 L272,128 C238,124 200,118 176,112 C150,116 132,124 130,150 L130,172 Z" fill="${c.hair}"/>`,
      };
    case 'shag':
      // Shoulder-length, flicked out at the ends, with a little top tuft.
      return {
        back: `<path d="M102,140 C102,80 146,48 200,48 C254,48 298,80 298,140 L300,250 C318,258 336,274 338,296 C320,306 300,302 286,292 L114,292 C100,302 80,306 62,296 C64,274 82,258 100,250 Z" fill="${c.hair}"/>`,
        front: `<path d="M112,152 C110,90 150,58 200,58 C250,58 290,90 288,152 L288,126 C252,112 148,112 112,126 Z" fill="${c.hair}"/>
          <path d="M184,62 C178,38 200,24 214,30 C206,38 208,50 216,60 Z" fill="${c.hair}"/>`,
      };
    case 'hijab':
    {
      // A scarf wrapped round the head: it frames the face in a wide, rounded opening (a narrow band
      // over the forehead edge and cheeks, and under the chin), wraps the neck and drapes over the shoulders.
      // Drawn in the headwear colour (see hairStyle), flat with no highlight or fold lines.
      const opening = c.faceShape === 'square'
        ? 'M166,98 L234,98 C260,98 276,114 276,140 L276,226 C276,252 258,268 232,268 L168,268 C142,268 124,252 124,226 L124,140 C124,114 140,98 166,98 Z'
        : 'M200,86 C246,86 276,116 276,164 C276,210 258,244 232,258 C218,266 208,268 200,268 C192,268 182,266 168,258 C142,244 124,210 124,164 C124,116 154,86 200,86 Z';
      return {
        back: `<path d="M200,50 C266,50 314,98 316,170 C318,236 304,286 276,318 L292,380 L108,380 L124,318 C96,286 82,236 84,170 C86,98 134,50 200,50 Z" fill="${c.hair}"/>`,
        front: `<path d="M200,52 C266,52 312,100 314,168 C316,224 304,264 280,288 C258,308 232,316 200,318 C168,316 142,308 120,288 C96,264 84,224 86,168 C88,100 134,52 200,52 Z ${opening}" fill="${c.hair}" fill-rule="evenodd"/>`,
      };
    }
    case 'baseball': {
      // A baseball cap (the hair colour is the cap's): crown, button, seams and a brim.
      const dark = mix(c.hair, '#000000', 0.18);
      return {
        back: '',
        front: `<path d="M116,138 C116,78 154,50 200,50 C246,50 284,78 284,138 Z" fill="${c.hair}"/>
          <circle cx="200" cy="50" r="8" fill="${dark}"/>
          <path d="M162,60 Q150,96 150,136 M238,60 Q250,96 250,136" ${stroke(dark, 7)}/>
          <path d="M104,144 C142,120 258,120 296,144 Q306,151 296,158 C258,136 142,136 104,158 Q94,151 104,144 Z" fill="${dark}"/>`,
      };
    }
    default:
      return { back: '', front: '' };
  }
}

/** A headband across the hairline, drawn over the hair. */
const headband = (c) => (c.headband ? `<path d="M108,112 C150,100 250,100 292,112 L292,132 C250,120 150,120 108,132 Z" fill="${c.accent}"/>` : '');

// ------------------------------------------------------------------ assembly

/**
 * Parts in stacking order (bottom → top). `group` says what moves with the head.
 *
 * `depth` drives the faux-3D turn: when the head yaws or pitches, a part
 * shifts by depth × the turn. Near features (nose) move most, the face plane
 * not at all, and far parts (ears, back hair) the opposite way. `squash`
 * parts narrow slightly as the head turns away from camera.
 */
function parts(c) {
  const h = hair(c);
  const m = mouths(c);
  const list = [];
  // Styles without some pieces (e.g. dot eyes have no white or socket) skip empty parts.
  const add = (part) => { if (part.body && part.body.trim()) list.push({ group: 'head', depth: 0, ...part }); };
  if (h.back) add({ id: 'hair-back', name: 'Hair Back', role: 'static', depth: -0.45, squash: true, body: h.back });
  // Shared by every view (allViews): one neck under whichever head drawing shows.
  // Flat characters draw the neck and body smaller as one unit, scaled about the collar
  // point so they keep their proportions and still meet the chin. The torso's straight
  // lower part (below y 404) is lengthened first so the smaller body still reaches the
  // bottom of the frame.
  const k = c.bodyScale || 1;
  const COLLAR = 296;
  const shrink = (b) => (k === 1 ? b : `<g transform="translate(200 ${COLLAR}) scale(${k}) translate(-200 ${-COLLAR})">${b}</g>`);
  const reach = (H - COLLAR) / k + COLLAR; // where the art must end so it lands on the bottom edge
  const lengthen = (b) => (k === 1 ? b : warpSvg(b, (x, y) => [x, y > 404 ? 404 + ((y - 404) * (reach - 404)) / (H - 404) : y]));
  add({ id: 'neck', name: 'Neck', role: 'neck', group: 'body', allViews: true, body: shrink(neck(c)) });
  const torso = shrink(lengthen(body(c)));
  add({ id: 'body', name: 'Body', role: 'static', group: 'body', body: torso });
  add({ id: 'ears', name: 'Ears', role: 'static', depth: -0.5, body: ears(c) });
  // Each earring is its own layer, swinging on a spring from its lobe (see Rig).
  for (const side of ['L', 'R']) add({ id: `earring-${side}`, name: `Earring ${side}`, role: 'static', depth: -0.5, spring: { pivot: earLobe(c, side), k: 1.4 }, body: earrings(c, side) });
  add({ id: 'face', name: 'Face', role: 'static', depth: 0, squash: true, body: face(c) });
  for (const side of ['L', 'R']) {
    add({ id: `eye-white-${side}`, name: `Eye White ${side}`, role: 'eyeWhite', side, depth: 0.7, body: eyeWhite(c, side) });
    add({ id: `iris-${side}`, name: `Iris ${side}`, role: 'iris', side, depth: 0.7, body: iris(c, side) });
    add({ id: `socket-${side}`, name: `Eye Socket ${side}`, role: 'socket', side, depth: 0.7, body: socket(c, side) });
    for (const state of EYE_STATES) {
      add({ id: `eye-${side}-${state}`, name: `Eye ${side}${stateName(state)}`, role: 'eye', side, state, depth: 0.7, body: lid(c, side, state) });
    }
  }
  add({ id: 'nose', name: 'Nose', role: 'static', depth: 1, body: nose(c) });
  if (c.beard) add({ id: 'beard', name: 'Beard', role: 'static', depth: 0.45, body: beard(c) });
  for (const side of ['L', 'R']) add({ id: `brow-${side}`, name: `Brow ${side}`, role: 'brow', side, depth: 0.75, body: brow(c, side) });
  if (c.glasses) add({ id: 'glasses', name: 'Glasses', role: 'static', depth: 0.85, body: glasses(c) });
  for (const key of MOUTH_KEYS) {
    add({ id: `mouth-${key}`, name: mouthName(key), role: 'mouth', key, depth: 0.6, body: m[key] });
  }
  if (c.mustache) add({ id: 'mustache', name: 'Mustache', role: 'static', depth: 0.65, body: mustache(c) });
  add({ id: 'hair-front', name: 'Hair Front', role: 'static', depth: 0.25, squash: true, body: h.front });
  return list;
}

// ------------------------------------------------------------------ 3/4 views

const TURN_DEG = 28; // the angle the ¾ drawings represent
const PROFILE_DEG = 70; // the angle the side-profile drawings represent
const HEAD_R = 82; // head radius used to wrap features around the head

/** Map every coordinate of an SVG fragment (path data + circle/ellipse centres). */
function warpSvg(body, map) {
  const warpD = (d) => {
    const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    const arity = { M: 2, L: 2, T: 2, C: 6, S: 4, Q: 4, A: 7, H: 1, V: 1, Z: 0 };
    const out = [];
    let cmd = 'M';
    let last = [0, 0];
    for (let i = 0; i < tokens.length;) {
      if (/[A-Za-z]/.test(tokens[i])) { cmd = tokens[i].toUpperCase(); out.push(tokens[i]); i++; continue; }
      const n = arity[cmd];
      const args = tokens.slice(i, i + n).map(Number);
      i += n;
      if (cmd === 'A') {
        const [x, y] = map(args[5], args[6]);
        out.push(`${args.slice(0, 5).join(' ')} ${x.toFixed(1)},${y.toFixed(1)}`);
        last = [args[5], args[6]];
      } else if (cmd === 'H') {
        out.push(map(args[0], last[1])[0].toFixed(1));
        last = [args[0], last[1]];
      } else if (cmd === 'V') {
        out.push(args[0]);
        last = [last[0], args[0]];
      } else {
        for (let k = 0; k < n; k += 2) {
          const [x, y] = map(args[k], args[k + 1]);
          out.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        last = [args[n - 2], args[n - 1]];
      }
    }
    return out.join(' ');
  };
  return body
    .replace(/\sd="([^"]+)"/g, (_, d) => ` d="${warpD(d)}"`)
    .replace(/<(circle|ellipse)\b([^>]*?)\/?>/g, (tag, name, attrs) => {
      const cx = Number((attrs.match(/\bcx="([-\d.]+)"/) || [])[1]);
      const cy = Number((attrs.match(/\bcy="([-\d.]+)"/) || [])[1]);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return tag;
      const [x, y] = map(cx, cy);
      let out = tag.replace(/\bcx="[-\d.]+"/, `cx="${x.toFixed(1)}"`).replace(/\bcy="[-\d.]+"/, `cy="${y.toFixed(1)}"`);
      const rx = Number((attrs.match(/\brx="([-\d.]+)"/) || [])[1]);
      if (name === 'ellipse' && Number.isFinite(rx)) {
        // Ellipses on the surface (blush, ears) narrow with the turn.
        const stretch = Math.abs(map(cx + 1, cy)[0] - map(cx - 1, cy)[0]) / 2;
        out = out.replace(/\brx="[-\d.]+"/, `rx="${(rx * stretch).toFixed(1)}"`);
      }
      return out;
    });
}

/**
 * The same character turned ~28° (dir +1: nose to screen right, −1: left).
 * Front-surface features wrap around a head-sized sphere: they slide toward
 * the turn and the far side narrows, while the silhouette stays put. The
 * nose, near ear and glasses arms are redrawn for the angle; the far ear hides.
 */
/**
 * Side profile: a silhouette with brow, nose, lips and chin, mirrored by dir.
 * Points are for dir +1 (facing screen right) and flipped about x = 200.
 */
function profileOutline(c, dir) {
  const fx = (x) => (dir > 0 ? x : 400 - x);
  const nose = 292;
  const pts = c.faceShape === 'square'
    ? `M196,90 L250,90 C266,90 276,104 276,120 L276,150 C280,168 284,182 ${nose},198 C${nose + 2},204 ${nose - 4},208 278,208 L274,212 C276,218 278,222 278,228 C278,234 274,236 276,242 C280,262 268,274 246,274 L196,274 C150,274 124,250 124,206 L124,140 C124,108 152,90 196,90 Z`
    : `M200,70 C244,72 268,98 268,132 L270,150 C272,166 278,182 ${nose},198 C${nose + 2},204 ${nose - 4},208 280,209 L272,211 C270,215 274,219 276,223 C276,229 270,231 272,235 C276,241 272,255 262,262 C248,270 230,272 216,268 L208,262 C190,262 160,252 146,238 C126,214 122,184 124,150 C126,104 158,70 200,70 Z`;
  return pts.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${fx(Number(x))},${y}`);
}

/**
 * Hair seen from the side, drawn over the profile skull (which is skin): a
 * hairline at the forehead sweeping back over the crown to the nape, per style.
 */
function profileHair(c, dir) {
  const x = (dx) => 200 + dir * dx; // +dx = toward the face
  const g = `url(#${c.id}-hair)`;
  const cap = `M${x(60)},106 C${x(36)},64 ${x(-40)},52 ${x(-78)},92 C${x(-92)},124 ${x(-88)},178 ${x(-72)},214 L${x(-46)},206 C${x(-52)},172 ${x(-44)},140 ${x(-14)},128 C${x(10)},118 ${x(34)},114 ${x(60)},106 Z`;
  const longFall = `M${x(62)},108 C${x(40)},58 ${x(-46)},46 ${x(-82)},96 C${x(-98)},150 ${x(-98)},260 ${x(-92)},344 Q${x(-60)},356 ${x(-36)},336 C${x(-46)},270 ${x(-48)},200 ${x(-30)},150 C${x(-6)},128 ${x(30)},116 ${x(62)},108 Z`;
  const band = c.headband ? `<path d="M${x(62)},106 C${x(30)},92 ${x(-40)},92 ${x(-78)},110 L${x(-80)},130 C${x(-40)},112 ${x(30)},112 ${x(62)},126 Z" fill="${c.accent}"/>` : '';
  return profileStyle(c, dir, x, g, cap, longFall) + band;
}

function profileStyle(c, dir, x, g, cap, longFall) {
  c = wearing(c);
  const bob = `M${x(62)},108 C${x(40)},58 ${x(-46)},46 ${x(-84)},96 C${x(-100)},150 ${x(-102)},250 ${x(-100)},300 Q${x(-60)},314 ${x(-20)},310 C${x(-40)},250 ${x(-46)},190 ${x(-30)},150 C${x(-6)},128 ${x(30)},116 ${x(62)},108 Z`;
  switch (c.hairStyle) {
    case 'wavy':
    case 'bangs':
      return `<path d="${longFall}" fill="${c.hair}"/>
        <path d="M${x(64)},110 C${x(52)},128 ${x(46)},146 ${x(48)},160 C${x(34)},140 ${x(22)},126 ${x(10)},120 Z" fill="${c.hair}"/>`;
    case 'bob':
    case 'shag':
      return `<path d="${bob}" fill="${c.hair}"/>`;
    case 'hijab':
      // Over the crown and down the back, with its front edge in front of the ear so the face stays clear.
      // Over the crown and down the back, framing the face in front of the ear, and wrapped
      // under the chin and down the throat.
      return `<path d="M${x(40)},96 C${x(22)},48 ${x(-60)},42 ${x(-102)},100 C${x(-120)},170 ${x(-106)},262 ${x(-72)},380 L${x(64)},380 L${x(72)},304 C${x(78)},286 ${x(74)},272 ${x(62)},268 C${x(40)},272 ${x(14)},266 ${x(-4)},250 C${x(-16)},230 ${x(-18)},200 ${x(-12)},170 C${x(-6)},138 ${x(12)},114 ${x(40)},96 Z" fill="${c.hair}"/>`;
    case 'baseball': {
      const dark = mix(c.hair, '#000000', 0.18);
      return `<path d="M${x(66)},138 C${x(66)},74 ${x(10)},48 ${x(-30)},50 C${x(-78)},54 ${x(-92)},96 ${x(-86)},150 L${x(-70)},150 L${x(-60)},138 Z" fill="${c.hair}"/>
        <path d="M${x(54)},132 C${x(80)},128 ${x(116)},132 ${x(130)},142 L${x(124)},152 C${x(104)},144 ${x(80)},142 ${x(54)},146 Z" fill="${dark}"/>`;
    }
    case 'long':
    case 'longSide':
      return `<path d="${longFall}" fill="${g}"/>
        <path d="M${x(64)},110 C${x(52)},128 ${x(46)},146 ${x(48)},160 C${x(34)},140 ${x(22)},126 ${x(10)},120 Z" fill="${c.hair}"/>`;
    case 'puff':
      return `<path d="${cap}" fill="${c.hair}"/>
        ${curlRing(x(-36), 66, 48, 34, 150, 390, 12, 26, c.hair)}<ellipse cx="${x(-36)}" cy="70" rx="58" ry="44" fill="${c.hair}"/>
        <path d="M${x(54)},112 Q${x(0)},88 ${x(-60)},104" ${stroke(c.inner, 7)}/>`;
    case 'curls':
    case 'cap':
      return `<path d="${cap}" fill="${c.hair}"/>${curlRing(x(-10), 104, 62, 44, 190, 340, 9, c.hairStyle === 'cap' ? 20 : 15, c.hair)}`;
    default: // quiff and other short cuts
      return `<path d="${cap}" fill="${g}"/>
        <path d="M${x(58)},106 C${x(64)},84 ${x(44)},62 ${x(10)},58 C${x(30)},70 ${x(44)},86 ${x(58)},106 Z" fill="${c.hairLight}"/>`;
  }
}

function threeQuarter(c, dir, profile = false) {
  const view = profile ? (dir > 0 ? 'PR' : 'PL') : dir > 0 ? 'R' : 'L';
  const th = (dir * (profile ? PROFILE_DEG : TURN_DEG) * Math.PI) / 180;
  const clampU = (u) => Math.max(-0.999, Math.min(0.999, u / HEAD_R));

  // Rotate points on the head sphere about the vertical axis. Front-surface
  // points slide toward the turn; the near side of the face moves inward
  // (the back of the skull becomes that side's outline) and the far cheek
  // becomes the far silhouette. 0.8 keeps it stylised rather than literal.
  const STYLE = 0.8;
  const sphereU = (u) => {
    if (Math.abs(u) <= HEAD_R) {
      const phi = Math.asin(u / HEAD_R);
      return HEAD_R * Math.sin(Math.max(-Math.PI / 2, Math.min(Math.PI / 2, phi + th)));
    }
    // Volume outside the head (big hair): continue from the rotated edge.
    const sgn = Math.sign(u);
    return sphereU(sgn * HEAD_R) + (u - sgn * HEAD_R) * Math.cos(th);
  };
  const surfaceX = (x) => x + (sphereU(x - 200) + 200 - x) * STYLE;
  // Feature centre → new centre and the local horizontal compression.
  const feature = (x) => ({ x: surfaceX(x), k: Math.abs(surfaceX(x + 1) - surfaceX(x - 1)) / 2 });
  // Face shape, front hair and beard: the same rotation, easing off toward the
  // crown and chin where the head curves away from camera.
  const outline = (x, y) => {
    const v = Math.min(1, ((y - 165) / 100) ** 2);
    const depth = Math.max(0.45, Math.sqrt(1 - v));
    return [x + (surfaceX(x) - x) * depth, y];
  };
  // Back hair lies behind the head: its near edge is the back of the skull,
  // which stays put; the far side tucks in with the turn.
  const backX = (x, y) => {
    const w = Math.max(0, Math.min(1, ((x - 200) * dir) / HEAD_R)); // 0 on the near half → 1 at the far edge
    // Faux 3D: the hair is further back than the face, so it also slides the other way (parallax),
    // showing more behind the near side of the head and less past the far cheek.
    return [x - dir * 14 + (surfaceX(x) - x) * 0.6 * w * w * (3 - 2 * w), y];
  };
  const around = (cx, body) => {
    const f = feature(cx);
    return `<g transform="translate(${f.x.toFixed(2)} 0) scale(${f.k.toFixed(3)} 1) translate(${-cx} 0)">${body}</g>`;
  };
  const tag = (s) => `${s} (${profile ? 'side' : '¾'} ${dir > 0 ? 'R' : 'L'})`;
  // In profile only the near eye and brow show, compressed at the front of the face.
  const nearSide = dir > 0 ? 'L' : 'R';
  const PROFILE_EYE = 44;
  const aroundAt = (cx, nx, k, body) => `<g transform="translate(${nx.toFixed(2)} 0) scale(${k.toFixed(3)} 1) translate(${-cx} 0)">${body}</g>`;
  const placeEye = (side, body) => (profile ? aroundAt(EYES[side], 200 + dir * PROFILE_EYE, 0.55, body) : around(EYES[side], body));
  const h = hair(c);
  const m = mouths(c);
  const noseX = feature(200).x;
  // The near ear sits on the side plane, which the turn brings to the face's
  // near edge; the far ear is hidden behind the head.
  // Anchored to the turned face edge at ear height, overlapping it slightly.
  const earEdge = 82; // front face half-width at ear height
  const ear = outline(200 - dir * earEdge, 182)[0] - dir; // a little under the face edge (drawn behind it), so no gap shows
  const behind = [];
  const front = [];
  const add = (list, part) => {
    if (!part.body || !part.body.replace(/<g[^>]*>|<\/g>/g, '').trim()) return;
    list.push({ group: 'head', depth: 0, view, ...part, id: `${part.id}@${view}` });
  };

  if (h.back) add(behind, { id: 'hair-back', name: tag('Hair Back'), role: 'static', depth: -0.45, body: profile ? h.back : warpSvg(h.back, backX) });
  else if (!profile && c.hairStyle !== 'none') {
    // Short hair: the turn reveals the back of the skull on the near side. The
    // character's own haircut, unturned, sits behind the face as that skull —
    // the turned hair always overlaps it, so the two read as one head of hair —
    // plus a short fade down behind the near ear.
    const n = (dx) => 200 - dir * dx; // x on the near side
    // Hair-coloured parts of the unturned haircut give the texture (curls, quiff
    // bumps); skin-coloured hairline shading is dropped.
    // A hat's own details (button, seams, brim) would show twice, so hats show none.
    // Where the style's own top is (its highest path point), so the skull behind it reaches as high.
    const skullTop = Math.min(54, ...[...h.front.matchAll(/\sd="([^"]+)"/g)].flatMap((m) => [...m[1].matchAll(/-?\d*\.?\d+,(-?\d*\.?\d+)/g)].map((q) => +q[1])) .filter((y) => y > 20)) + 4;
    const texture = c.hairStyle === 'baseball' ? '' : h.front.replace(new RegExp(`<[^>]*${c.skinShadow}[^>]*>`, 'g'), '');
    add(behind, {
      id: 'hair-back',
      name: tag('Hair Back'),
      role: 'static',
      depth: -0.45,
      body: profile
        ? `<path d="M${n(-30)},62 C${n(40)},52 ${n(HEAD_R + 6)},86 ${n(HEAD_R + 6)},146 C${n(HEAD_R + 6)},180 ${n(HEAD_R - 4)},206 ${n(HEAD_R - 18)},214 L${n(30)},200 C${n(20)},150 ${n(-10)},104 ${n(-30)},100 Z" fill="${c.hair}"/>
        ${warpSvg(texture, outline)}`
        // The side of the head behind the turned face: full enough to read as hair, ending just above the ear.
        
        : `<path d="M200,${skullTop + 6} C${n(64)},${skullTop} ${n(HEAD_R + 14)},92 ${n(HEAD_R + 14)},146 C${n(HEAD_R + 14)},166 ${n(HEAD_R + 8)},178 ${n(HEAD_R - 2)},182 Q${n(HEAD_R - 13)},187 ${n(HEAD_R - 24)},176 C${n(HEAD_R - 26)},150 ${n(40)},108 200,100 Z" fill="${c.hair}"/>
        ${texture}`,
    });
  }
  const blushTone = c.blush === undefined ? '#FF6F6F' : c.blush;
  // Profile: the ear sits just behind the middle of the head. ¾: the near ear tucks under the face
  // edge (drawn behind the face, so its inner side never shows as a line or a gap); its earring or
  // hoop is its own layer in front, so the face doesn't cover it.
  const earX = profile ? 200 - dir * 26 : ear;
  const hoopAt = (x, y) => (c.hoops ? `<circle cx="${x}" cy="${y}" r="15" ${stroke(HOOP, 6)}/>` : '');
  const earArt = profile
    ? `<ellipse cx="${earX}" cy="184" rx="13" ry="21" fill="${c.skin}" stroke="${c.skinShadow}" stroke-width="1.5"/>
      <path d="M${earX + dir * 4},172 Q${earX - dir * 5},184 ${earX + dir * 3},196" ${stroke(c.skinShadow, 2.6)}/>`
    : `<path d="M${ear + dir * 6},166 C${ear - dir * 8},162 ${ear - dir * 13},176 ${ear - dir * 10},190 C${ear - dir * 8},200 ${ear},203 ${ear + dir * 6},198 Z" fill="${c.skin}" stroke="${c.skinShadow}" stroke-width="1.5"/>
      <path d="M${ear + dir * 2},172 Q${ear - dir * 7},181 ${ear - dir * 1},193" ${stroke(c.skinShadow, 2.4)}/>`;
  const jewel = profile
    ? `${c.earrings ? `<circle cx="${earX}" cy="212" r="9" ${stroke('#E8B23A', 3)}/>` : ''}${hoopAt(earX, 218)}`
    : `${c.earrings ? `<circle cx="${ear}" cy="210" r="9" ${stroke('#E8B23A', 3)}/>` : ''}${hoopAt(ear, 216)}`;
  const ears = c.hairStyle !== 'hijab';
  if (ears && !profile) add(front, { id: 'ears', name: tag('Ear'), role: 'static', depth: -0.3, body: earArt });
  add(front, {
    id: 'face',
    name: tag('Face'),
    role: 'static',
    squash: true,
    // ¾: the warped face (flat, no jaw line). Profile: a real silhouette with one cheek of blush.
    body: profile
      ? `<path d="${profileOutline(c, dir)}" fill="url(#${c.id}-skin)"/>` +
        (blushTone ? `<ellipse cx="${200 + dir * 40}" cy="214" rx="13" ry="9" fill="${blushTone}" opacity="${c.blush ? 0.75 : 0.2}"/>` : '')
      : warpSvg(face(c), outline),
  });
  if (ears && profile) add(front, { id: 'ears', name: tag('Ear'), role: 'static', depth: -0.3, body: earArt + jewel });
  if (ears && !profile && jewel.trim()) add(front, { id: 'earrings', name: tag('Earrings'), role: 'static', depth: -0.3, spring: { pivot: { x: ear, y: 200 }, k: 1.4 }, body: jewel });
  for (const side of profile ? [nearSide] : ['L', 'R']) {
    add(front, { id: `eye-white-${side}`, name: tag(`Eye White ${side}`), role: 'eyeWhite', side, depth: 0.7, body: placeEye(side, eyeWhite(c, side)) });
    add(front, { id: `iris-${side}`, name: tag(`Iris ${side}`), role: 'iris', side, depth: 0.7, body: placeEye(side, iris(c, side)) });
    add(front, { id: `socket-${side}`, name: tag(`Eye Socket ${side}`), role: 'socket', side, depth: 0.7, body: placeEye(side, socket(c, side, SOCKET_3Q)) });
    for (const state of EYE_STATES) {
      add(front, { id: `eye-${side}-${state}`, name: tag(`Eye ${side}${stateName(state)}`), role: 'eye', side, state, depth: 0.7, body: placeEye(side, lid(c, side, state)) });
    }
  }
  const noseBody = profile
    ? `<path d="M${200 + dir * 80},203 Q${200 + dir * 74},208 ${200 + dir * 78},210" ${stroke(c.noseStyle === 'line' ? c.iris : c.noseFill, 2.4)}/>`
    : ['triangle', 'rect', 'circle', 'trapezoid'].includes(c.noseStyle)
    ? around(200, `<g transform="translate(${dir * 4} 0)">${nose(c)}</g>`)
    : null;
  add(front, {
    id: 'nose',
    name: tag('Nose'),
    role: 'static',
    depth: 1,
    body: noseBody || `<path d="M${noseX - dir * 2},186 Q${noseX + dir * 3},199 ${noseX + dir * 9},208 Q${noseX + dir * 5},214 ${noseX - dir * 4},212" ${stroke(c.noseStyle === 'line' ? c.iris : c.noseFill, 2.6)}/>
      ${c.noseStyle === 'line' ? '' : `<path d="M${noseX + dir * 9},208 Q${noseX + dir * 2},212 ${noseX - dir * 1},209 Z" fill="${c.noseFill}" opacity="0.35"/>`}`,
  });
  if (c.beard) {
    const b = (x) => 200 + dir * x;
    add(front, {
      id: 'beard',
      name: tag('Beard'),
      role: 'static',
      depth: 0.45,
      body: profile && c.faceShape === 'square'
        // Square jaw in profile: down from the sideburn, along the flat jaw line to the chin's front corner.
        ? `<path d="M${b(-20)},186 L${b(-20)},230 C${b(-20)},258 ${b(0)},274 ${b(30)},274 L${b(46)},274 C${b(68)},274 ${b(80)},262 ${b(76)},242 C${b(66)},246 ${b(52)},240 ${b(44)},228 C${b(30)},220 ${b(6)},206 ${b(-20)},186 Z" fill="${c.hair}"/>
          <path d="M${b(58)},219 Q${b(72)},214 ${b(78)},222 Q${b(68)},225 ${b(58)},219 Z" fill="${c.hair}"/>`
        : profile
        ? `<path d="M${b(-22)},192 C${b(-20)},238 ${b(20)},274 ${b(62)},264 C${b(74)},256 ${b(76)},244 ${b(72)},236 C${b(58)},240 ${b(40)},232 ${b(28)},214 C${b(14)},206 ${b(-8)},200 ${b(-22)},192 Z" fill="${c.hair}"/>
          <path d="M${b(58)},219 Q${b(72)},214 ${b(78)},222 Q${b(68)},225 ${b(58)},219 Z" fill="${c.hair}"/>`
        : warpSvg(beard(c), outline),
    });
  }
  for (const side of profile ? [nearSide] : ['L', 'R']) add(front, { id: `brow-${side}`, name: tag(`Brow ${side}`), role: 'brow', side, depth: 0.75, body: placeEye(side, brow(c, side)) });
  if (c.glasses && profile) {
    const { big, ink, armY } = frame(c);
    const half = frame(c).half * 0.55;
    const ex = 200 + dir * PROFILE_EYE;
    const lensBody = placeEye(nearSide, lens(c, nearSide));
    add(front, {
      id: 'glasses',
      name: tag('Glasses'),
      role: 'static',
      depth: 0.85,
      body: `${lensBody}<path d="M${(ex - dir * half).toFixed(1)},${armY} L${earX + dir * 6},${armY - 4}" ${stroke(ink, big ? 10 : 3)}/>
        <path d="M${(ex + dir * half).toFixed(1)},${EYE_Y - 4} L${(ex + dir * (half + 7)).toFixed(1)},${EYE_Y - 4}" ${stroke(ink, big ? 9 : 3.4)}/>`,
    });
  } else if (c.glasses) {
    const near = dir > 0 ? 'L' : 'R';
    const far = dir > 0 ? 'R' : 'L';
    const fn = feature(EYES[near]);
    const ff = feature(EYES[far]);
    const { big, ink, half } = frame(c);
    const lensAt = (side) => around(EYES[side], lens(c, side));
    const nearInner = fn.x + dir * half * fn.k;
    const farInner = ff.x - dir * half * ff.k;
    const nearOuter = fn.x - dir * half * fn.k;
    const farOuter = ff.x + dir * half * ff.k;
    const { bar, arm, armY } = frame(c);
    add(front, {
      id: 'glasses',
      name: tag('Glasses'),
      role: 'static',
      depth: 0.85,
      body: `${lensAt('L')}${lensAt('R')}
        <path d="M${nearInner.toFixed(1)},${EYE_Y - 4} Q${((nearInner + farInner) / 2).toFixed(1)},${EYE_Y - (big ? 4 : 9)} ${farInner.toFixed(1)},${EYE_Y - 4}" ${stroke(ink, bar)}/>
        <path d="M${nearOuter.toFixed(1)},${armY} L${ear + dir * 6},${armY - 4}" ${stroke(ink, arm)}/>
        <path d="M${farOuter.toFixed(1)},${armY} L${(farOuter + dir * 4).toFixed(1)},${armY - 2}" ${stroke(ink, arm)}/>
        ${big ? '' : `<path d="M${(fn.x - 16 * fn.k).toFixed(1)},${EYE_Y - 10} L${(fn.x - 8 * fn.k).toFixed(1)},${EYE_Y - 14}" ${stroke('#FFFFFF', 2.4, 'opacity="0.55"')}/>`}`,
    });
  }
  for (const key of MOUTH_KEYS) {
    // The mouth sits low on the face, where the head curves away and the outline
    // shifts less with the turn than the eyes do: warp it with the face's own
    // mapping so it stays inside the jaw (a plain shift slid it off the far side).
    // In profile the mouth sits just behind the face's front edge (which is ~x±72 at
    // mouth height), so even the widest shapes keep their front corner on the face.
    const mouthBody = profile ? aroundAt(200, 200 + dir * 54, 0.4, m[key]) : warpSvg(m[key], outline);
    add(front, { id: `mouth-${key}`, name: tag(mouthName(key)), role: 'mouth', key, depth: 0.6, body: mouthBody });
  }
  if (c.mustache) add(front, { id: 'mustache', name: tag('Mustache'), role: 'static', depth: 0.65, body: profile ? aroundAt(200, 200 + dir * 60, 0.45, mustache(c)) : warpSvg(mustache(c), outline) });
  // ¾ curls: the turn brings the near temple round, so the curls' mass comes down it to the ear
  // (a sweep from the crown to just above the near ear) instead of leaving a wedge of skin.
  const n = (dx) => 200 - dir * dx;
  const temple = !profile && c.hairStyle === 'curls'
    ? `<path d="M${n(10)},70 C${n(50)},66 ${n(80)},96 ${n(82)},130 L${n(82)},178 C${n(64)},150 ${n(38)},104 ${n(10)},70 Z" fill="${c.hair}"/>` : '';
  // ¾ sweep: the step between the low side and the tall wave leaves a notch at the back of the
  // turned head, so the top is one smooth curve there.
  const smoothSweep = (art) => (c.hairStyle === 'sweep' ? art.replace('C116,98 134,84 158,82 C168,58 200,40 238,42', 'C116,92 138,68 170,56 C190,46 214,40 238,42') : art);
  const frontArt = temple ? h.front.replace(/(<path d="M120,168[^>]*\/>)/, `$1${temple}`) : h.front;
  add(front, { id: 'hair-front', name: tag('Hair Front'), role: 'static', depth: 0.25, squash: !profile, body: profile ? profileHair(c, dir) : warpSvg(smoothSweep(frontArt), outline) });
  const geometry = { eyes: { L: feature(EYES.L), R: feature(EYES.R) }, socket: SOCKET_3Q };
  return { behind, front, geometry };
}

/** Front parts plus both ¾ views, ordered so every view's back hair stays behind the body. */
function viewGeometry(c) {
  return { R: threeQuarter(c, 1).geometry, L: threeQuarter(c, -1).geometry };
}

function allParts(c) {
  const frontParts = parts(c).map((p) => (p.group === 'head' && !p.allViews ? { view: 'F', ...p } : p));
  const views = [threeQuarter(c, 1), threeQuarter(c, -1), threeQuarter(c, 1, true), threeQuarter(c, -1, true)];
  // Back hair (every view's) → neck → body → the rest.
  const shared = frontParts.filter((p) => p.allViews);
  const rest = frontParts.filter((p) => !p.allViews);
  const bodyIndex = rest.findIndex((p) => p.id === 'body');
  return [
    ...rest.slice(0, bodyIndex),
    ...views.flatMap((v) => v.behind),
    ...shared,
    ...rest.slice(bodyIndex),
    ...views.flatMap((v) => v.front),
  ];
}


    return { defs, allParts, viewGeometry, hair, profileHair, SOCKET, EYES, EYE_Y, MOUTH_Y, TURN_DEG, PROFILE_DEG, W, H };
  })();

  /** Skin tones: base, light (face highlight) and shadow. Tan is Kai's. */
  const FLAT_SKIN = {
    tan: ['#E39A62', '#E6A06A', '#C47641'],
    peach: ['#F7D5BE', '#FFE4D2', '#E6B79B'],
    sand: ['#F2C59C', '#F7D3B0', '#D6A276'],
    olive: ['#C98F5E', '#D29C6C', '#A8723F'],
    brown: ['#A0623C', '#AB6E47', '#7F4A2A'],
    deep: ['#6E4028', '#7A4A31', '#52301D'],
    mint: ['#A9DEC2', '#B8E6CD', '#80BE9E'],
    lilac: ['#C9B5EC', '#D4C3F1', '#A48ED0'],
  };
  const FLAT_DEFAULT = {
    base: 'flat', id: 'kai', name: 'Kai', prefix: 'kai', build: 'man', face: 'square', skin: 'tan',
    hair: 'cap', hairColor: '#3D3D3D', eyes: 'sleepy', irisColor: '#2E2E2E', brows: 'thick', nose: 'triangle',
    mouth: 'smirk', lipColor: '#B9622F', outfit: 'turtleneck', outfitColor: '#3D3D3D', extras: ['glasses'], extraColor: '#3D3D3D', thumbBg: '#F1E0BF',
  };
  // The body is drawn smaller than the one-off characters' so the head reads bigger.
  const FLAT_BODY_SCALE = 0.8;
  // …and the head bigger: scaled about the chin, which drops so the hair stays in frame.
  const FLAT_HEAD_SCALE = 1.5;
  const FLAT_CHIN_Y = 348; // the chin (head pivot) after the drop; drawn at y 262
  const FLAT_THUMB_TOP = 38; // the tallest offered hairstyle (wavy)
  // Glasses styles, in the order one wins if several are ticked.
  const FLAT_GLASSES = ['glasses', 'shades', 'frames', 'specs'];
  const FLAT_GLASSES_STYLE = { glasses: 'round', shades: 'shades', frames: 'frames', specs: 'specs' };

  function flat(options = {}) {
    const cfg = { ...FLAT_DEFAULT, ...options };
    const P = cfg.prefix || cfg.id;
    const extras = new Set(cfg.extras || []);
    const [skin, skinLight, skinShadow] = FLAT_SKIN[cfg.skin] || FLAT_SKIN.tan;
    // The face follows the body type: Male is square, Female oval.
    const square = cfg.build !== 'woman';
    // The record the drawing code reads (the same fields the one-off characters use).
    const c = {
      id: P,
      build: cfg.build === 'woman' ? 'woman' : 'man',
      ...(square ? { faceShape: 'square' } : {}),
      skin, skinLight, skinShadow,
      // The nose stays in the skin's own hue: between the skin and its shadow, nudged a touch redder
      // (a saturated shadow turned orange on darker skin and read as make-up).
      noseFill: mix(mix(skin, skinShadow, 0.55), '#B5473A', 0.12),
      hair: cfg.hairColor, hairLight: mix(cfg.hairColor, '#FFFFFF', 0.05), hat: cfg.hatColor || cfg.hairColor,
      iris: cfg.irisColor, lips: cfg.lipColor, lipLine: cfg.lipColor,
      hairStyle: cfg.hair, outfit: cfg.outfit,
      glasses: FLAT_GLASSES_STYLE[FLAT_GLASSES.find((g) => extras.has(g))] || null,
      accent: cfg.extraColor || '#3D3D3D',
      earDots: true,
      cloth: cfg.outfitColor, clothDark: darken(cfg.outfitColor, 0.13),
      inner: FLAT_SECONDARY[cfg.outfit] ? cfg.outfitColor2 || FLAT_SECONDARY[cfg.outfit] : cfg.outfit === 'turtleneck' ? cfg.outfitColor : '#F4F1EC',
      // "Lidded" is the sleepy eye with a shaded lid above it.
      eyeStyle: cfg.eyes === 'almond' ? undefined : cfg.eyes === 'lidded' ? 'sleepy' : cfg.eyes,
      lidPatch: cfg.eyes === 'lidded',
      // The line noses (button, line) were removed: characters saved with them get the triangle.
      noseStyle: cfg.nose === 'button' || cfg.nose === 'line' ? 'triangle' : cfg.nose,
      mouthRest: cfg.mouth === 'neutral' ? undefined : cfg.mouth,
      browStyle: cfg.brows === 'thick' ? undefined : cfg.brows,
      // undefined = the soft default blush; null = none.
      blush: extras.has('blush') ? undefined : null,
      lashes: extras.has('lashes'),
      earrings: extras.has('earrings'),
      beard: extras.has('beard'),
      mustache: extras.has('mustache'),
      hoops: extras.has('hoops'),
      headband: extras.has('headband'),
      bodyScale: FLAT_BODY_SCALE,
    };
    // The head is drawn about a chin at (200, 262), then scaled by S about it and moved down to
    // FLAT_CHIN_Y; the neck and body move down with it. Every artwork-px measure the rig reads
    // (pivot, eyes, mouth, gaze, parallax, turn-view eye positions) is mapped the same way.
    const S = FLAT_HEAD_SCALE;
    const DROP = FLAT_CHIN_Y - 262;
    const X = (x) => +(200 + (x - 200) * S).toFixed(2);
    const Y = (y) => +(FLAT_CHIN_Y + (y - 262) * S).toFixed(2);
    const len = (v) => +(v * S).toFixed(2);
    const headT = `translate(200 ${FLAT_CHIN_Y}) scale(${S}) translate(-200 -262)`;
    const parts = Flat.allParts(c).map((p) => {
      if (p.group === 'body') return { ...p, body: `<g transform="translate(0 ${DROP})">${p.body}</g>` };
      return { ...p, ...(p.spring ? { spring: { ...p.spring, pivot: { x: X(p.spring.pivot.x), y: Y(p.spring.pivot.y) } } } : {}), body: `<g transform="${headT}">${p.body}</g>` };
    });
    const geometry = Object.fromEntries(Object.entries(Flat.viewGeometry(c)).map(([view, g]) => [view, {
      ...g,
      eyes: Object.fromEntries(Object.entries(g.eyes).map(([side, e]) => [side, { ...e, x: X(e.x) }])),
      ...(g.socket ? { socket: { rx: len(g.socket.rx), ry: len(g.socket.ry) } } : {}),
    }]));
    const pivot = { x: 200, y: FLAT_CHIN_Y }; // chin/neck: the head turns about this point
    // One framing for every hairstyle (room for the tallest offered), so every tile shares a scale.
    const top = Y(FLAT_THUMB_TOP);
    const gaze = c.eyeStyle === 'dot' ? { x: 2.5, y: 1.5 } : c.eyeStyle === 'big' ? { x: 7, y: 5 } : { x: 5, y: 3 };
    return {
      id: cfg.id,
      name: cfg.name,
      size: { width: W, height: H },
      pivot,
      // Skin ring that hides iris overflow (big eyes are roomy enough not to need one).
      socket: c.eyeStyle === 'dot' || c.eyeStyle === 'big' ? null : { rx: len(Flat.SOCKET.rx), ry: len(Flat.SOCKET.ry) },
      iris: { r: len(c.eyeStyle === 'sleepy' ? 10 : c.eyeStyle === 'dot' ? 7 : 9) },
      gaze: { x: len(gaze.x), y: len(gaze.y) },
      mouth: { x: 200, y: Y(Flat.MOUTH_Y) },
      faceHalfWidth: len(81), // face outline half-width at eye height
      turn: len(0.85), // artwork px of parallax per degree of yaw/pitch at depth 1
      browRise: len(30), // brows turn about a point this far above the eye
      neckLength: len(38), // chin to collar point (the rig plants the neck's base there)
      eyes: { L: { x: X(Flat.EYES.L), y: Y(Flat.EYE_Y) }, R: { x: X(Flat.EYES.R), y: Y(Flat.EYE_Y) } },
      // ¾ drawing past ~22° of yaw, side profile past ~48° (each with hysteresis).
      turnViews: { angle: TURN_DEG, enter: 22, exit: 15, geometry, profile: { angle: PROFILE_DEG, enter: 48, exit: 40 } },
      thumb: alignThumb(thumbFor(top, pivot), Y(Flat.EYE_Y), 0.92, 0.53), // a touch smaller and lower: the Flat head is wider than the 3D one
      thumbBg: cfg.thumbBg,
      defs: Flat.defs(c),
      parts,
      ...(options.kit ? { kit: options.kit } : {}),
    };
  }

  /** Switching body type also swaps the parts that read as that body (hair, brows). Lashes are no
   *  longer offered, so they're cleared either way. */
  function flatBodyPreset(cfg, build) {
    const extras = new Set(cfg.extras || []);
    extras.delete('lashes');
    if (build === 'woman') {
      extras.delete('beard');
      return { ...cfg, build, hair: ['cap', 'quiff', 'sweep', 'bowl', 'none'].includes(cfg.hair) ? 'longSide' : cfg.hair, brows: cfg.brows === 'thick' ? 'thin' : cfg.brows, extras: [...extras] };
    }
    extras.delete('lashes');
    return { ...cfg, build, hair: ['long', 'longSide', 'wavy', 'bangs', 'bob'].includes(cfg.hair) ? 'cap' : cfg.hair, brows: cfg.brows === 'thin' ? 'thick' : cfg.brows, extras: [...extras] };
  }

  /** What the builder offers, per base. Labels are for the panel. */
  const OPTIONS = {
    person: {
      build: { label: 'Body', choices: [['man', 'Masculine'], ['woman', 'Feminine']] },
      skin: { label: 'Skin', choices: [['rose', 'Rose'], ['porcelain', 'Porcelain'], ['sand', 'Sand'], ['olive', 'Olive'], ['brown', 'Brown'], ['deep', 'Deep'], ['mint', 'Mint'], ['lilac', 'Lilac']] },
      // The cap plus the Flat character's hairstyles (shaded for the 3D look).
      hair: { label: 'Hair', choices: [['cap', 'Cap'], ['fQuiff', 'Quiff'], ['fSweep', 'Sweep'], ['fBowl', 'Bowl'], ['fBob', 'Bob'], ['fBangs', 'Bangs'], ['fWavy', 'Wavy'], ['fSide', 'Side part'], ['fHijab', 'Hijab'], ['fBaseball', 'Baseball cap'], ['none', 'None']], color: 'hairColor' },
      eyes: { label: 'Eyes', choices: [['googly', 'Googly'], ['doll', 'Sleepy'], ['dots', 'Dots']], color: 'irisColor', sub: { key: 'brows', choices: [['soft', 'Soft brows'], ['bold', 'Bold brows'], ['thick', 'Thick brows'], ['none', 'No brows']] } },
      nose: { label: 'Nose', choices: [['ball', 'Round'], ['small', 'Small'], ['tiny', 'Tiny'], ['button', 'Button'], ['tall', 'Tall'], ['none', 'None']] },
      mouth: { label: 'Mouth', choices: [['neutral', 'Neutral'], ['small', 'Small'], ['bold', 'Bold'], ['short', 'Short']], color: 'lipColor' },
      outfit: { label: 'Outfit', choices: [['tee', 'T-shirt'], ['hoodie', 'Hoodie'], ['collar', 'Shirt'], ['sweater', 'Sweater'], ['turtleneck', 'Turtleneck'], ['cardigan', 'Cardigan'], ['jacket', 'Jacket'], ['varsity', 'Varsity'], ['scarf', 'Coat + scarf']], color: 'outfitColor' },
      extras: { label: 'Extras', multi: true, choices: [['earbuds', 'Earbuds'], ['glasses', 'Glasses'], ['blush', 'Blush'], ['freckles', 'Freckles'], ['earrings', 'Earrings'], ['mustache', 'Mustache'], ['beard', 'Beard']], color: 'extraColor' },
    },
    head: {
      shape: { label: 'Shape', choices: [['cloud', 'Cloud'], ['round', 'Round'], ['bean', 'Bean'], ['square', 'Square'], ['hexagon', 'Hexagon']] },
      palette: { label: 'Colour', choices: [['sky', 'Sky'], ['mint', 'Mint'], ['peach', 'Peach'], ['lilac', 'Lilac'], ['lemon', 'Lemon'], ['coral', 'Coral'], ['slate', 'Slate'], ['aqua', 'Aqua']], sub: { key: 'glow', choices: [[true, 'Glow'], [false, 'No glow']] } },
      eyes: { label: 'Eyes', choices: [['sleepy', 'Sleepy'], ['beads', 'Beads'], ['pill', 'Pill'], ['googly', 'Googly'], ['droopy', 'Droopy'], ['none', 'None']], sub: { key: 'brows', choices: [['soft', 'Brows'], ['none', 'No brows']] } },
      mouth: { label: 'Mouth', choices: [['default', 'Classic'], ['big', 'Big'], ['cat', 'Cat'], ['wide', 'Wide'], ['none', 'None']], color: 'inkColor' },
      extras: { label: 'Extras', multi: true, choices: [['blush', 'Blush'], ['bow', 'Bow'], ['glasses', 'Glasses']], color: 'extraColor' },
    },
    flat: {
      build: { label: 'Body', choices: [['man', 'Masculine'], ['woman', 'Feminine']], preset: flatBodyPreset },
      skin: { label: 'Skin', choices: [['tan', 'Tan'], ['peach', 'Peach'], ['sand', 'Sand'], ['olive', 'Olive'], ['brown', 'Brown'], ['deep', 'Deep'], ['mint', 'Mint'], ['lilac', 'Lilac']] },
      hair: { label: 'Hair', choices: [['cap', 'Curly crop'], ['quiff', 'Quiff'], ['sweep', 'Sweep'], ['bowl', 'Bowl'], ['bob', 'Bob'], ['bangs', 'Bangs'], ['wavy', 'Wavy'], ['longSide', 'Side part'], ['hijab', 'Hijab'], ['baseball', 'Cap'], ['none', 'None']], color: 'hairColor' },
      eyes: { label: 'Eyes', choices: [['sleepy', 'Sleepy'], ['lidded', 'Lidded'], ['big', 'Big'], ['dot', 'Dots']], color: 'irisColor', sub: { key: 'brows', choices: [['thick', 'Thick brows'], ['thin', 'Thin brows'], ['none', 'No brows']] } },
      nose: { label: 'Nose', choices: [['triangle', 'Triangle'], ['rect', 'Rectangle'], ['circle', 'Circle'], ['trapezoid', 'Pill']] },
      mouth: { label: 'Mouth', choices: [['smirk', 'Smirk'], ['smile', 'Smile'], ['neutral', 'Neutral']], color: 'lipColor' },
      outfit: { label: 'Outfit', choices: [['turtleneck', 'Turtleneck'], ['sweater', 'Sweater'], ['vneck', 'V-neck'], ['cardigan', 'Cardigan'], ['bomber', 'Bomber'], ['blouse', 'Blouse']], color: 'outfitColor' },
      extras: { label: 'Extras', multi: true, choices: [['glasses', 'Big glasses'], ['frames', 'Square frames'], ['shades', 'Sunglasses'], ['blush', 'Blush'], ['earrings', 'Studs'], ['hoops', 'Hoops'], ['headband', 'Headband'], ['mustache', 'Mustache'], ['beard', 'Beard']], color: 'extraColor' },
    },
  };

  /** Swatches offered for each colour option. */
  const SWATCHES = {
    hairColor: ['#F6F1E1', '#3D3D3D', '#2B1D16', '#5A3A24', '#9A6436', '#E2B464', '#C0482B', '#3C3C46', '#7FA7E8', '#F29BC1'],
    hatColor: ['#F6F1E1', '#3D3D3D', '#262626', '#C0482B', '#E65A4F', '#F2B33A', '#3E9A6A', '#3D7EC7', '#8A5CC9', '#F29BC1'],
    irisColor: ['#111111', '#2E2E2E', '#5B3A2A', '#3D7EC7', '#3E9A6A', '#8A5CC9', '#B8862E'],
    lipColor: ['#B8645F', '#B9622F', '#D46A73', '#9C4A55', '#C7826D', '#7E3F4A'],
    outfitColor: ['#262626', '#3D3D3D', '#F2F2F2', '#E65A4F', '#F2B33A', '#3E9A6A', '#3D7EC7', '#8A5CC9', '#F29BC1'],
    outfitColor2: ['#F3F0EA', '#E9DCC6', '#1F6B63', '#262626', '#E65A4F', '#F2B33A', '#3E9A6A', '#3D7EC7', '#8A5CC9', '#F29BC1'],
    extraColor: ['#2A2A2A', '#E8B23A', '#E65A4F', '#3D7EC7', '#1F6B63', '#F29BC1', '#FFFFFF'],
    inkColor: ['#2A2453', '#1E1E1E', '#7A2E4A', '#20504A'],
    thumbBg: ['#6B9B78', '#E3ECFB', '#F1E0BF', '#F2D3DC', '#FFE6A6', '#D6E9F8', '#E9E9EA', '#C9B8F2', '#F6C9A8'],
  };

  /** Build a character from a builder config ({ base: 'person' | 'head' | 'flat', ... }). */
  // The starter cast (first in the picker), as builder options: three of each style, led by Blurb, Bill and Jill.
  const STARTERS = {
    // In picker order: 3D, then Flat, then the Orbs (each tile on its own background colour).
    jill: { ...PERSON_DEFAULT, build: 'woman', id: 'jill', name: 'Jill', prefix: 'jill', skin: 'porcelain', hair: 'fWavy', hairColor: '#E2B464', eyes: 'googly', irisColor: '#24703F', brows: 'thick', mouth: 'smile', outfit: 'cardigan', outfitColor: '#8A5CC9', extras: [], thumbBg: '#9DD8DC' },
    nina: { ...PERSON_DEFAULT, build: 'woman', id: 'nina', name: 'Nina', prefix: 'nina', skin: 'olive', face: 'oval', hair: 'fHijab', hairColor: '#2B1D16', hatColor: '#1F6B63', eyes: 'googly', brows: 'bold', mouth: 'small', outfit: 'cardigan', outfitColor: '#F29BC1', extras: [], thumbBg: '#F8C9A4' },
    marcus: { ...PERSON_DEFAULT, id: 'marcus', name: 'Marcus', prefix: 'marcus', skin: 'deep', hair: 'fQuiff', hairColor: '#1E1A17', eyes: 'doll', brows: 'thick', mouth: 'smile', outfit: 'hoodie', outfitColor: '#F2B33A', extras: ['beard', 'glasses'], extraColor: '#2A2A2A', thumbBg: '#C3C3F3' },
    bill: { ...FLAT_DEFAULT, id: 'bill', name: 'Bill', prefix: 'bill', skin: 'peach', hair: 'sweep', hairColor: '#C0482B', outfit: 'cardigan', outfitColor: '#3D7EC7', outfitColor2: '#262626', extras: ['glasses'], extraColor: '#1F6B63', thumbBg: '#F6E08A' },
    amara: { ...OPTIONS.flat.build.preset({ ...FLAT_DEFAULT }, 'woman'), id: 'amara', name: 'Amara', prefix: 'amara', skin: 'olive', hair: 'wavy', hairColor: '#0E0C0B', nose: 'trapezoid', eyes: 'big', brows: 'thin', mouth: 'smile', outfit: 'blouse', outfitColor: '#E65A4F', extras: ['hoops'], extraColor: '#E8B23A', thumbBg: '#CDE7A4' },
    rafi: { ...FLAT_DEFAULT, id: 'rafi', name: 'Rafi', prefix: 'rafi', skin: 'olive', hair: 'baseball', hairColor: '#2B1D16', hatColor: '#E65A4F', eyes: 'dot', mouth: 'smile', outfit: 'bomber', outfitColor: '#1F6B63', outfitColor2: '#F4F1EC', extras: ['mustache'], thumbBg: '#E2C6F0' },
    blurb: { ...HEAD_DEFAULT, id: 'blurb', name: 'Blurb', prefix: 'blurb', palette: 'lilac', eyes: 'beads', brows: 'none', extras: [], thumbBg: '#B5E6C7' },
    pip: { ...HEAD_DEFAULT, id: 'pip', name: 'Pip', prefix: 'pip', shape: 'hexagon', palette: 'mint', eyes: 'googly', extras: ['blush'], thumbBg: '#F6BFC4' },
    mochi: { ...HEAD_DEFAULT, id: 'mochi', name: 'Mochi', prefix: 'mochi', shape: 'bean', palette: 'peach', eyes: 'beads', mouth: 'cat', extras: ['bow', 'blush'], extraColor: '#E65A4F', thumbBg: '#B6DBF6' },
  };

  function build(cfg) {
    const kit = { ...cfg };
    if (cfg.base === 'flat') return flat({ ...cfg, kit });
    return cfg.base === 'head' ? head({ ...cfg, kit }) : person({ ...cfg, kit });
  }

  return { person, head, flat, build, STARTERS, OPTIONS, SWATCHES, OUTFIT_SECONDARY, outfitSecondary, PERSON_DEFAULT, HEAD_DEFAULT, FLAT_DEFAULT, SKIN_TONES, HEAD_PALETTES, FLAT_SKIN, warpSvg, refMapper, withTurnViews, thumbFor };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CharacterKit;
