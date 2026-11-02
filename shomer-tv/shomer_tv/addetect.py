"""
addetect.py — Detección automática de pausas comerciales.

Durante el partido casi todas las transmisiones llevan gráficos fijos en pantalla
(el marcador, el reloj, el logo del canal). En los anuncios esos gráficos desaparecen.

El detector aprende solo, sin configurar nada: mira los bordes de la imagen en las
franjas de arriba y de abajo y se queda con los que no se mueven durante decenas de
segundos (la cámara y los jugadores se mueven; el marcador no). Después compara cada
cuadro con ese "molde":
  - si el molde deja de verse durante `confirm_on` segundos → empieza el anuncio;
  - si vuelve a verse durante `confirm_off` segundos → vuelve el partido.
El inicio se fecha en el último cuadro en que el molde se veía, para que el canal pueda tapar
también esos segundos de confirmación (la salida va retrasada para eso).
"""
from __future__ import annotations

import logging

import cv2
import numpy as np

log = logging.getLogger("shomer.addetect")

W, H = 192, 108          # resolución de trabajo (en gris)
TOP, BOTTOM = 0.28, 0.22  # franjas donde suelen ir marcador y logos


class AutoAdDetector:
    def __init__(self, every=0.5, learn_sec=30.0, confirm_on=3.0, confirm_off=2.0,
                 on_below=0.35, off_above=0.6, max_ad_sec=360.0, min_pixels=25):
        self.every, self.learn_sec = every, learn_sec
        self.confirm_on, self.confirm_off = confirm_on, confirm_off
        self.on_below, self.off_above = on_below, off_above
        self.max_ad_sec, self.min_pixels = max_ad_sec, min_pixels
        self.alpha = every / 20.0          # memoria del molde ≈ 20 s
        band = np.zeros((H, W), bool)
        band[: int(H * TOP)] = True
        band[H - int(H * BOTTOM):] = True
        self.band = band
        self.reset()

    def reset(self):
        self.persist = np.zeros((H, W), np.float32)
        self.learned = 0.0           # segundos de partido aprendidos
        self.template = None         # molde congelado mientras dura el anuncio
        self.in_ad = False
        self.ad_start = None
        self._low_since = None
        self._high_since = None
        self._last_t = None
        self._good_t = None          # último cuadro en que el molde se veía
        self.score = None

    def due(self, t: float) -> bool:
        return self._last_t is None or t - self._last_t >= self.every

    def ready(self) -> bool:
        return self.learned >= self.learn_sec and self._overlay().sum() >= self.min_pixels

    def _overlay(self):
        if self.template is not None:
            return self.template
        return (self.persist > 0.8) & self.band

    def update(self, t: float, gray: np.ndarray):
        """Recibe un cuadro en gris (cualquier tamaño). Devuelve el instante de inicio
        del anuncio si acaba de empezar, "end" si acaba de terminar, o None."""
        self._last_t = t
        small = cv2.resize(gray, (W, H), interpolation=cv2.INTER_AREA)
        edges = cv2.Canny(small, 60, 150) > 0
        near = cv2.dilate(edges.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0

        ready = self.ready()
        if ready:
            ov = self._overlay()
            self.score = float((near & ov).sum()) / float(ov.sum())
        # Aprender solo de cuadros de partido (con el molde a la vista); si no, unos segundos
        # de anuncio bastarían para olvidar el marcador. Una cámara que se mueve no deja huella.
        if not self.in_ad and (not ready or self.score >= self.on_below):
            self.persist += self.alpha * (edges.astype(np.float32) - self.persist)
            self.learned += self.every
        if not ready:
            self.score = None
            return None

        if not self.in_ad:
            if self.score < self.on_below:
                if self._low_since is None:
                    # El anuncio empezó en algún momento después del último cuadro bueno.
                    self._low_since = self._good_t if self._good_t is not None else t
                if t - self._low_since >= self.confirm_on:
                    self.in_ad, self.ad_start = True, self._low_since
                    self.template = ov.copy()
                    self._high_since = None
                    return self.ad_start
            else:
                self._low_since = None
                self._good_t = t
            return None

        if self.score > self.off_above:
            if self._high_since is None:
                self._high_since = t
            if t - self._high_since >= self.confirm_off:
                self._end()
                return "end"
        else:
            self._high_since = None
        if t - self.ad_start > self.max_ad_sec:
            # El molde no vuelve (cambió el marcador, medio tiempo largo…): se vuelve a la
            # señal y se aprende de nuevo, para no dejar el canal tapado para siempre.
            log.warning("pausa automática de más de %.0f s: se vuelve a la señal y se reaprende el marcador",
                        self.max_ad_sec)
            self.reset()
            return "end"
        return None

    def cancel(self):
        """El operador dijo "volver al partido": se respeta y se sigue vigilando."""
        if self.in_ad:
            self._end()

    def _end(self):
        self.in_ad = False
        self.template = None
        self._low_since = self._high_since = None
        self.ad_start = None
        self._good_t = None
