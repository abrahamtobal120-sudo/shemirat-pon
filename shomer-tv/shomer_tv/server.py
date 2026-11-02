"""
server.py — Servidor web para los clientes: página de canales + reproductor HLS.

    /                    página principal (web/index.html)
    /api/channels        lista de canales con su estado (status.json de cada uno)
    /hls/<canal>/index.m3u8   lista maestra (varias calidades) o lista única
    /hls/<canal>/<calidad>/   segmentos de esa calidad (.ts) y su lista de medios
    /stream/<canal>           relé HLS de una señal de la lista M3U
    /control             página del operador: marcar inicio/fin de las pausas comerciales
    POST /api/ad         {"channel": "...", "on": true|false, "minutes": 3}
    POST /api/signup     {"email", "password", "name"}   → crea la cuenta e inicia sesión
    POST /api/login      {"email", "password"}
    POST /api/logout
    GET  /api/me         cuenta actual y estado de la suscripción
    /admin               página del operador: clientes y suscripciones
    GET  /api/admin/users
    POST /api/admin/extend {"email", "days", "note"}   (days<=0 cancela)
    POST /api/admin/delete {"email"}

Acceso de los clientes: la lista de canales y el video exigen una sesión con la
suscripción activa (ver accounts.py). Con --open no se pide cuenta. La clave de
acceso antigua (--access-key / SHOMER_ACCESS_KEY, en ?key=… o la cookie `shomer_key`)
sigue funcionando como pase general.

Las páginas del operador (/control, /admin) y su API exigen la clave de operador
(--admin-key o SHOMER_ADMIN_KEY, en ?admin=… o la cookie `shomer_admin`). Sin clave
de operador solo se aceptan desde la propia máquina (localhost).
Para producción conviene poner nginx/CDN delante con HTTPS.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import time
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from .accounts import SESSION_DAYS, Accounts
from .adbreak import get_ad, set_ad
from .catalog import present_channels
from .ladder import parse_master, resolve_variant_uri
from .relay import classify, open_remote, resolve_target, rewrite_playlist

log = logging.getLogger("shomer.server")
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


class _RateLimit:
    """Frena los intentos de contraseña: máx. `limit` fallos por IP en `window` segundos."""

    def __init__(self, limit=10, window=600):
        self.limit, self.window, self.fails = limit, window, {}

    def blocked(self, ip: str) -> bool:
        now = time.time()
        self.fails[ip] = [t for t in self.fails.get(ip, []) if now - t < self.window]
        return len(self.fails[ip]) >= self.limit

    def fail(self, ip: str):
        self.fails.setdefault(ip, []).append(time.time())


def make_handler(hls_root: str, access_key: str | None, admin_key: str | None = None,
                 accounts: Accounts | None = None, channels=None):
    hls_root = os.path.abspath(hls_root)
    limiter = _RateLimit()
    by_name = {c.name: c for c in (channels or [])}

    class Handler(SimpleHTTPRequestHandler):
        extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                          ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t",
                          ".js": "text/javascript", ".json": "application/json"}

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=WEB_DIR, **kw)

        def log_message(self, fmt, *args):
            log.debug("%s %s", self.address_string(), fmt % args)

        # ---------------------------------------------------------- acceso
        def _cookie(self, name: str) -> str:
            c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            return c[name].value if name in c else ""

        def _user(self) -> dict | None:
            return accounts.session_user(self._cookie("shomer_session")) if accounts else None

        def _viewer_status(self) -> int:
            """200 = puede ver, 401 = falta iniciar sesión, 402 = suscripción vencida."""
            if accounts is None and not access_key:
                return 200
            if self._key_ok() or self._admin_ok():
                return 200
            u = self._user()
            if u is None:
                return 401
            return 200 if u["active"] else 402

        def _key_ok(self) -> bool:
            if not access_key:
                return False
            q = parse_qs(urlparse(self.path).query).get("key", [""])[0]
            c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            ck = c["shomer_key"].value if "shomer_key" in c else ""
            return any(v and hmac.compare_digest(v, access_key) for v in (q, ck))

        def _admin_ok(self) -> bool:
            if not admin_key:
                # Detrás de nginx todo llega desde 127.0.0.1: si hay proxy, no se confía en la IP.
                return (self.client_address[0] in ("127.0.0.1", "::1")
                        and not self.headers.get("X-Forwarded-For") and not self.headers.get("X-Real-IP"))
            q = parse_qs(urlparse(self.path).query).get("admin", [""])[0]
            c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            ck = c["shomer_admin"].value if "shomer_admin" in c else ""
            return any(v and hmac.compare_digest(v, admin_key) for v in (q, ck))

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(min(n, 10_000)) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
            return body

        def do_POST(self):
            path = urlparse(self.path).path
            # Solo JSON: un formulario de otra web no puede mandar este tipo sin permiso (CSRF).
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                return self._json({"error": "se espera JSON"}, 415)
            try:
                body = self._body()
            except ValueError:
                return self._json({"error": "JSON inválido"}, 400)
            if path in ("/api/signup", "/api/login", "/api/logout"):
                return self._post_account(path, body)
            if path.startswith("/api/admin/"):
                return self._post_admin(path, body)
            if path != "/api/ad":
                return self._json({"error": "no encontrado"}, 404)
            if not self._admin_ok():
                return self._json({"error": "clave de operador incorrecta"}, 403)
            name = str(body.get("channel", ""))
            if not name or not name.replace("-", "").replace("_", "").isalnum():
                return self._json({"error": "canal inválido"}, 400)
            minutes = body.get("minutes")
            st = set_ad(hls_root, name, bool(body.get("on")), float(minutes) if minutes else None)
            log.info("pausa comercial %s en %s", "ACTIVADA" if st["ad"] else "quitada", name)
            return self._json({"channel": name, **st})

        def _post_account(self, path: str, body: dict):
            if accounts is None:
                return self._json({"error": "las cuentas están desactivadas"}, 404)
            if path == "/api/logout":
                accounts.logout(self._cookie("shomer_session"))
                return self._json({"ok": True}, cookie="shomer_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
            ip = self.client_address[0]
            if limiter.blocked(ip):
                return self._json({"error": "demasiados intentos; espera unos minutos"}, 429)
            try:
                email, pw = str(body.get("email", "")), str(body.get("password", ""))
                if path == "/api/signup":
                    u = accounts.signup(email, pw, str(body.get("name", "")))
                    log.info("cuenta nueva: %s", u["email"])
                else:
                    u = accounts.login(email, pw)
            except ValueError as e:
                limiter.fail(ip)
                return self._json({"error": str(e)}, 400)
            token = u.pop("token")
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
            return self._json(u, cookie=f"shomer_session={token}; Path=/; Max-Age={SESSION_DAYS * 86400}; "
                                        f"HttpOnly; SameSite=Lax{secure}")

        def _post_admin(self, path: str, body: dict):
            if not self._admin_ok():
                return self._json({"error": "clave de operador incorrecta"}, 403)
            if accounts is None:
                return self._json({"error": "las cuentas están desactivadas"}, 404)
            try:
                email = str(body.get("email", ""))
                if path == "/api/admin/extend":
                    u = accounts.extend(email, float(body.get("days", 30)), body.get("note"))
                    log.info("suscripción de %s: %s", email, "activa" if u["active"] else "cancelada")
                    return self._json(u)
                if path == "/api/admin/delete":
                    accounts.delete(email)
                    return self._json({"ok": True})
            except (ValueError, TypeError) as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"error": "no encontrado"}, 404)

        def _json(self, obj, code=200, cookie: str | None = None):
            body = json.dumps(obj).encode()
            self.send_response(code)
            if cookie:
                self.send_header("Set-Cookie", cookie)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/api/me":
                u = self._user()
                return self._json({"accounts": accounts is not None, "user": u,
                                   "status": self._viewer_status()})
            if path == "/api/admin/users":
                if not self._admin_ok():
                    return self._json({"error": "clave de operador incorrecta"}, 403)
                return self._json(accounts.list_users() if accounts else [])
            if path == "/api/channels" or path.startswith("/hls/") or path.startswith("/stream/"):
                st = self._viewer_status()
                if st == 401:
                    return self._json({"error": "inicia sesión"}, 401)
                if st == 402:
                    return self._json({"error": "tu suscripción no está activa"}, 402)
            if path in ("/control", "/admin"):
                if not self._admin_ok():
                    return self._json({"error": "clave de operador incorrecta (?admin=…)"}, 403)
                self.path = path + ".html"
                return super().do_GET()
            if path in ("/control.html", "/admin.html"):
                return self._json({"error": "no encontrado"}, 404)
            if path == "/api/channels":
                return self._json(list_channels(hls_root, channels, include_ingest=self._admin_ok()))
            if path.startswith("/hls/"):
                if path.startswith("/hls/.control/"):
                    return self._json({"error": "no encontrado"}, 404)
                return self._serve_hls(path[len("/hls/"):])
            if path.startswith("/stream/"):
                return self._serve_stream(path[len("/stream/"):])
            return super().do_GET()

        def _serve_hls(self, rel: str):
            full = os.path.abspath(os.path.join(hls_root, rel))
            if not full.startswith(hls_root + os.sep) or not os.path.isfile(full):
                return self._json({"error": "no encontrado"}, 404)
            ctype = self.extensions_map.get(os.path.splitext(full)[1], "application/octet-stream")
            with open(full, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            # La lista cambia cada pocos segundos; los segmentos no cambian nunca.
            # La lista cambia cada segmento. Los .ts no se reescriben; una CDN delante
            # de este mismo origen puede cachearlos un minuto sin saltarse la suscripción.
            self.send_header("Cache-Control",
                             "no-cache" if full.endswith((".m3u8", ".json")) else "public, max-age=60")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _serve_stream(self, rel: str):
            name = unquote(rel.split("/", 1)[0])
            spec = by_name.get(name)
            if spec is None or not spec.play_url:
                return self._json({"error": "no encontrado"}, 404)
            src = parse_qs(urlparse(self.path).query).get("src", [None])[0]
            try:
                target = resolve_target(spec.play_url, src)
            except ValueError:
                return self._json({"error": "url remota inválida"}, 400)
            try:
                resp, ctype, peek = open_remote(target)
            except ValueError as e:
                return self._json({"error": str(e)}, 502)
            kind = classify(ctype, peek)
            if kind == "error":
                resp.close()
                return self._json({"error": "el origen no mandó vídeo"}, 502)
            if kind == "playlist":
                body = peek + resp.read(512_000)
                resp.close()
                data = rewrite_playlist(body.decode("utf-8", errors="replace"), name, target).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t" if kind == "ts" else (ctype or "application/octet-stream"))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                if peek:
                    self.wfile.write(peek)
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                pass
            finally:
                resp.close()

    return Handler


def list_channels(hls_root: str, channels=None, *, include_ingest: bool = False):
    found = []
    if os.path.isdir(hls_root):
        for name in sorted(os.listdir(hls_root)):
            if name.startswith("."):
                continue
            if not os.path.isdir(os.path.join(hls_root, name)):
                continue
            row = _read_channel(hls_root, name)
            if row:
                found.append(row)
    return present_channels(found, list(channels or []), include_ingest=include_ingest)


def _read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _read_channel(hls_root: str, name: str):
    d = os.path.join(hls_root, name)
    index = os.path.join(d, "index.m3u8")
    if not os.path.isfile(index):
        return None
    text = _read_text(index)
    variants = []
    if "#EXT-X-STREAM-INF" in text:
        vod = False
        for item in parse_master(text):
            media = resolve_variant_uri(d, item["uri"])
            if media and "#EXT-X-ENDLIST" in _read_text(media):
                vod = True
            variants.append({"name": item["name"], "bandwidth": item["bandwidth"],
                             "resolution": item["resolution"], "url": f"/hls/{name}/{item['uri']}"})
    else:
        vod = "#EXT-X-ENDLIST" in text
    st = {}
    try:
        with open(os.path.join(d, "status.json"), encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        pass
    state = st.get("state", "unknown")
    # Un canal "en vivo" que no se actualiza hace 15 s se considera caído.
    if state == "live" and time.time() - st.get("updated", 0) > 15:
        state = "down"
    ad = get_ad(hls_root, name)
    return {"name": name, "state": state, "ad": bool(ad.get("ad")) and state == "live",
            "ad_until": ad.get("until") if ad.get("ad") else None, "vod": vod,
            "url": f"/hls/{name}/index.m3u8", "variants": variants,
            "frames": st.get("frames", 0), "speed": st.get("speed", 0),
            "analysis_fps": st.get("analysis_fps", 0)}


def serve(hls_root: str, host: str, port: int, access_key: str | None, admin_key: str | None = None,
          db_path: str | None = None, channels=None):
    """db_path=None → sin cuentas (acceso libre o solo con la clave de acceso)."""
    accounts = Accounts(db_path) if db_path else None
    httpd = ThreadingHTTPServer((host, port), make_handler(
        hls_root, access_key, admin_key, accounts, channels))
    log.info("Servidor en http://%s:%d  (canales en %s)", host, port, os.path.abspath(hls_root))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
