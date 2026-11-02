"""
detector.py — Máscara de zonas a tapar en un cuadro (versión servidor).

Es el mismo motor que la extensión (engine/inference-worker.js), portado a
Python + ONNX Runtime para correr en el servidor:
  1. YOLOv8-seg   → personas (caja + máscara)
  2. Género       → P(mujer) por persona
  3. Piel         → regla de color dentro de la silueta (modo normal)
                    o la persona completa (modo estricto)
  4. Cierre + dilatación → máscara binaria en una rejilla de baja resolución
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

GRID_W = 256          # ancho de la máscara (el alto sigue la proporción del video)
MAX_PERSONS = 40
NMS_IOU = 0.5
MASK_LOGIT_THR = -0.4  # ≈ p = 0.4: la máscara cubre algo más (preferimos falsos positivos)


@dataclass
class FilterOptions:
    level: str = "normal"          # 'normal' = solo piel | 'strict' = persona completa
    female_threshold: float = 0.35  # P(mujer) desde la cual se filtra (bajo = más estricto)
    person_conf: float = 0.25
    min_person_frac: float = 0.07   # personas más bajas que esta fracción de la altura no se filtran
    mask_dilate_px: int = 6         # margen alrededor de la máscara (px de la rejilla)


def _providers():
    avail = ort.get_available_providers()
    order = ["CUDAExecutionProvider", "CoreMLExecutionProvider", "CPUExecutionProvider"]
    return [p for p in order if p in avail]


def _session(path: str, threads: int) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    if threads:
        so.intra_op_num_threads = threads
    return ort.InferenceSession(path, so, providers=_providers())


class Detector:
    def __init__(self, models_dir: str, threads: int = 0):
        with open(os.path.join(models_dir, "models.json")) as f:
            cfg = json.load(f)
        self.yolo = _session(os.path.join(models_dir, cfg["yolo"]["file"]), threads)
        shape = self.yolo.get_inputs()[0].shape
        self.size = shape[2] if isinstance(shape[2], int) else cfg["yolo"].get("size", 640)

        g = cfg.get("gender")
        gpath = os.path.join(models_dir, g["file"]) if g else None
        if gpath and os.path.exists(gpath):
            self.gender = _session(gpath, threads)
            self.gcfg = {"width": 128, "height": 256, "mean": [0, 0, 0], "std": [1, 1, 1],
                         "output": "softmax", "femaleIndex": 1, "pad": 0.08, **g}
        else:
            self.gender = None  # a prueba de fallos: todas las personas se filtran
        self.provider = self.yolo.get_providers()[0]

    # ------------------------------------------------------------------ YOLO
    def _detect(self, rgb: np.ndarray, conf: float):
        S = self.size
        fh, fw = rgb.shape[:2]
        scale = min(S / fw, S / fh)
        nw, nh = round(fw * scale), round(fh * scale)
        pad_x, pad_y = (S - nw) / 2, (S - nh) / 2
        canvas = np.full((S, S, 3), 114, np.uint8)
        x0, y0 = int(pad_x), int(pad_y)
        canvas[y0:y0 + nh, x0:x0 + nw] = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_LINEAR)
        inp = canvas.transpose(2, 0, 1)[None].astype(np.float32) / 255.0

        outs = self.yolo.run(None, {self.yolo.get_inputs()[0].name: inp})
        pred = next(o for o in outs if o.ndim == 3)[0]    # [C, N]
        proto = next(o for o in outs if o.ndim == 4)[0]   # [nm, ph, pw]
        nm, ph, pw = proto.shape

        scores = pred[4]  # clase 0 = persona
        idx = np.where(scores >= conf)[0]
        if not len(idx):
            return [], None
        cx, cy, w, h = pred[0, idx], pred[1, idx], pred[2, idx], pred[3, idx]
        boxes = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], 1)
        order = np.argsort(-scores[idx])
        kept = []
        for o in order:
            if len(kept) >= MAX_PERSONS:
                break
            if all(_iou(boxes[o], boxes[k]) < NMS_IOU for k in kept):
                kept.append(o)

        dets = []
        protos = proto.reshape(nm, -1)
        for k in kept:
            coef = pred[pred.shape[0] - nm:, idx[k]]
            x1, y1, x2, y2 = boxes[k]
            logits = (coef @ protos).reshape(ph, pw)
            m = np.zeros((ph, pw), np.uint8)
            bx1, by1 = int(np.clip(np.floor(x1 / S * pw), 0, pw - 1)), int(np.clip(np.floor(y1 / S * ph), 0, ph - 1))
            bx2, by2 = int(np.clip(np.ceil(x2 / S * pw), 0, pw - 1)), int(np.clip(np.ceil(y2 / S * ph), 0, ph - 1))
            sub = logits[by1:by2 + 1, bx1:bx2 + 1] > MASK_LOGIT_THR
            m[by1:by2 + 1, bx1:bx2 + 1][sub] = 255
            # Máscara del prototipo (letterbox) → coordenadas del cuadro
            mx0, my0 = pad_x / S * pw, pad_y / S * ph
            mw, mh = nw / S * pw, nh / S * ph
            crop = m[int(my0):int(np.ceil(my0 + mh)), int(mx0):int(np.ceil(mx0 + mw))]
            dets.append({
                "score": float(scores[idx[k]]),
                "x1": float(np.clip((x1 - pad_x) / scale, 0, fw)), "y1": float(np.clip((y1 - pad_y) / scale, 0, fh)),
                "x2": float(np.clip((x2 - pad_x) / scale, 0, fw)), "y2": float(np.clip((y2 - pad_y) / scale, 0, fh)),
                "mask": crop,
            })
        return dets, (fw, fh)

    # ---------------------------------------------------------------- Género
    def _female_probs(self, rgb: np.ndarray, dets) -> list[float]:
        if not dets:
            return []
        if self.gender is None:
            return [1.0] * len(dets)
        c = self.gcfg
        W, H, pad = c["width"], c["height"], c["pad"]
        mean = np.array(c["mean"], np.float32)[:, None, None]
        std = np.array(c["std"], np.float32)[:, None, None]
        fh, fw = rgb.shape[:2]
        batch = np.empty((len(dets), 3, H, W), np.float32)
        for n, d in enumerate(dets):
            bw, bh = d["x2"] - d["x1"], d["y2"] - d["y1"]
            sx, sy = d["x1"] - bw * pad, d["y1"] - bh * pad
            sw, sh = bw * (1 + 2 * pad), bh * (1 + 2 * pad)
            # Transformación afín recorte→W×H con relleno negro fuera de la imagen (igual que el canvas).
            M = np.array([[W / sw, 0, -sx * W / sw], [0, H / sh, -sy * H / sh]], np.float32)
            crop = cv2.warpAffine(rgb, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
            batch[n] = (crop.transpose(2, 0, 1).astype(np.float32) / 255.0 - mean) / std
        name = self.gender.get_inputs()[0].name
        try:
            out = self.gender.run(None, {name: batch})[0]
        except Exception:  # modelo exportado con lote fijo = 1
            out = np.concatenate([self.gender.run(None, {name: batch[i:i + 1]})[0] for i in range(len(dets))])
        out = out.reshape(len(dets), -1)
        if out.shape[1] == 1 or c["output"] == "sigmoid":
            v = out[:, 0]
            return [float(x) if 0 <= x <= 1 else float(1 / (1 + np.exp(-x))) for x in v]
        e = np.exp(out - out.max(1, keepdims=True))
        return list((e[:, c["femaleIndex"]] / e.sum(1)).astype(float))

    # ----------------------------------------------------------------- Total
    def analyze(self, rgb: np.ndarray, opts: FilterOptions):
        """Devuelve (máscara uint8 gh×GRID_W o None, lista de personas)."""
        fh, fw = rgb.shape[:2]
        gw, gh = GRID_W, max(2, round(GRID_W * fh / fw))
        dets, _ = self._detect(rgb, opts.person_conf)
        big = [d for d in dets if (d["y2"] - d["y1"]) / fh >= opts.min_person_frac]
        probs = self._female_probs(rgb, big)

        mask = np.zeros((gh, gw), np.uint8)
        grid = None
        persons = []
        for d, p in zip(big, probs):
            filtered = p >= opts.female_threshold  # duda → se filtra
            persons.append({"box": [round(d["x1"]), round(d["y1"]), round(d["x2"]), round(d["y2"])],
                            "female": round(float(p), 2), "filtered": bool(filtered)})
            if not filtered or d["mask"].size == 0:
                continue
            pm = cv2.resize(d["mask"], (gw, gh), interpolation=cv2.INTER_NEAREST)
            # Solo dentro de la caja de la persona (como projectMask en JS)
            box = np.zeros_like(pm)
            gx1, gx2 = int(d["x1"] / fw * gw), int(np.ceil(d["x2"] / fw * gw))
            gy1, gy2 = int(d["y1"] / fh * gh), int(np.ceil(d["y2"] / fh * gh))
            box[gy1:gy2, gx1:gx2] = 255
            pm &= box
            if opts.level == "strict":
                mask |= pm
            else:
                if grid is None:
                    grid = cv2.resize(rgb, (gw, gh), interpolation=cv2.INTER_AREA)
                skin = _skin_mask(grid) & pm
                mask |= cv2.morphologyEx(skin, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        r = opts.mask_dilate_px
        if r > 0 and mask.any():
            mask = cv2.dilate(mask, np.ones((2 * r + 1, 2 * r + 1), np.uint8))
        return (mask if mask.any() else None), persons


def _skin_mask(rgb: np.ndarray) -> np.ndarray:
    """Regla de piel permisiva (Kovač RGB ∪ YCrCb), igual que engine/skin.js."""
    r, g, b = (rgb[..., i].astype(np.int16) for i in range(3))
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    rgb_rule = (r > 90) & (g > 35) & (b > 15) & (mx - mn > 12) & (np.abs(r - g) > 12) & (r > g) & (r > b)
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cr = (r - y) * 0.713 + 128
    cb = (b - y) * 0.564 + 128
    ycc = (y > 50) & (cr >= 133) & (cr <= 180) & (cb >= 77) & (cb <= 135)
    return np.where(rgb_rule | ycc, 255, 0).astype(np.uint8)


def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0
