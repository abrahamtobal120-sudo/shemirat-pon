"""
export_yolo.py — Exporta un modelo YOLO de segmentación de Ultralytics a ONNX
y actualiza models/models.json.

Uso: python export_yolo.py yolov8n-seg 384 ../models
"""
import json
import os
import shutil
import sys
from pathlib import Path

from ultralytics import YOLO

name = sys.argv[1] if len(sys.argv) > 1 else "yolov8n-seg"
size = int(sys.argv[2]) if len(sys.argv) > 2 else 384
models_dir = Path(sys.argv[3] if len(sys.argv) > 3 else "models").resolve()

work = Path.home() / ".cache" / "shomer-sport-export"
work.mkdir(parents=True, exist_ok=True)

os.chdir(work)  # Ultralytics descarga los pesos al directorio actual
model = YOLO(f"{name}.pt")  # descarga los pesos oficiales si no existen
# opset 17: compatible con WebGPU/WASM de ONNX Runtime Web. Lote fijo = 1, tamaño fijo.
onnx_path = Path(model.export(format="onnx", imgsz=size, opset=17, simplify=True, dynamic=False, half=False))

dest = models_dir / f"{name}.onnx"
shutil.copy(onnx_path, dest)
print(f"Modelo exportado: {dest} ({dest.stat().st_size / 1e6:.1f} MB)")

cfg_path = models_dir / "models.json"
cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
cfg["yolo"] = {"file": dest.name, "size": size}
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
print(f"Actualizado {cfg_path}")
