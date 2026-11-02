"""
export_gender_clip.py — Crea models/gender.onnx SIN dataset, con CLIP zero-shot.

Alternativa a train_gender_classifier.py cuando no tienes PA-100K: toma el
codificador de imagen de un CLIP ligero (MobileCLIP2-S0 por defecto, vía
open_clip), precalcula los embeddings de texto "hombre" / "mujer" (varias
plantillas promediadas) y los pliega en una capa lineal final. El ONNX
resultante cumple el contrato de engine/gender.js:

  entrada  [B, 3, 256, 128] float32 en [0,1]  (models.json: mean 0, std 1)
  salida   [B, 2] logits  (índice 1 = mujer, softmax en el motor)

El recorte vertical de la persona se rellena a lo ancho (gris neutro) hasta
el cuadrado que espera CLIP, y la normalización de CLIP se hace dentro del
grafo, así el motor no necesita saber nada de CLIP.

Uso:
  ~/.cache/shomer-sport-venv/bin/pip install open_clip_torch timm
  ~/.cache/shomer-sport-venv/bin/python -I scripts/export_gender_clip.py models
Variables: CLIP_MODEL (MobileCLIP2-S0), CLIP_PRETRAINED (dfndr2b).
"""
import json
import os
import sys
from pathlib import Path

import torch
import torch.nn.functional as F
import open_clip

models_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "models").resolve()
MODEL = os.environ.get("CLIP_MODEL", "MobileCLIP2-S0")
PRETRAINED = os.environ.get("CLIP_PRETRAINED", "dfndr2b")
IN_H, IN_W = 256, 128

# Varias descripciones por clase: el promedio es más robusto que una sola frase.
# Incluye contextos de transmisión deportiva (gradas, banda, presentadoras…).
PROMPTS = {
    "male": [
        "a photo of a man", "a photo of a male athlete", "a man playing soccer",
        "a male football player on the pitch", "a man in the stadium crowd",
        "a male referee", "a male coach on the sideline", "a male sports reporter",
        "a photo of a boy", "a full body photo of a man",
    ],
    "female": [
        "a photo of a woman", "a photo of a female athlete", "a woman playing soccer",
        "a female football player on the pitch", "a woman in the stadium crowd",
        "a cheerleader", "a female sports reporter", "a woman in a dress",
        "a photo of a girl", "a full body photo of a woman",
    ],
}

model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED)
tokenizer = open_clip.get_tokenizer(MODEL)
model.eval()

# Tamaño y normalización del codificador de imagen.
size = model.visual.image_size if hasattr(model.visual, "image_size") else 224
size = size[0] if isinstance(size, (tuple, list)) else int(size)
norm = next(t for t in preprocess.transforms if t.__class__.__name__ == "Normalize")
mean, std = list(norm.mean), list(norm.std)
print(f"{MODEL}/{PRETRAINED}: imagen {size}px, mean={mean}, std={std}")

with torch.no_grad():
    weights = []
    for cls in ("male", "female"):  # índice 0 = hombre, 1 = mujer
        emb = model.encode_text(tokenizer(PROMPTS[cls]))
        emb = F.normalize(emb, dim=-1).mean(0)
        weights.append(F.normalize(emb, dim=-1))
    W = torch.stack(weights)  # [2, D]
    scale = model.logit_scale.exp().item()


class GenderHead(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.visual = model.visual
        self.register_buffer("W", W * scale)
        self.register_buffer("mean", torch.tensor(mean).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(std).view(1, 3, 1, 1))

    def forward(self, x):  # x: [B,3,256,128] en [0,1]
        # Relleno lateral gris hasta cuadrado y escala al tamaño de CLIP.
        pad = (IN_H - IN_W) // 2
        x = F.pad(x, (pad, pad, 0, 0), value=0.5)
        x = F.interpolate(x, size=(size, size), mode="bilinear", align_corners=False)
        x = (x - self.mean) / self.std
        f = F.normalize(self.visual(x), dim=-1)
        return f @ self.W.t()  # [B,2] logits


head = GenderHead().eval()
dummy = torch.rand(2, 3, IN_H, IN_W)
dest = models_dir / "gender.onnx"
torch.onnx.export(
    head, dummy, str(dest), opset_version=17, dynamo=False,
    input_names=["input"], output_names=["logits"],
    dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
)
print(f"Modelo exportado: {dest} ({dest.stat().st_size / 1e6:.1f} MB)")

cfg_path = models_dir / "models.json"
cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
cfg["gender"] = {
    "file": dest.name, "width": IN_W, "height": IN_H,
    "mean": [0, 0, 0], "std": [1, 1, 1],  # la normalización de CLIP va dentro del grafo
    "output": "softmax", "femaleIndex": 1, "pad": 0.08,
    "source": f"clip-zeroshot:{MODEL}/{PRETRAINED}",
}
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
print(f"Actualizado {cfg_path}")
