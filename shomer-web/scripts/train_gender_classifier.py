"""
train_gender_classifier.py — Entrena y exporta el clasificador de género (cuerpo completo)
que usa Shomer Sport: models/gender.onnx.

Por qué un modelo de CUERPO y no de cara: en una transmisión deportiva las
caras suelen medir pocos píxeles; el cuerpo completo (ropa, silueta, pelo)
da mucha más información.

Datos
-----
Cualquier dataset de atributos de peatones sirve. Recomendado: PA-100K
(100 000 recortes de personas, atributo 0 = "Female"). Uso solo para
investigación/no comercial: revisa su licencia antes de distribuir el modelo.

  Formato A (PA-100K):  --pa100k /ruta/PA-100K   (contiene annotation.mat y data/)
  Formato B (CSV):      --csv datos.csv          (columnas: path,female   con female ∈ {0,1})

Para mejorar mucho la precisión en deporte, añade al CSV recortes propios de
transmisiones (aficionadas, jugadoras, reporteras, porristas, árbitros…).

Requisitos
----------
  pip install torch torchvision timm scipy pillow onnx

Uso
---
  python train_gender_classifier.py --pa100k ~/datasets/PA-100K --out ../models/gender.onnx
  python train_gender_classifier.py --csv mis_recortes.csv --epochs 8 --out ../models/gender.onnx

El ONNX resultante: entrada [B,3,256,128] (normalización ImageNet), salida [B,2]
logits (índice 1 = mujer), lote dinámico. Coincide con models/models.json.
"""
import argparse
import csv
import random
from pathlib import Path

import timm
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms

H, W = 256, 128
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]


def load_pa100k(root: Path):
    from scipy.io import loadmat

    ann = loadmat(str(root / "annotation.mat"))
    img_dir = root / "data"
    if not img_dir.exists():
        img_dir = root / "release_data" / "release_data"

    def split(names_key, labels_key):
        names = [str(n[0][0]) for n in ann[names_key]]
        labels = ann[labels_key][:, 0].astype(int)  # atributo 0 = Female
        return [(img_dir / n, int(l)) for n, l in zip(names, labels)]

    train = split("train_images_name", "train_label") + split("val_images_name", "val_label")
    test = split("test_images_name", "test_label")
    return train, test


def load_csv(path: Path, val_frac=0.1):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            p = Path(r["path"])
            if not p.is_absolute():
                p = path.parent / p
            rows.append((p, int(r["female"])))
    random.Random(0).shuffle(rows)
    n_val = max(1, int(len(rows) * val_frac))
    return rows[n_val:], rows[:n_val]


class Crops(Dataset):
    def __init__(self, items, train):
        self.items = items
        aug = [
            transforms.Resize((H, W)),
            transforms.RandomHorizontalFlip(),
            # Simula transmisiones: personas pequeñas/borrosas, iluminación de estadio.
            transforms.RandomApply([transforms.RandomResizedCrop((H, W), scale=(0.7, 1.0), ratio=(0.4, 0.6))], p=0.5),
            transforms.RandomApply([transforms.GaussianBlur(5, sigma=(0.1, 2.0))], p=0.3),
            transforms.RandomApply([transforms.Resize((H // 4, W // 4)), transforms.Resize((H, W))], p=0.3),
            transforms.ColorJitter(0.3, 0.3, 0.3, 0.05),
        ]
        test = [transforms.Resize((H, W))]
        self.tf = transforms.Compose((aug if train else test) + [transforms.ToTensor(), transforms.Normalize(MEAN, STD)])

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        p, y = self.items[i]
        return self.tf(Image.open(p).convert("RGB")), y


def evaluate(model, loader, device):
    model.eval()
    correct = total = 0
    # Recall de mujeres: es la métrica clave (no queremos que se escapen).
    tp = pos = 0
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            pred = model(x).argmax(1)
            correct += (pred == y).sum().item()
            total += len(y)
            tp += ((pred == 1) & (y == 1)).sum().item()
            pos += (y == 1).sum().item()
    return correct / max(1, total), tp / max(1, pos)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pa100k", type=Path)
    ap.add_argument("--csv", type=Path)
    ap.add_argument("--arch", default="mobilenetv3_small_100")  # ~1.5M parámetros, ~6 MB en ONNX
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--out", type=Path, default=Path("../models/gender.onnx"))
    args = ap.parse_args()

    if args.pa100k:
        train, val = load_pa100k(args.pa100k)
    elif args.csv:
        train, val = load_csv(args.csv)
    else:
        ap.error("Indica --pa100k o --csv")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = timm.create_model(args.arch, pretrained=True, num_classes=2).to(device)

    tl = DataLoader(Crops(train, True), batch_size=args.batch, shuffle=True, num_workers=4)
    vl = DataLoader(Crops(val, False), batch_size=args.batch, num_workers=4)

    # Pesamos más los errores en mujeres (falsos negativos son los que no queremos).
    crit = nn.CrossEntropyLoss(weight=torch.tensor([1.0, 1.5], device=device), label_smoothing=0.05)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.05)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * len(tl))

    for ep in range(args.epochs):
        model.train()
        for i, (x, y) in enumerate(tl):
            x, y = x.to(device), y.to(device)
            loss = crit(model(x), y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            if i % 100 == 0:
                print(f"época {ep + 1} paso {i}/{len(tl)} pérdida {loss.item():.3f}")
        acc, rec = evaluate(model, vl, device)
        print(f"== época {ep + 1}: exactitud {acc:.3f} · recall mujeres {rec:.3f}")

    model.eval().cpu()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model, torch.randn(1, 3, H, W), str(args.out),
        input_names=["input"], output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )
    print(f"Exportado {args.out} — ajusta femaleThreshold en common/settings.js según el recall obtenido.")


if __name__ == "__main__":
    main()
