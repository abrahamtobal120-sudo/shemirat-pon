"""
packager.py — Empaqueta el vídeo ya filtrado en HLS con varias calidades.

Cada calidad es su propio muxer HLS (segmentos .ts alineados, mismo GOP) y
la lista maestra vive en `<canal>/index.m3u8`. Con `abr=False` queda una
sola lista, como antes.
"""
from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass

import av
import cv2
import numpy as np

from .ladder import VIDEO_TB, Rendition, Variant, even_dimensions, parse_bitrate, select_renditions, write_master

log = logging.getLogger("shomer.packager")


@dataclass
class _Out:
    name: str
    width: int
    height: int
    container: object
    video: object
    audio: object | None
    playlist: str


class HlsPublisher:
    def __init__(self, directory: str, *, abr: bool, video_bitrate: str, preset: str,
                 segment_sec: int, vod: bool):
        self.directory = directory
        self.abr = abr
        self.video_bitrate = video_bitrate
        self.preset = preset
        self.segment_sec = segment_sec
        self.vod = vod
        self._outs: list[_Out] = []
        self._closed = False
        self.opened = False

    def summary(self) -> str:
        return ", ".join(f"{o.name} {o.width}x{o.height}" for o in self._outs) or "—"

    def variant_stats(self) -> list[dict]:
        return [{"name": o.name, "width": o.width, "height": o.height} for o in self._outs]

    def open(self, width: int, height: int, fps: float, has_audio: bool) -> None:
        if os.path.isdir(self.directory):
            shutil.rmtree(self.directory)
        os.makedirs(self.directory)
        try:
            renditions = (select_renditions(height) if self.abr
                          else (Rendition(f"{height}p", height, self.video_bitrate,
                                          parse_bitrate(self.video_bitrate) + 160_000),))
            variants: list[Variant] = []
            for rend in renditions:
                vw, vh = even_dimensions(width, height, rend.height)
                folder = os.path.join(self.directory, rend.name) if self.abr else self.directory
                os.makedirs(folder, exist_ok=True)
                playlist = os.path.join(folder, "index.m3u8")
                container, video, audio = _open_hls(
                    playlist, vw, vh, fps, has_audio, rend.video_bitrate, self.preset, self.segment_sec, self.vod)
                self._outs.append(_Out(rend.name, vw, vh, container, video, audio, playlist))
                if self.abr:
                    variants.append(Variant(rend.name, vw, vh, rend.bandwidth, f"{rend.name}/index.m3u8"))
            if self.abr:
                write_master(os.path.join(self.directory, "index.m3u8"), variants)
            self.opened = True
        except Exception:
            self.close()
            raise

    def write_video(self, t: float, rgb: np.ndarray) -> None:
        pts = int(round(t / VIDEO_TB))
        for out in self._outs:
            frame_rgb = rgb
            if rgb.shape[0] != out.height or rgb.shape[1] != out.width:
                frame_rgb = cv2.resize(rgb, (out.width, out.height), interpolation=cv2.INTER_AREA)
            frame = av.VideoFrame.from_ndarray(frame_rgb, format="rgb24").reformat(format="yuv420p")
            frame.pts, frame.time_base = pts, VIDEO_TB
            for pkt in out.video.encode(frame):
                out.container.mux(pkt)

    def write_audio(self, af, mute: bool) -> None:
        data = af.to_ndarray()
        for out in self._outs:
            if out.audio is None:
                continue
            samples = np.zeros_like(data) if mute else np.array(data, copy=True)
            frame = av.AudioFrame.from_ndarray(samples, format="fltp", layout="stereo")
            frame.sample_rate, frame.pts, frame.time_base = af.sample_rate, af.pts, af.time_base
            for pkt in out.audio.encode(frame):
                out.container.mux(pkt)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for out in self._outs:
            try:
                for pkt in out.video.encode(None):
                    out.container.mux(pkt)
                if out.audio is not None:
                    for pkt in out.audio.encode(None):
                        out.container.mux(pkt)
            except Exception:
                log.exception("al cerrar la calidad %s", out.name)
            finally:
                try:
                    out.container.close()
                except Exception:
                    log.exception("muxer %s", out.name)
            if self.vod:
                _finalize_vod(out.playlist)


def _open_hls(playlist: str, w: int, h: int, fps: float, has_audio: bool, bitrate: str,
              preset: str, segment_sec: int, vod: bool):
    folder = os.path.dirname(playlist)
    hls = {
        "hls_time": str(segment_sec),
        "hls_segment_filename": os.path.join(folder, "seg_%05d.ts"),
        "hls_flags": "independent_segments+temp_file",
    }
    if vod:
        hls.update(hls_playlist_type="event", hls_list_size="0")
    else:
        hls.update(hls_list_size="8", hls_flags=hls["hls_flags"] + "+delete_segments")
    container = av.open(playlist, "w", format="hls", options=hls)
    video = container.add_stream("libx264", rate=round(fps))
    video.width, video.height, video.pix_fmt = w, h, "yuv420p"
    video.codec_context.time_base = VIDEO_TB
    rate = parse_bitrate(bitrate)
    video.bit_rate = rate
    gop = max(1, round(fps * segment_sec))
    video.options = {"preset": preset, "g": str(gop), "keyint_min": str(gop),
                     "sc_threshold": "0", "maxrate": bitrate, "bufsize": str(2 * rate)}
    audio = None
    if has_audio:
        audio = container.add_stream("aac", rate=48000)
        audio.layout = "stereo"
        audio.bit_rate = 128_000
    return container, video, audio


def _finalize_vod(path: str) -> None:
    """Marca la lista como completa para que el reproductor permita adelantar."""
    try:
        with open(path, encoding="utf-8") as f:
            txt = f.read()
        txt = txt.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD")
        if "#EXT-X-ENDLIST" not in txt:
            txt += "#EXT-X-ENDLIST\n"
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(txt)
    except OSError:
        pass
