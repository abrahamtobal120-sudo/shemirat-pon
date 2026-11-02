/**
 * mask-utils.js — Utilidades de máscaras binarias (Uint8Array, 0 ó 255).
 * Se cargan en el worker con importScripts y quedan en `self.MaskUtils`.
 */
(function () {
  'use strict';

  /**
   * Dilatación cuadrada separable (máximo en ventana 2r+1), O(w·h·r).
   * Sirve para dar margen de seguridad alrededor de la zona filtrada.
   */
  function dilate(mask, w, h, r) {
    if (r <= 0) return mask;
    const tmp = new Uint8Array(mask.length);
    const out = new Uint8Array(mask.length);
    // Horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!mask[row + x]) continue;
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        for (let k = x0; k <= x1; k++) tmp[row + k] = 255;
      }
    }
    // Vertical
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        if (!tmp[y * w + x]) continue;
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
        for (let k = y0; k <= y1; k++) out[k * w + x] = 255;
      }
    }
    return out;
  }

  /** Cierre morfológico aproximado: dilata r y erosiona r (rellena huecos). */
  function close(mask, w, h, r) {
    const d = dilate(mask, w, h, r);
    // Erosión = complemento de la dilatación del complemento.
    const inv = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) inv[i] = d[i] ? 0 : 255;
    const di = dilate(inv, w, h, r);
    for (let i = 0; i < d.length; i++) d[i] = di[i] ? 0 : 255;
    return d;
  }

  /** Une `src` dentro de `dst` (OR). */
  function unionInto(dst, src) {
    for (let i = 0; i < dst.length; i++) if (src[i]) dst[i] = 255;
  }

  /** Fracción de píxeles activos. */
  function coverage(mask) {
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    return n / mask.length;
  }

  /**
   * Componentes conexas (4-vecindad). Devuelve cajas {x,y,w,h,area} en
   * coordenadas de la máscara.
   */
  function components(mask, w, h) {
    const labels = new Int32Array(w * h);
    const boxes = [];
    const stack = [];
    let next = 1;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || labels[i]) continue;
      let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
      labels[i] = next;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop();
        const px = p % w, py = (p / w) | 0;
        area++;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        const nb = [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, py > 0 ? p - w : -1, py < h - 1 ? p + w : -1];
        for (const q of nb) {
          if (q >= 0 && mask[q] && !labels[q]) { labels[q] = next; stack.push(q); }
        }
      }
      boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
      next++;
    }
    return boxes;
  }

  self.MaskUtils = { dilate, close, unionInto, coverage, components };
})();
