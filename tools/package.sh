#!/usr/bin/env bash
# Package dsh-abyss-skin into a distributable zip.
#
#   npm run package
#   # or
#   bash tools/package.sh
#
# Output: <workspace>/dist/dsh-abyss-skin-<version>.zip
# Override the output directory with PACKAGE_OUT_DIR=/some/dir.
#
# The zip always excludes personal / machine-local assets:
#   - MUSE personal photos and user-boot/user-poster
#   - .DS_Store, render logs, __pycache__
#   - the upstream dsh-startup-screen JS/CSS copy in vermilion/lib
#     (its audio files are kept — the rite plays them)
#   - vermilion/boot.mp4 and vermilion/background.mp4: that skin is
#     poster.jpg + the six-act rite now, with no boot film.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$(basename "$ROOT")"
OUT_DIR="${PACKAGE_OUT_DIR:-$(dirname "$ROOT")/dist}"
VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$ROOT/package.json")"
ZIP="$OUT_DIR/${BASE}-${VERSION}.zip"

if ! command -v zip >/dev/null 2>&1; then
  echo "package: zip is required" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$ZIP"

# Run from the parent so the archive has a single dsh-abyss-skin/ root.
cd "$(dirname "$ROOT")"
zip -r -X -q "$ZIP" "$BASE" \
  -x "$BASE/.git/*" \
     "$BASE/node_modules/*" \
     "$BASE/dist/*" \
     "*.DS_Store" \
     "$BASE/preview/*.log" \
     "$BASE/tools/__pycache__/*" \
     "*.pyc" \
     "$BASE/skins/muse/user-boot.mp4" \
     "$BASE/skins/muse/user-poster.jpg" \
     "$BASE/skins/muse/images/*.jpg" \
     "$BASE/skins/muse/images/*.jpeg" \
     "$BASE/skins/muse/images/*.png" \
     "$BASE/skins/muse/images/*.webp" \
     "$BASE/skins/vermilion/boot.mp4" \
     "$BASE/skins/vermilion/background.mp4" \
     "$BASE/skins/vermilion/lib/client.js" \
     "$BASE/skins/vermilion/lib/index.js" \
     "$BASE/skins/vermilion/lib/splash.js" \
     "$BASE/skins/vermilion/lib/splash.css"

# Overwrite the checksum file for the whole dist directory, keeping the
# historical "hash  dist/file.zip" shape when OUT_DIR is named dist.
CHECK_DIR="$(dirname "$OUT_DIR")"
CHECK_NAME="$(basename "$OUT_DIR")"
if [ "$CHECK_NAME" = "dist" ]; then
  ( cd "$CHECK_DIR" && shasum -a 256 "$CHECK_NAME"/"$BASE"-*.zip > "$CHECK_NAME"/SHA256SUMS )
else
  ( cd "$OUT_DIR" && shasum -a 256 "$BASE"-*.zip > SHA256SUMS )
fi

# Refuse to ship personal media or stray Finder files by accident.
if unzip -Z1 "$ZIP" | grep -E '(\.DS_Store$|/skins/muse/user-(boot\.mp4|poster\.jpg)$|/skins/muse/images/.*\.(jpe?g|png|webp)$)' >/dev/null; then
  echo "package: personal or stray files leaked into $ZIP" >&2
  exit 1
fi

SIZE="$(du -h "$ZIP" | awk '{print $1}')"
SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
COUNT="$(unzip -Z1 "$ZIP" | grep -cv '/$' || true)"

echo "packaged:  $ZIP"
echo "version:   $VERSION"
echo "files:     $COUNT"
echo "size:      $SIZE"
echo "sha256:    $SHA"
echo "checksums: $OUT_DIR/SHA256SUMS"
