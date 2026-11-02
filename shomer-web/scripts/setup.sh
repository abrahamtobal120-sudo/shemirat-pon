#!/usr/bin/env bash
# setup.sh — Prepara Shomer Sport para cargarla en Chrome:
#   1) Descarga ONNX Runtime Web (JS + WASM) a lib/
#   2) Exporta YOLOv8n-seg a ONNX (models/yolov8n-seg.onnx)
#   3) Crea models/gender.onnx con CLIP zero-shot (sin dataset)
#   4) Genera los iconos
# Para más precisión, el clasificador de género se puede entrenar aparte
# (ver scripts/train_gender_classifier.py) y sustituir a gender.onnx.
#
# Uso:  bash scripts/setup.sh            (todo)
#       bash scripts/setup.sh ort        (solo ONNX Runtime)
#       bash scripts/setup.sh yolo       (solo YOLO)
#       bash scripts/setup.sh gender     (solo clasificador de género CLIP)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORT_VERSION="${ORT_VERSION:-1.31.1}"
YOLO_MODEL="${YOLO_MODEL:-yolov8n-seg}"   # también sirve yolo11n-seg
YOLO_SIZE="${YOLO_SIZE:-384}"             # 320 = más rápido, 640 = más preciso
VENV="${VENV:-$HOME/.cache/shomer-sport-venv}"   # fuera de la extensión (Chrome cargaría todo el directorio)
WHAT="${1:-all}"

step_ort() {
  echo "==> Descargando onnxruntime-web@$ORT_VERSION"
  local tmp; tmp="$(mktemp -d)"
  (cd "$tmp" && npm pack "onnxruntime-web@$ORT_VERSION" --silent >/dev/null && tar xzf onnxruntime-web-*.tgz)
  mkdir -p "$ROOT/lib"
  cp "$tmp/package/dist/ort.all.min.js" "$ROOT/lib/"
  # Binarios WASM y sus cargadores .mjs (WebGPU/JSEP, WASM simple, asyncify…)
  cp "$tmp"/package/dist/ort-wasm-simd-threaded*.wasm "$ROOT/lib/"
  cp "$tmp"/package/dist/ort-wasm-simd-threaded*.mjs "$ROOT/lib/"
  cp "$tmp/package/LICENSE" "$ROOT/lib/LICENSE-onnxruntime.txt" 2>/dev/null || true
  rm -rf "$tmp"
  ls -lh "$ROOT/lib"
}

step_yolo() {
  echo "==> Exportando $YOLO_MODEL a ONNX (imgsz=$YOLO_SIZE)"
  if [ ! -d "$VENV" ]; then python3 -m venv "$VENV"; fi
  "$VENV/bin/pip" install --quiet --upgrade pip
  # CPU basta para exportar; evita descargar CUDA.
  "$VENV/bin/pip" install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cpu
  "$VENV/bin/pip" install --quiet ultralytics onnx onnxslim
  "$VENV/bin/python" -I "$ROOT/scripts/export_yolo.py" "$YOLO_MODEL" "$YOLO_SIZE" "$ROOT/models"
}

step_gender() {
  echo "==> Creando gender.onnx (CLIP zero-shot)"
  if [ ! -d "$VENV" ]; then python3 -m venv "$VENV"; fi
  "$VENV/bin/pip" install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cpu
  "$VENV/bin/pip" install --quiet open_clip_torch timm onnx
  "$VENV/bin/python" -I "$ROOT/scripts/export_gender_clip.py" "$ROOT/models"
}

step_icons() {
  python3 -I "$ROOT/scripts/make_icons.py" "$ROOT/icons"
}

case "$WHAT" in
  ort) step_ort ;;
  yolo) step_yolo ;;
  gender) step_gender ;;
  icons) step_icons ;;
  all) step_ort; step_yolo; step_gender; step_icons ;;
  *) echo "Opción desconocida: $WHAT"; exit 1 ;;
esac
echo "==> Listo."
