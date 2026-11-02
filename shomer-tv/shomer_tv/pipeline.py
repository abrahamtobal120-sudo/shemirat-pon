"""
pipeline.py — Un canal: señal de entrada → filtro → HLS para los clientes.

    entrada (RTMP/SRT/HLS/archivo) ──PyAV──► cuadros ──► Detector ──► tapado
                                                                     │
                     audio ─────────────────────────► AAC ──► HLS ◄──┘ H.264

El análisis no se hace en todos los cuadros (sería demasiado caro): se analiza
uno cada `1/analysis_fps` segundos y los cuadros intermedios se retienen en un
búfer. Cuando llega el siguiente análisis, cada cuadro retenido se tapa con la
UNIÓN de la máscara anterior y la siguiente, así una jugadora que se mueve entre
dos análisis queda cubierta en todo el trayecto. Ese búfer es el "retraso de
seguridad" de la transmisión.

Con la detección automática de anuncios, la salida (video y audio) va además
`ad_delay_sec` segundos retrasada: cuando el detector confirma un anuncio, los
segundos que tardó en confirmarlo todavía no salieron y también se tapan.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import time
from collections import deque
from dataclasses import dataclass, field
from fractions import Fraction

import av
import cv2
import numpy as np

from .adbreak import AdWatcher, render_slate
from .addetect import AutoAdDetector
from .detector import Detector, FilterOptions

log = logging.getLogger("shomer.pipeline")
VIDEO_TB = Fraction(1, 90000)


@dataclass
class ChannelConfig:
    name: str
    input: str
    out_root: str
    models_dir: str
    height: int = 720             # alto de salida (el ancho sigue la proporción, par)
    analysis_fps: float = 5.0     # análisis por segundo de video como máximo
    max_gap_sec: float = 1.0      # nunca dejar más de esto sin analizar (se frena la salida si hace falta)
    vod: bool = False             # True = archivo completo para ver bajo demanda
    realtime: bool = False        # leer un archivo a velocidad real (simula un canal en vivo)
    listen: bool = False          # RTMP: esperar a que el codificador (OBS) se conecte
    cover: str = "blur"           # 'blur' | 'solid'
    solid_color: tuple = (58, 63, 71)
    bitrate: str = "2500k"
    preset: str = "veryfast"
    segment_sec: int = 2
    threads: int = 0
    auto_ads: bool = True         # detectar los anuncios solos (además del botón del operador)
    ad_delay_sec: float = 4.0     # retraso extra de la salida para tapar el inicio del anuncio
    filter: FilterOptions = field(default_factory=FilterOptions)


class Channel:
    def __init__(self, cfg: ChannelConfig):
        self.cfg = cfg
        self.dir = os.path.join(cfg.out_root, cfg.name)
        self.detector = Detector(cfg.models_dir, cfg.threads)
        self.stats = {"name": cfg.name, "state": "starting", "persons": [], "analysis_ms": 0,
                      "analysis_fps": 0.0, "speed": 0.0, "frames": 0, "filtered_frames": 0,
                      "ad": False, "ad_frames": 0}
        self._last_status = 0.0

    # ------------------------------------------------------------- entrada
    def _open_input(self):
        url = self.cfg.input
        opts = {}
        if url.startswith("rtmp://") and self.cfg.listen:
            opts["listen"] = "1"
        if url.startswith(("rtmp://", "srt://", "http://", "https://", "udp://")):
            opts.setdefault("rw_timeout", str(15_000_000))  # 15 s sin datos = caída de la señal
        return av.open(url, options=opts, timeout=None if self.cfg.listen else 20)

    # -------------------------------------------------------------- salida
    def _open_output(self, w, h, fps, has_audio):
        if os.path.isdir(self.dir):
            shutil.rmtree(self.dir)
        os.makedirs(self.dir)
        hls = {
            "hls_time": str(self.cfg.segment_sec),
            "hls_segment_filename": os.path.join(self.dir, "seg_%05d.ts"),
            "hls_flags": "independent_segments+temp_file",
        }
        if self.cfg.vod:
            hls.update(hls_playlist_type="event", hls_list_size="0")
        else:
            hls.update(hls_list_size="8", hls_flags=hls["hls_flags"] + "+delete_segments")
        out = av.open(os.path.join(self.dir, "index.m3u8"), "w", format="hls", options=hls)

        vs = out.add_stream("libx264", rate=round(fps))
        vs.width, vs.height, vs.pix_fmt = w, h, "yuv420p"
        vs.codec_context.time_base = VIDEO_TB
        vs.bit_rate = _parse_rate(self.cfg.bitrate)
        gop = max(1, round(fps * self.cfg.segment_sec))
        vs.options = {"preset": self.cfg.preset, "g": str(gop), "keyint_min": str(gop),
                      "sc_threshold": "0", "maxrate": self.cfg.bitrate,
                      "bufsize": str(2 * _parse_rate(self.cfg.bitrate))}
        aus = None
        if has_audio:
            aus = out.add_stream("aac", rate=48000)
            aus.layout = "stereo"
            aus.bit_rate = 128_000
        return out, vs, aus

    # ------------------------------------------------------------ tapado
    def _cover(self, rgb: np.ndarray, mask: np.ndarray | None) -> np.ndarray:
        if mask is None:
            return rgb
        h, w = rgb.shape[:2]
        ys, xs = np.nonzero(mask)
        gh, gw = mask.shape
        # Solo se procesa el rectángulo que contiene la máscara (ahorra CPU).
        x1, x2 = int(xs.min() * w / gw), int(np.ceil((xs.max() + 1) * w / gw))
        y1, y2 = int(ys.min() * h / gh), int(np.ceil((ys.max() + 1) * h / gh))
        a = cv2.resize(mask, (w, h), interpolation=cv2.INTER_LINEAR)[y1:y2, x1:x2]
        a = (a.astype(np.float32) / 255.0)[..., None]
        roi = rgb[y1:y2, x1:x2]
        if self.cfg.cover == "solid":
            cov = np.empty_like(roi)
            cov[:] = self.cfg.solid_color
        else:
            # Desenfoque fuerte y barato: reducir ×16, suavizar y volver a ampliar.
            rh, rw = roi.shape[:2]
            small = cv2.resize(roi, (max(1, rw // 16), max(1, rh // 16)), interpolation=cv2.INTER_AREA)
            cov = cv2.resize(cv2.GaussianBlur(small, (0, 0), 1.5), (rw, rh), interpolation=cv2.INTER_LINEAR)
        out = rgb.copy()
        out[y1:y2, x1:x2] = (roi * (1 - a) + cov * a).astype(np.uint8)
        return out

    # ------------------------------------------------------------- estado
    def _write_status(self, force=False):
        now = time.time()
        if not force and now - self._last_status < 1:
            return
        self._last_status = now
        self.stats["updated"] = now
        tmp = os.path.join(self.dir, "status.json.tmp")
        with open(tmp, "w") as f:
            json.dump(self.stats, f)
        os.replace(tmp, os.path.join(self.dir, "status.json"))

    # ------------------------------------------------------------- bucle
    def run(self):
        cfg = self.cfg
        log.info("[%s] abriendo entrada %s", cfg.name, cfg.input)
        inp = self._open_input()
        vin = inp.streams.video[0]
        vin.thread_type = "AUTO"
        ain = inp.streams.audio[0] if inp.streams.audio else None
        fps = float(vin.average_rate or vin.guessed_rate or 25)
        h = cfg.height - cfg.height % 2
        w = round(vin.codec_context.width * h / vin.codec_context.height / 2) * 2
        out, vs, aus = self._open_output(w, h, fps, ain is not None)
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=48000) if ain else None
        log.info("[%s] %dx%d @ %.2f fps, audio=%s, motor=%s → %s", cfg.name, w, h, fps,
                 bool(ain), self.detector.provider, self.dir)

        buf: deque = deque()          # cuadros esperando el siguiente análisis: (t, rgb)
        prev_mask = None              # máscara del último análisis
        last_analysis_t = None
        interval = 1.0 / cfg.analysis_fps
        t0 = None                     # primer instante de la señal (se resta para empezar en 0)
        last_vpts = -1
        wall0 = time.time()
        media_t = 0.0
        analyses = deque(maxlen=20)
        live = cfg.realtime or _is_live(cfg.input)
        wall_first = None             # hora del primer cuadro (para medir el atraso en vivo)
        out_fps = [fps]               # cuadros por segundo de salida (baja si el canal se atrasa)
        last_kept_t = -1.0
        ads = AdWatcher(cfg.out_root, cfg.name)
        slate = render_slate(w, h)
        in_ad = False                 # pausa comercial: se emite la pantalla fija en lugar de la señal
        auto = AutoAdDetector() if cfg.auto_ads else None
        auto_wall = 0.0               # hora en que el detector empezó la pausa actual
        delay = cfg.ad_delay_sec if auto else 0.0
        vq: deque = deque()           # salida retrasada: [t, rgb, máscara]
        aq: deque = deque()           # salida retrasada: [t, AudioFrame, silenciar]
        head_t = 0.0                  # último instante de video leído

        def emit(t, rgb, mask):
            nonlocal last_vpts
            pts = int(round(t / VIDEO_TB))
            if pts <= last_vpts:
                return
            last_vpts = pts
            vq.append([t, rgb, mask])

        def write_video(t, rgb, mask):
            frame = av.VideoFrame.from_ndarray(self._cover(rgb, mask), format="rgb24").reformat(format="yuv420p")
            frame.pts, frame.time_base = int(round(t / VIDEO_TB)), VIDEO_TB
            for pkt in vs.encode(frame):
                out.mux(pkt)
            self.stats["frames"] += 1
            if rgb is slate:
                self.stats["ad_frames"] += 1
            elif mask is not None:
                self.stats["filtered_frames"] += 1

        def write_audio(t, af, mute):
            if mute:  # el audio del anuncio no sale
                z = av.AudioFrame.from_ndarray(np.zeros_like(af.to_ndarray()), format="fltp", layout="stereo")
                z.sample_rate, z.pts, z.time_base = 48000, af.pts, af.time_base
                af = z
            for pkt in aus.encode(af):
                out.mux(pkt)

        def flush(upto):
            while vq and vq[0][0] <= upto:
                write_video(*vq.popleft())
            while aq and aq[0][0] <= upto:
                write_audio(*aq.popleft())

        def mark_ad(since):
            """Tapa lo que todavía no salió a partir de `since` (inicio real del anuncio)."""
            for it in vq:
                if it[0] >= since:
                    it[1], it[2] = slate, None
            for it in aq:
                if it[0] >= since:
                    it[2] = True

        def ad_active():
            manual = ads.active()
            # "Volver al partido" del operador manda sobre la detección automática.
            if auto and auto.in_ad and not manual and ads.state.get("since", 0) > auto_wall:
                log.info("[%s] el operador quitó la pausa automática", cfg.name)
                auto.cancel()
            on = manual or bool(auto and auto.in_ad)
            self.stats["ad_source"] = ("operador" if manual else "auto") if on else None
            return on

        def analyze(t, rgb):
            nonlocal prev_mask, last_analysis_t, interval
            a0 = time.time()
            try:
                mask, persons = self.detector.analyze(rgb, cfg.filter)
            except Exception:
                log.exception("[%s] fallo del análisis: se tapa el cuadro completo", cfg.name)
                mask, persons = np.full((2, 2), 255, np.uint8), []
            ms = (time.time() - a0) * 1000
            analyses.append(time.time())
            # Cuadros intermedios: unión de la máscara anterior y la nueva.
            both = _union(prev_mask, mask)
            while buf:
                bt, brgb = buf.popleft()
                emit(bt, brgb, both)
            emit(t, rgb, mask)
            prev_mask, last_analysis_t = mask, t
            self.stats.update(persons=persons, analysis_ms=round(ms))
            if len(analyses) > 1:
                self.stats["analysis_fps"] = round((len(analyses) - 1) / (analyses[-1] - analyses[0]), 2)
            # En vivo hay que seguir el ritmo de la señal. Si el canal se atrasa, primero se
            # analiza menos seguido (hasta max_gap_sec) y, si no basta, se bajan los cuadros
            # por segundo de salida. Nunca se deja un cuadro sin tapar.
            if live:
                lag = (time.time() - wall_first) - t
                base = max(1.0 / cfg.analysis_fps, ms / 1000 * 2)
                interval = min(cfg.max_gap_sec, base * (1 + max(0.0, lag - 1)))
                if lag > 3 and interval >= cfg.max_gap_sec:
                    out_fps[0] = max(10.0, out_fps[0] * 0.85)
                elif lag < 1:
                    out_fps[0] = min(fps, out_fps[0] * 1.1)
                self.stats.update(lag_sec=round(lag, 1), out_fps=round(out_fps[0], 1))

        self.stats["state"] = "live"
        streams = [s for s in (vin, ain) if s is not None]
        try:
            packets = _safe_demux(inp, streams, cfg.name)
            for packet in packets:
                for frame in packet.decode():
                    if frame.pts is None:
                        continue
                    t_abs = float(frame.pts * frame.time_base)
                    if t0 is None:
                        t0 = t_abs
                    t = t_abs - t0
                    if t < 0:
                        continue
                    if packet.stream is ain:
                        mute = ad_active()
                        for af in resampler.resample(frame):
                            af.pts = int(round(t * 48000))
                            af.time_base = Fraction(1, 48000)
                            aq.append([t, af, mute])
                            t += af.samples / 48000
                        if not delay:
                            flush(head_t)
                        continue

                    media_t = t
                    if wall_first is None:
                        wall_first = time.time()
                    if cfg.realtime:  # simular directo con un archivo
                        ahead = t - (time.time() - wall_first)
                        if ahead > 0:
                            time.sleep(ahead)
                    head_t = t
                    if auto and auto.due(t):
                        ev = auto.update(t, frame.reformat(width=192, height=108, format="gray").to_ndarray())
                        if ev == "end":
                            log.info("[%s] anuncio terminado (detección automática)", cfg.name)
                        elif ev is not None:
                            log.info("[%s] anuncio detectado automáticamente desde t=%.1f s", cfg.name, ev)
                            auto_wall = time.time()
                            mark_ad(ev)
                        self.stats["ad_detector"] = ("aprendiendo" if auto.score is None
                                                     else round(auto.score, 2))
                    if ad_active():
                        if not in_ad:
                            # Lo que estaba retenido también se tapa: el operador suele
                            # marcar el anuncio uno o dos segundos tarde.
                            in_ad = True
                            self.stats["ad"] = True
                            log.info("[%s] pausa comercial: inicio", cfg.name)
                            while buf:
                                bt, _ = buf.popleft()
                                emit(bt, slate, None)
                            prev_mask, last_analysis_t = None, None
                        if t - last_kept_t >= 0.99 / out_fps[0]:
                            last_kept_t = t
                            emit(t, slate, None)
                        continue
                    if in_ad:
                        in_ad = False
                        self.stats["ad"] = False
                        log.info("[%s] pausa comercial: fin", cfg.name)
                    due = last_analysis_t is None or t - last_analysis_t >= interval
                    if not due and t - last_kept_t < 0.99 / out_fps[0]:
                        continue  # cuadro descartado para recuperar el ritmo
                    last_kept_t = t
                    rgb = frame.reformat(width=w, height=h, format="rgb24").to_ndarray()
                    if due:
                        analyze(t, rgb)
                    else:
                        buf.append((t, rgb))
                flush(head_t - delay)
                elapsed = time.time() - wall0
                self.stats["speed"] = round(media_t / elapsed, 2) if elapsed > 0 else 0
                self._write_status()
            # Fin de la señal: los cuadros retenidos se tapan con la última máscara conocida.
            while buf:
                bt, brgb = buf.popleft()
                emit(bt, brgb, prev_mask)
            flush(float("inf"))
            for pkt in vs.encode(None):
                out.mux(pkt)
            if aus:
                for pkt in aus.encode(None):
                    out.mux(pkt)
        finally:
            out.close()
            inp.close()
            self.stats["state"] = "ended"
            self._write_status(force=True)
            if cfg.vod:
                _finalize_vod(os.path.join(self.dir, "index.m3u8"))
        log.info("[%s] terminado: %d cuadros, %d con zonas tapadas", cfg.name,
                 self.stats["frames"], self.stats["filtered_frames"])


def _safe_demux(inp, streams, name):
    """Paquetes de la entrada; si la señal se corta (OBS se desconecta, red caída) termina sin error."""
    it = inp.demux(*streams)
    while True:
        try:
            yield next(it)
        except StopIteration:
            return
        except (av.FFmpegError, OSError) as e:
            log.warning("[%s] la señal se interrumpió: %s", name, e)
            return


def _union(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_NEAREST)
    return np.maximum(a, b)


def _is_live(url: str) -> bool:
    return url.startswith(("rtmp://", "srt://", "udp://", "rtsp://")) or ".m3u8" in url


def _parse_rate(s: str) -> int:
    s = str(s).lower()
    mult = 1_000_000 if s.endswith("m") else 1000 if s.endswith("k") else 1
    return int(float(s.rstrip("km")) * mult)


def _finalize_vod(path: str):
    """Marca la lista como completa para que el reproductor permita adelantar/atrasar."""
    try:
        with open(path) as f:
            txt = f.read()
        txt = txt.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD")
        if "#EXT-X-ENDLIST" not in txt:
            txt += "#EXT-X-ENDLIST\n"
        with open(path, "w") as f:
            f.write(txt)
    except OSError:
        pass
