"""make_icons.py — Genera los iconos PNG (escudo con balón) sin dependencias externas salvo Pillow."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(sys.argv[1] if len(sys.argv) > 1 else "icons")
out.mkdir(parents=True, exist_ok=True)
for size in (16, 48, 128):
    S = size * 4  # sobremuestreo para bordes suaves
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # Escudo
    d.polygon([(S*.5, S*.04), (S*.92, S*.18), (S*.86, S*.62), (S*.5, S*.96), (S*.14, S*.62), (S*.08, S*.18)],
              fill=(31, 111, 235, 255))
    # Balón
    r = S * .2
    cx, cy = S * .5, S * .47
    d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(255, 255, 255, 255))
    d.regular_polygon((cx, cy, r*.42), 5, fill=(29, 36, 48, 255))
    im.resize((size, size), Image.LANCZOS).save(out / f"icon{size}.png")
print("iconos en", out)
