# AvaCam

Turn your phone's camera into a live animated character. Talk, and the character follows your face, head, shoulders and arms. Record, then swap the character, background and voice, and export a 9:16 video.

**Live:** https://avacam.kenneth-mhakim.workers.dev (an installable PWA: "Add to Home Screen" on iOS, "Install app" on Android/Chrome).

## What it does

- **Live:** MediaPipe face and pose tracking in the browser drives the character: expressions, lip sync, head turn and tilt, closeness to the camera, shoulder tilt, arm and hand depth.
- **Characters:** Blurb's starter cast in 2D (its own rig) and 3D, plus Puff, Neko and Bolt (three.js).
- **Post:** re-render the take with any character, background, clean-up sliders, trim, and voice effects (chipmunk, deep, robot, alien, monster, radio, echo, pitch).
- **Export:** 1080×1920 MP4 (or WebM), saved through the share sheet.
- **Character Lab** (`lab/`): build new waist-up characters on adult or chibi bases.
- **Private:** camera frames never leave the device; only motion data and audio are recorded, locally.

## Run locally

```bash
node serve.mjs 8797
```

Then open http://localhost:8797. The camera needs `localhost` or HTTPS.

## Blurb libraries

`blurb/` holds a copy of the face-sync, lip-sync, rig and character-kit libraries from the Blurb Lottie Creator plugin. Refresh them with `sh sync-blurb.sh [path-to-blurb-repo]`.

## Deploying

Cloudflare serves it as a static-assets Worker named `avacam` (see `wrangler.jsonc`; `.assetsignore` keeps dev files out):

```bash
npx wrangler deploy
```

After changing which files the app uses, bump `VERSION` in `sw.js` so installed copies pick up the new file list.
