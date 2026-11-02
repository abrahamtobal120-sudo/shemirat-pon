"""
catalog.py — Varios canales declarados en un solo archivo.

Cada canal tiene su propia entrada (RTMP o SRT). Un proceso que escucha RTMP
ocupa el puerto entero, así que cada canal en vivo usa un puerto distinto.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from .ladder import parse_bitrate

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$")


@dataclass(frozen=True)
class ChannelSpec:
    name: str
    title: str
    input: str
    listen: bool = False
    retry: bool = False
    vod: bool = False
    realtime: bool = False
    height: int = 720
    abr: bool = True
    bitrate: str = "2500k"


@dataclass(frozen=True)
class Catalog:
    channels: tuple[ChannelSpec, ...]
    host: str = "0.0.0.0"
    port: int = 8080
    open_access: bool = False


def load_catalog(path: str) -> Catalog:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    if isinstance(raw, list):
        raw = {"channels": raw}
    if not isinstance(raw, dict):
        raise ValueError("el catálogo tiene que ser un objeto JSON")
    channels = tuple(_spec(item) for item in raw.get("channels", []))
    names = [c.name for c in channels]
    if len(names) != len(set(names)):
        raise ValueError("hay dos canales con el mismo nombre")
    return Catalog(
        channels=channels,
        host=str(raw.get("host") or "0.0.0.0"),
        port=int(raw.get("port", 8080)),
        open_access=bool(raw.get("open", False)),
    )


def _spec(item: dict) -> ChannelSpec:
    if not isinstance(item, dict):
        raise ValueError("cada canal tiene que ser un objeto")
    name = str(item.get("name", "")).strip()
    if not _NAME.match(name):
        raise ValueError(f"nombre de canal inválido: {name!r}")
    source = str(item.get("input", "")).strip()
    if not source or any(c in source for c in "\r\n"):
        raise ValueError(f"{name}: falta la señal de entrada")
    height = int(item.get("height", 720))
    if height < 144 or height > 2160:
        raise ValueError(f"{name}: altura fuera de rango")
    bitrate = str(item.get("bitrate", "2500k"))
    parse_bitrate(bitrate)
    title = str(item.get("title") or name).strip() or name
    return ChannelSpec(
        name=name,
        title=title,
        input=source,
        listen=bool(item.get("listen", False)),
        retry=bool(item.get("retry", False)),
        vod=bool(item.get("vod", False)),
        realtime=bool(item.get("realtime", False)),
        height=height,
        abr=bool(item.get("abr", True)),
        bitrate=bitrate,
    )


def channel_command(spec: ChannelSpec, out_root: str, python: str = "python") -> list[str]:
    """Argumentos para procesar un canal. RTMP con listen; SRT lleva el modo en la URL."""
    cmd = [python, "-m", "shomer_tv", "channel",
           "--name", spec.name, "--input", spec.input,
           "--height", str(spec.height), "--bitrate", spec.bitrate,
           "--out", out_root]
    if spec.listen:
        cmd.append("--listen")
    if spec.vod:
        cmd.append("--vod")
    if spec.realtime:
        cmd.append("--realtime")
    if spec.retry:
        cmd.append("--retry")
    if not spec.abr:
        cmd.append("--no-abr")
    return cmd


def present_channels(found: list[dict], specs: list[ChannelSpec], *,
                     include_ingest: bool = False) -> list[dict]:
    """Une lo que ya hay en disco con el catálogo, en el orden del catálogo."""
    by_name = {c["name"]: c for c in found}
    ordered = []
    seen = set()
    for spec in specs:
        seen.add(spec.name)
        row = dict(by_name.get(spec.name) or _waiting(spec.name))
        row["title"] = spec.title
        if include_ingest:
            row["ingest"] = spec.input
        ordered.append(row)
    for row in found:
        if row["name"] in seen:
            continue
        extra = dict(row)
        extra.setdefault("title", extra["name"])
        ordered.append(extra)
    return ordered


def _waiting(name: str) -> dict:
    return {"name": name, "state": "waiting", "ad": False, "ad_until": None, "vod": False,
            "url": None, "variants": [], "frames": 0, "speed": 0, "analysis_fps": 0}


def catalog_path_or_none(path: str | None) -> Catalog | None:
    if path and os.path.isfile(path):
        return load_catalog(path)
    return None
