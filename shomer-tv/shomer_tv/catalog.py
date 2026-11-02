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
from .relay import relay_path

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$")
_SLUG = re.compile(r"[^A-Za-z0-9]+")


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
    play_url: str | None = None  # lista M3U: el reproductor abre esta URL, no un canal filtrado


@dataclass(frozen=True)
class Catalog:
    channels: tuple[ChannelSpec, ...]
    host: str = "0.0.0.0"
    port: int = 8080
    open_access: bool = False


def load_catalog(path: str) -> Catalog:
    if path.lower().endswith((".m3u", ".m3u8")):
        return Catalog(channels=tuple(load_m3u(path)))
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    if isinstance(raw, list):
        raw = {"channels": raw}
    if not isinstance(raw, dict):
        raise ValueError("el catálogo tiene que ser un objeto JSON")
    channels = [_spec(item) for item in raw.get("channels", [])]
    playlist = raw.get("playlist")
    if playlist:
        used = {c.name for c in channels}
        channels.extend(load_m3u(_resolve_beside(path, str(playlist)), used))
    names = [c.name for c in channels]
    if len(names) != len(set(names)):
        raise ValueError("hay dos canales con el mismo nombre")
    return Catalog(
        channels=tuple(channels),
        host=str(raw.get("host") or "0.0.0.0"),
        port=int(raw.get("port", 8080)),
        open_access=bool(raw.get("open", False)),
    )


def load_m3u(path: str, used: set[str] | None = None) -> list[ChannelSpec]:
    """Lee una lista M3U/M3U8 de canales. No imprime las URLs."""
    if not os.path.isfile(path):
        raise ValueError(f"no está la lista {path}")
    text = _read_playlist(path)
    channels = []
    used = set(used or ())
    title = ""
    n = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("\ufeff"):
            continue
        if line.startswith("#EXTINF"):
            title = line.rsplit(",", 1)[-1].strip()
            continue
        if line.startswith("#"):
            continue
        n += 1
        name = _unique_name(title, used, n)
        url = line
        channels.append(ChannelSpec(
            name=name, title=title or name, input=url, abr=False, play_url=url))
        title = ""
    if not channels:
        raise ValueError(f"{path}: la lista no tiene canales")
    return channels


def _read_playlist(path: str) -> str:
    with open(path, "rb") as f:
        data = f.read()
    for enc in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _resolve_beside(catalog_path: str, playlist: str) -> str:
    playlist = os.path.expandvars(os.path.expanduser(playlist))
    if os.path.isabs(playlist):
        return playlist
    return os.path.normpath(os.path.join(os.path.dirname(catalog_path), playlist))


def _unique_name(title: str, used: set[str], n: int) -> str:
    base = _SLUG.sub("-", title).strip("-") or f"ch-{n:04d}"
    if not base[0].isalnum():
        base = f"ch-{base}"
    name = base[:41]
    i = 2
    while name in used or not _NAME.match(name):
        suffix = f"-{i}"
        name = (base[:41 - len(suffix)] + suffix)
        i += 1
    used.add(name)
    return name


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
        if not row.get("url") and spec.play_url:
            row["url"] = relay_path(spec.name)
            row["state"] = "live"
            path = spec.play_url.split("?", 1)[0].lower()
            row["kind"] = "hls" if path.endswith((".m3u8", ".m3u")) else "ts"
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
