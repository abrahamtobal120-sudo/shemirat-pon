"""
adbreak.py — Pausas comerciales: mientras dura un anuncio, el canal no muestra la
señal original sino una pantalla fija ("Pausa comercial") y el audio va en silencio.

La pausa se activa sola (ver addetect.py) o la marca el operador desde la página de control
(/control), con la API o con `python -m shomer_tv ad <canal> on|off`. El estado se
guarda en <hls>/.control/<canal>.json, que el canal consulta varias veces por segundo.
"""
from __future__ import annotations

import json
import os
import time

CONTROL_DIR = ".control"
FONT_PATHS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
              "C:/Windows/Fonts/arialbd.ttf",
              "/System/Library/Fonts/Supplemental/Arial Bold.ttf"]


def control_path(out_root: str, name: str) -> str:
    return os.path.join(out_root, CONTROL_DIR, name + ".json")


def set_ad(out_root: str, name: str, on: bool, minutes: float | None = None) -> dict:
    """Activa o quita la pausa comercial. `minutes` = se quita sola pasado ese tiempo."""
    state = {"ad": bool(on), "since": time.time(),
             "until": time.time() + minutes * 60 if on and minutes else None}
    path = control_path(out_root, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)
    return state


def get_ad(out_root: str, name: str) -> dict:
    try:
        with open(control_path(out_root, name)) as f:
            st = json.load(f)
    except (OSError, ValueError):
        return {"ad": False}
    if st.get("ad") and st.get("until") and time.time() > st["until"]:
        st["ad"] = False
    return st


class AdWatcher:
    """Lee el estado de pausa del canal como mucho cada `every` segundos."""

    def __init__(self, out_root: str, name: str, every: float = 0.2):
        self.out_root, self.name, self.every = out_root, name, every
        self._t = 0.0
        self.state = {"ad": False}

    def active(self) -> bool:
        now = time.time()
        if now - self._t >= self.every:
            self._t = now
            self.state = get_ad(self.out_root, self.name)
        return bool(self.state.get("ad"))


def render_slate(w: int, h: int, title="Pausa comercial", subtitle="El partido continúa enseguida"):
    """Pantalla fija (RGB) que se emite en lugar del anuncio."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (w, h), (15, 19, 24))
    d = ImageDraw.Draw(img)

    def font(size):
        for p in FONT_PATHS:
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
        return ImageFont.load_default()

    def center(text, y, f, fill):
        x0, y0, x1, y1 = d.textbbox((0, 0), text, font=f)
        d.text(((w - (x1 - x0)) / 2, y - (y1 - y0) / 2), text, font=f, fill=fill)

    center("Shomer TV", h * 0.30, font(max(12, h // 20)), (47, 179, 109))
    center(title, h * 0.48, font(max(14, h // 11)), (232, 236, 241))
    center(subtitle, h * 0.62, font(max(10, h // 24)), (138, 149, 163))
    return np.asarray(img)
