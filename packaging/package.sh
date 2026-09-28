#!/bin/sh
# בונה שתי חבילות ב-dist/:
#   wa-broadcast-lists-store.zip – להעלאה ל-Chrome Web Store (manifest.json בשורש ה-ZIP)
#   wa-broadcast-lists.zip       – להתקנה ידנית (Load unpacked), כולל install.txt
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./extension/manifest.json').version")

rm -rf dist && mkdir -p dist/wa-broadcast-lists
(cd extension && zip -rq ../dist/wa-broadcast-lists-store.zip . -x '.*')

cp -R extension/. dist/wa-broadcast-lists/
cp packaging/install.txt dist/wa-broadcast-lists/
(cd dist && zip -rq wa-broadcast-lists.zip wa-broadcast-lists -x '.*' && rm -rf wa-broadcast-lists)

echo "v$VERSION → dist/wa-broadcast-lists-store.zip, dist/wa-broadcast-lists.zip"
