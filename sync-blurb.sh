#!/bin/sh
# Copy Blurb's character, lip-sync, face-sync and rig libraries into blurb/.
# Run again whenever the Blurb plugin changes:  sh sync-blurb.sh [path-to-blurb-repo]
set -e
here="$(cd "$(dirname "$0")" && pwd)"
repo="${1:-$here/../lottie-creator-talking-head-plugin}"
mkdir -p "$here/blurb"
for f in cmu-dictionary lipsync motion face-sync rig svg-path character-kit; do
  cp "$repo/src/lib/$f.js" "$here/blurb/$f.js"
done
echo "Synced from $repo ($(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo 'no git'))"
