"""
relay.py — Trae una señal remota al mismo origen que la página.

El navegador no puede leer la mayoría de las listas HLS ajenas (CORS / Referer).
El reproductor pide `/stream/<canal>`; aquí se baja el manifiesto, se reescriben
las URI para que también pasen por este relé, y se copian los segmentos.
Solo se abre http(s) y solo de un canal del catálogo.
"""
from __future__ import annotations

import re
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen

# Varios orígenes bloquean el navegador y aceptan un reproductor.
UA = "VLC/3.0.21 LibVLC/3.0.21"
_URI_ATTR = re.compile(r'URI="([^"]+)"')
_PLAYLIST_CT = ("application/vnd.apple.mpegurl", "application/x-mpegurl",
                "audio/mpegurl", "audio/x-mpegurl")


def relay_path(name: str, src: str | None = None) -> str:
    path = "/stream/" + quote(name, safe="-_.")
    if src:
        path += "?src=" + quote(src, safe="")
    return path


def resolve_target(play_url: str, src: str | None) -> str:
    target = (src or play_url).strip()
    if src:
        target = unquote(src)
    parsed = urlparse(target)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("url remota inválida")
    return target


def rewrite_playlist(text: str, name: str, base: str) -> str:
    """Convierte cada URI de la lista en `/stream/<canal>?src=…`."""
    out = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = line.strip()
        if stripped.startswith("#") and "URI=" in stripped:
            def repl(m, _base=base, _name=name):
                return f'URI="{relay_path(_name, urljoin(_base, m.group(1)))}"'
            out.append(_URI_ATTR.sub(repl, line))
        elif stripped and not stripped.startswith("#"):
            out.append(relay_path(name, urljoin(base, stripped)))
        else:
            out.append(line)
    if out and out[-1] != "":
        out.append("")
    return "\n".join(out)


def is_ts(data: bytes) -> bool:
    """Paquete MPEG-TS: 0x47 y, si hay bastante, otro igual 188 bytes más tarde."""
    if not data or data[0] != 0x47:
        return False
    return len(data) < 188 or data[188] == 0x47


def classify(content_type: str, peek: bytes) -> str:
    """'playlist' | 'ts' | 'media' | 'error'. Mira el cuerpo, no la extensión."""
    head = peek.lstrip()
    if head.startswith((b"#EXTM3U", b"#EXTINF")):
        return "playlist"
    if is_ts(peek) or is_ts(head):
        return "ts"
    if head.startswith((b"<", b"{")):
        return "error"
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if ct in _PLAYLIST_CT or ct.endswith("mpegurl"):
        return "playlist"
    if "mp2t" in ct or ct.endswith("/mp2t"):
        return "ts"
    return "media"


def looks_like_playlist(url: str, content_type: str, body: bytes) -> bool:
    return classify(content_type, body) == "playlist"


def open_remote(url: str, *, user_agent: str | None = None):
    """Abre el origen y lee unos pocos bytes para clasificar, sin cerrar la conexión."""
    req = Request(url, headers={
        "User-Agent": user_agent or UA,
        "Accept": "*/*",
        "Referer": f"{urlparse(url).scheme}://{urlparse(url).netloc}/",
    })
    try:
        resp = urlopen(req, timeout=15)
    except HTTPError as e:
        raise ValueError(f"el origen respondió {e.code}") from e
    except URLError as e:
        raise ValueError("no se pudo abrir el origen") from e
    ctype = resp.headers.get("Content-Type", "application/octet-stream")
    peek = resp.read(4096)
    return resp, ctype, peek


def fetch(url: str, *, user_agent: str | None = None, limit: int | None = None):
    """Compatibilidad: si hay `limit`, cierra y devuelve esos bytes."""
    resp, ctype, peek = open_remote(url, user_agent=user_agent)
    if limit is None:
        return resp, ctype, peek
    rest = resp.read(max(0, limit - len(peek))) if limit > len(peek) else b""
    resp.close()
    return None, ctype, peek + rest
