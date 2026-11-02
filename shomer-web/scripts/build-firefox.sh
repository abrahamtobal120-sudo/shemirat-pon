#!/usr/bin/env bash
# Genera dist/shomer-web-firefox.xpi a partir de la extensión de Chrome.
# Único cambio: Firefox usa background.scripts en lugar de service_worker
# y necesita un ID de extensión (browser_specific_settings.gecko.id).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/firefox"
XPI="$ROOT/dist/shomer-web-firefox.xpi"

rm -rf "$OUT" "$XPI"
mkdir -p "$OUT"
for item in background.js common content engine icons lib _locales models popup rules; do
  cp -r "$ROOT/$item" "$OUT/"
done

jq 'del(.minimum_chrome_version)
    | .background = { "scripts": ["common/i18n.js", "common/settings.js", "background.js"] }
    | .browser_specific_settings = { "gecko": { "id": "shomer-web@local", "strict_min_version": "128.0", "data_collection_permissions": { "required": ["none"] } } }' \
  "$ROOT/manifest.json" > "$OUT/manifest.json"

(cd "$OUT" && zip -qr -9 "$XPI" .)
echo "Listo: $XPI"
