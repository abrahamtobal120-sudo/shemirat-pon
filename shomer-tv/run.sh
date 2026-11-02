#!/usr/bin/env bash
# Arranque rápido: servidor web + un canal en vivo que espera la señal de OBS.
#   ./run.sh                 → canal "canal-1" en rtmp://<servidor>:1935/live/canal-1
#   ./run.sh final           → canal "final"
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-$HOME/.cache/shomer-sport-venv/bin/python}"
NAME="${1:-canal-1}"

"$PY" -m shomer_tv serve --port "${PORT:-8080}" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT

echo "Web:     http://localhost:${PORT:-8080}"
echo "Clientes: http://localhost:${PORT:-8080}/admin     (activar / renovar suscripciones)"
echo "Anuncios: http://localhost:${PORT:-8080}/control   (pausa comercial: tapar / volver al partido)"
echo "Señal:   rtmp://<IP-de-este-servidor>:1935/live/$NAME   (en OBS: Servidor = rtmp://IP:1935/live, Clave = $NAME)"
"$PY" -m shomer_tv channel --name "$NAME" --input "rtmp://0.0.0.0:1935/live/$NAME" --listen --retry
