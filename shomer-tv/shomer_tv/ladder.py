"""
ladder.py — Escalera de calidades (ABR) y lista maestra HLS.

Un canal no sale en una sola resolución: el empaquetador escribe varias
listas de medios (720p, 480p, 360p…) y una lista maestra `index.m3u8`
con `#EXT-X-STREAM-INF`. El reproductor (HLS.js) elige la calidad según
la conexión y el tamaño del vídeo.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from fractions import Fraction

VIDEO_TB = Fraction(1, 90000)


@dataclass(frozen=True)
class Rendition:
    name: str
    height: int
    video_bitrate: str
    bandwidth: int


# De mayor a menor. `bandwidth` es el techo que anuncia la lista (vídeo + audio).
DEFAULT_LADDER = (
    Rendition("1080p", 1080, "4500k", 4_800_000),
    Rendition("720p", 720, "2500k", 2_800_000),
    Rendition("480p", 480, "1200k", 1_400_000),
    Rendition("360p", 360, "700k", 900_000),
)


@dataclass(frozen=True)
class Variant:
    """Una calidad ya medida, lista para la lista maestra."""
    name: str
    width: int
    height: int
    bandwidth: int
    uri: str


def parse_bitrate(value: str) -> int:
    """'2500k' → 2500000, '4.5m' → 4500000, '128000' → 128000."""
    s = str(value).strip().lower()
    if not s:
        raise ValueError("bitrate vacío")
    if s.endswith("k"):
        return int(float(s[:-1]) * 1_000)
    if s.endswith("m"):
        return int(float(s[:-1]) * 1_000_000)
    return int(float(s))


def even_dimensions(src_w: int, src_h: int, height: int) -> tuple[int, int]:
    """Alto pedido (par) y ancho par que conserva la proporción."""
    h = height - height % 2
    if src_w <= 0 or src_h <= 0 or h < 2:
        raise ValueError("tamaño de video inválido")
    w = int(round(src_w * h / src_h / 2.0)) * 2
    return max(2, w), h


def select_renditions(frame_height: int, ladder: tuple[Rendition, ...] = DEFAULT_LADDER) -> tuple[Rendition, ...]:
    """Calidades con alto menor o igual al cuadro filtrado. Nunca amplía."""
    height = frame_height - frame_height % 2
    if height < 2:
        raise ValueError("altura de cuadro inválida")
    fit = tuple(r for r in ladder if r.height <= height)
    if fit:
        return fit
    low = ladder[-1]
    return (Rendition(f"{height}p", height, low.video_bitrate, low.bandwidth),)


def render_master(variants: list[Variant]) -> str:
    """Lista HLS multivariante. Las URI son relativas a esta lista."""
    if not variants:
        raise ValueError("la lista maestra necesita al menos una calidad")
    lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
    for v in variants:
        uri = v.uri.replace("\\", "/")
        if uri.startswith("/") or ".." in uri.split("/"):
            raise ValueError(f"URI de variante insegura: {uri}")
        lines.append(
            f'#EXT-X-STREAM-INF:BANDWIDTH={v.bandwidth},RESOLUTION={v.width}x{v.height},NAME="{v.name}"'
        )
        lines.append(uri)
    lines.append("")
    return "\n".join(lines)


def _stream_attrs(line: str) -> dict[str, str]:
    """Atributos de `#EXT-X-STREAM-INF`, respetando comillas (CODECS trae una coma)."""
    body = line.split(":", 1)[1]
    attrs = {}
    i, n = 0, len(body)
    while i < n:
        while i < n and body[i] in ", \t":
            i += 1
        eq = body.find("=", i)
        if eq < 0:
            break
        key = body[i:eq].strip()
        i = eq + 1
        if i < n and body[i] == '"':
            end = body.find('"', i + 1)
            if end < 0:
                end = n - 1
            attrs[key] = body[i + 1:end]
            i = end + 1
        else:
            end = body.find(",", i)
            if end < 0:
                end = n
            attrs[key] = body[i:end].strip()
            i = end
    return attrs


def parse_master(text: str) -> list[dict]:
    """Lee `#EXT-X-STREAM-INF` de una lista maestra (la nuestra o la de ffmpeg)."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.strip() for ln in text.split("\n")]
    found = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF:"):
            attrs = _stream_attrs(line)
            uri = ""
            j = i + 1
            while j < len(lines):
                if lines[j] and not lines[j].startswith("#"):
                    uri = lines[j]
                    break
                j += 1
            bw = attrs.get("BANDWIDTH", "0")
            res = attrs.get("RESOLUTION", "")
            found.append({
                "name": attrs.get("NAME") or res or uri,
                "bandwidth": int(float(bw)) if bw else 0,
                "resolution": res,
                "uri": uri,
            })
            i = j
        i += 1
    return found


def resolve_variant_uri(channel_dir: str, uri: str) -> str | None:
    """Ruta de una lista de medios dentro del canal, o None si se sale de la carpeta."""
    if not uri or uri.startswith(("/", "\\")) or "\\" in uri:
        return None
    parts = uri.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    root = os.path.abspath(channel_dir)
    full = os.path.abspath(os.path.join(root, *parts))
    if full != root and not full.startswith(root + os.sep):
        return None
    return full


def write_master(path: str, variants: list[Variant]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(render_master(variants))
    os.replace(tmp, path)
