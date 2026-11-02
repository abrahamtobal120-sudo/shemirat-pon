"""
Uso:
  python -m shomer_tv channel --name canal1 --input rtmp://0.0.0.0:1935/live/canal1 --listen
  python -m shomer_tv channel --name final --input partido.mp4 --vod
  python -m shomer_tv serve --port 8080
  python -m shomer_tv ad canal1 on [--minutes 3]      ← pausa comercial (tapa el anuncio)
  python -m shomer_tv ad canal1 off
  python -m shomer_tv users list                       ← clientes y suscripciones
  python -m shomer_tv users extend cliente@correo 30   ← sumar 30 días (0 = cancelar)
"""
import argparse
import logging
import os
import sys
import time

from .detector import FilterOptions

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MODELS = os.path.join(os.path.dirname(ROOT), "shomer-sport", "models")
DEFAULT_OUT = os.path.join(ROOT, "hls")
DEFAULT_DB = os.path.join(ROOT, "data", "accounts.db")


def main(argv=None):
    p = argparse.ArgumentParser(prog="shomer_tv", description="Plataforma de partidos filtrados")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("channel", help="procesar una señal y publicarla como canal HLS")
    c.add_argument("--name", required=True, help="nombre del canal (letras, números, guiones)")
    c.add_argument("--input", required=True, help="rtmp://, srt://, https://…m3u8 o un archivo")
    c.add_argument("--listen", action="store_true", help="RTMP: esperar a que OBS/el codificador se conecte")
    c.add_argument("--vod", action="store_true", help="grabar completo para ver bajo demanda")
    c.add_argument("--realtime", action="store_true", help="leer un archivo a velocidad real (canal simulado)")
    c.add_argument("--retry", action="store_true", help="en vivo: volver a conectar si la señal se cae")
    c.add_argument("--height", type=int, default=720)
    c.add_argument("--analysis-fps", type=float, default=5.0)
    c.add_argument("--max-gap", type=float, default=1.0, help="segundos máximos entre análisis en vivo")
    c.add_argument("--level", choices=["normal", "strict"], default="normal")
    c.add_argument("--cover", choices=["blur", "solid"], default="blur")
    c.add_argument("--female-threshold", type=float, default=0.35)
    c.add_argument("--min-person-frac", type=float, default=0.07)
    c.add_argument("--dilate", type=int, default=6)
    c.add_argument("--bitrate", default="2500k")
    c.add_argument("--preset", default="veryfast")
    c.add_argument("--threads", type=int, default=0)
    c.add_argument("--no-auto-ads", action="store_true",
                   help="no detectar anuncios solo (solo el botón del operador)")
    c.add_argument("--models", default=DEFAULT_MODELS)
    c.add_argument("--out", default=DEFAULT_OUT)

    s = sub.add_parser("serve", help="servidor web para los clientes")
    s.add_argument("--host", default="0.0.0.0")
    s.add_argument("--port", type=int, default=8080)
    s.add_argument("--out", default=DEFAULT_OUT)
    s.add_argument("--access-key", default=os.environ.get("SHOMER_ACCESS_KEY"))
    s.add_argument("--admin-key", default=os.environ.get("SHOMER_ADMIN_KEY"),
                   help="clave del operador para /control y /admin (sin ella, solo desde localhost)")
    s.add_argument("--db", default=DEFAULT_DB, help="base de datos de cuentas de clientes")
    s.add_argument("--open", action="store_true", help="sin cuentas: cualquiera puede ver los canales")

    u = sub.add_parser("users", help="clientes y suscripciones")
    u.add_argument("action", choices=["list", "extend", "delete"])
    u.add_argument("email", nargs="?")
    u.add_argument("days", nargs="?", type=float, default=30, help="días a sumar (0 = cancelar)")
    u.add_argument("--db", default=DEFAULT_DB)

    d = sub.add_parser("ad", help="pausa comercial: tapar (on) o mostrar de nuevo (off) un canal")
    d.add_argument("channel")
    d.add_argument("state", choices=["on", "off"])
    d.add_argument("--minutes", type=float, help="quitar la pausa sola pasado este tiempo")
    d.add_argument("--out", default=DEFAULT_OUT)

    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    if a.cmd == "serve":
        from .server import serve
        serve(a.out, a.host, a.port, a.access_key, a.admin_key, None if a.open else a.db)
        return 0
    if a.cmd == "users":
        from datetime import datetime
        from .accounts import Accounts
        acc = Accounts(a.db)
        if a.action == "list":
            for x in acc.list_users():
                hasta = datetime.fromtimestamp(x["paid_until"]).strftime("%Y-%m-%d") if x["paid_until"] else "—"
                print(f"{x['email']:<35} {'ACTIVA' if x['active'] else 'inactiva':<9} hasta {hasta}  {x['note']}")
            return 0
        if not a.email:
            p.error("falta el correo del cliente")
        try:
            if a.action == "delete":
                acc.delete(a.email)
                print(f"{a.email}: cuenta borrada")
            else:
                x = acc.extend(a.email, a.days)
                print(f"{x['email']}: " + (f"activa hasta {datetime.fromtimestamp(x['paid_until']):%Y-%m-%d}"
                                           if x["active"] else "suscripción cancelada"))
        except ValueError as e:
            p.error(str(e))
        return 0
    if a.cmd == "ad":
        from .adbreak import set_ad
        set_ad(a.out, a.channel, a.state == "on", a.minutes)
        print(f"{a.channel}: pausa comercial {'ACTIVADA' if a.state == 'on' else 'quitada'}")
        return 0

    if not a.name.replace("-", "").replace("_", "").isalnum():
        p.error("--name solo admite letras, números, '-' y '_'")
    from .pipeline import Channel, ChannelConfig
    cfg = ChannelConfig(
        name=a.name, input=a.input, out_root=a.out, models_dir=a.models, height=a.height,
        analysis_fps=a.analysis_fps, max_gap_sec=a.max_gap, vod=a.vod, realtime=a.realtime,
        listen=a.listen, cover=a.cover, bitrate=a.bitrate, preset=a.preset, threads=a.threads,
        auto_ads=not a.no_auto_ads,
        filter=FilterOptions(level=a.level, female_threshold=a.female_threshold,
                             min_person_frac=a.min_person_frac, mask_dilate_px=a.dilate))
    while True:
        try:
            Channel(cfg).run()
        except KeyboardInterrupt:
            return 0
        except Exception as e:  # señal caída, URL inválida, etc.
            logging.error("[%s] %s", a.name, e)
            if not a.retry:
                return 1
        if not a.retry:
            return 0
        logging.info("[%s] reintentando en 5 s…", a.name)
        time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
