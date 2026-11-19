// Blurb characters on a canvas.
//
// Each SVG part is rasterised once (cropped to its bounds, at `scale`× artwork px),
// then posed per frame with the same maths as Blurb's poseParts: the head moves,
// rotates and scales about the neck pivot; each part offsets, then rotates and
// scales about the canvas centre (an imported layer's anchor in Creator).
/* global CharacterKit, Rig */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = 40; // artwork px around each part: room for strokes, blur and glow

export const BLURB_CAST = () => Object.values(CharacterKit.STARTERS).map((cfg) => ({ id: cfg.id, name: cfg.name, kind: 'blurb', cfg, bg: cfg.thumbBg }));

/** Bounds of every part, measured in a hidden SVG (one character at a time: defs ids repeat across characters). */
function measure(c) {
  const host = document.createElementNS(SVG_NS, 'svg');
  host.setAttribute('viewBox', `0 0 ${c.size.width} ${c.size.height}`);
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:400px;height:500px;visibility:hidden';
  host.innerHTML = `<defs>${c.defs}</defs>` + c.parts.map((p) => `<g data-part="${p.id}">${p.body}</g>`).join('');
  document.body.append(host);
  const boxes = {};
  for (const p of c.parts) {
    const b = host.querySelector(`[data-part="${CSS.escape(p.id)}"]`).getBBox();
    boxes[p.id] = b.width || b.height ? { x: b.x - PAD, y: b.y - PAD, w: b.width + PAD * 2, h: b.height + PAD * 2 } : null;
  }
  host.remove();
  return boxes;
}

async function rasterise(c, part, box, scale) {
  const w = Math.ceil(box.w * scale), h = Math.ceil(box.h * scale);
  const svg = `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}"><defs>${c.defs}</defs>${part.body}</svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally { URL.revokeObjectURL(url); }
}

export class BlurbCharacter {
  constructor(entry) {
    this.entry = entry; this.c = CharacterKit.build(entry.cfg); this.bitmaps = null;
    // Blob heads (Blurb's "Head" base) are locked in the centre of the frame, centred on the face.
    this.locked = entry.cfg.base === 'head';
    const c = this.c, eyeY = c.eyes ? (c.eyes.L.y + c.eyes.R.y) / 2 : c.size.height / 2;
    this.center = { x: c.size.width / 2, y: (eyeY + (c.mouth ? c.mouth.y : eyeY)) / 2 };
  }

  get size() { return this.c.size; }

  /** Rasterise every part (once). `scale` 2.7 keeps a 1080-wide export sharp. */
  async load(scale = 2.7) {
    if (this.bitmaps) return this;
    if (!this.loading) {
      this.loading = (async () => {
        const boxes = measure(this.c);
        const bitmaps = {};
        // A few at a time keeps decode work from blocking the live preview.
        const parts = this.c.parts.filter((p) => boxes[p.id]);
        for (let i = 0; i < parts.length; i += 12) {
          await Promise.all(parts.slice(i, i + 12).map(async (p) => { bitmaps[p.id] = { bmp: await rasterise(this.c, p, boxes[p.id], scale), box: boxes[p.id] }; }));
        }
        this.bitmaps = bitmaps;
        return this;
      })();
    }
    return this.loading;
  }

  /** Rig the whole performance (Rig.buildCharacterRig) — cache per tracks object. */
  rigFor(tracks) {
    if (this._rigTracks !== tracks) {
      // Locked heads keep turns, nods, tilts and expressions but not movement or scale (closeness
      // scales the whole drawing about the centre instead; see renderScene).
      const extras = this.locked && tracks.extras.head
        ? { ...tracks.extras, head: { ...tracks.extras.head, x: undefined, y: undefined, scale: undefined }, body: undefined }
        : tracks.extras;
      this._rig = Rig.buildCharacterRig(this.c, { set: 'visemes', segments: tracks.segments, extras, totalFrames: tracks.n, fps: 30 });
      this._rigTracks = tracks;
    }
    return this._rig;
  }

  /** Draw frame f of `tracks` into ctx, artwork space already mapped by the caller. */
  draw(ctx, tracks, f) {
    if (!this.bitmaps) return false;
    const c = this.c;
    const fs = Rig.frameState(this.rigFor(tracks), Math.min(f, tracks.n - 1));
    const { x: px, y: py } = c.pivot;
    const cx = c.size.width / 2, cy = c.size.height / 2;
    const d2r = Math.PI / 180;
    for (const part of c.parts) {
      if (!fs.visible.has(part.id)) continue;
      const art = this.bitmaps[part.id];
      if (!art) continue;
      ctx.save();
      const a = fs.alpha && fs.alpha[part.id];
      if (a != null) ctx.globalAlpha *= a;
      if (part.group === 'head') {
        ctx.translate(fs.head.x, fs.head.y);
        ctx.translate(px, py); ctx.rotate(fs.head.rotation * d2r);
        if (fs.head.scale !== 1) ctx.scale(fs.head.scale, fs.head.scale);
        ctx.translate(-px, -py);
      }
      const o = fs.offsets[part.id];
      if (o) {
        ctx.translate(o.x, o.y);
        if (o.rot || o.sx !== 1 || o.sy !== 1) {
          ctx.translate(cx, cy);
          if (o.rot) ctx.rotate(o.rot * d2r);
          ctx.scale(o.sx, o.sy);
          ctx.translate(-cx, -cy);
        }
      }
      ctx.drawImage(art.bmp, art.box.x, art.box.y, art.box.w, art.box.h);
      ctx.restore();
    }
    return true;
  }

  /** A small SVG thumbnail of the resting front view. */
  thumbUrl() {
    const c = this.c;
    const rest = new Set(Rig.frameState(Rig.buildCharacterRig(c, { set: 'visemes', segments: [{ key: 'REST', start: 0, end: 1 }], extras: { profile: false }, totalFrames: 1, fps: 30 }), 0).visible);
    const body = c.parts.filter((p) => rest.has(p.id)).map((p) => p.body).join('');
    const svg = `<svg xmlns="${SVG_NS}" viewBox="${c.thumb || `0 0 ${c.size.width} ${c.size.height}`}"><defs>${c.defs}</defs>${body}</svg>`;
    return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  }
}
