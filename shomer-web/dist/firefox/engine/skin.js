/**
 * skin.js — Segmentación de piel dentro de la máscara de una persona.
 *
 * Por defecto usa un clasificador de color (unión de las reglas RGB de Kovač
 * y el rango YCrCb clásico): no necesita modelo, es muy rápido y, como solo se
 * aplica DENTRO de la silueta de la persona, sus falsos positivos (arena,
 * madera) casi no importan. Se prioriza la sensibilidad: mejor cubrir de más.
 *
 * Opcionalmente puede usar un modelo ONNX de segmentación de piel
 * (models.json → "skin"), con entrada [1,3,H,W] y salida [1,1,H,W] (sigmoide)
 * o [1,2,H,W] (softmax, canal 1 = piel).
 * Queda disponible como `self.SkinSegmenter`.
 */
(function () {
  'use strict';

  /** ¿El píxel RGB parece piel? (reglas permisivas a propósito) */
  function isSkinRGB(r, g, b) {
    // Regla RGB de Kovač et al. (luz diurna) — relajada un poco.
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const rgbRule = r > 90 && g > 35 && b > 15 && max - min > 12 && Math.abs(r - g) > 12 && r > g && r > b;
    // YCrCb (Chai & Ngan) con márgenes ampliados para focos de estadio.
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cr = (r - y) * 0.713 + 128;
    const cb = (b - y) * 0.564 + 128;
    const ycc = y > 50 && cr >= 133 && cr <= 180 && cb >= 77 && cb <= 135;
    return rgbRule || ycc;
  }

  class SkinSegmenter {
    constructor(session = null, cfg = {}) {
      this.session = session;
      this.cfg = Object.assign({ width: 128, height: 256, mean: [0, 0, 0], std: [1, 1, 1] }, cfg);
      if (session) {
        this.canvas = new OffscreenCanvas(this.cfg.width, this.cfg.height);
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      }
    }

    /**
     * Máscara de piel en la rejilla gw×gh restringida a `personMask`.
     * @param {Uint8ClampedArray} gridRGBA  cuadro reducido al tamaño de la rejilla
     * @param {Uint8Array} personMask
     * @param {object} det caja en coordenadas del cuadro de análisis
     */
    async segment(gridRGBA, personMask, gw, gh, det, bitmap) {
      if (this.session) {
        try { return await this._segmentModel(personMask, gw, gh, det, bitmap); }
        catch (e) { /* si el modelo falla, seguimos con la regla de color */ }
      }
      const out = new Uint8Array(gw * gh);
      for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        if (personMask[i] && isSkinRGB(gridRGBA[j], gridRGBA[j + 1], gridRGBA[j + 2])) out[i] = 255;
      }
      return out;
    }

    async _segmentModel(personMask, gw, gh, det, bitmap) {
      const { width: W, height: H, mean, std } = this.cfg;
      const bw = det.x2 - det.x1, bh = det.y2 - det.y1;
      this.ctx.drawImage(bitmap, det.x1, det.y1, bw, bh, 0, 0, W, H);
      const px = this.ctx.getImageData(0, 0, W, H).data;
      const plane = W * H, data = new Float32Array(3 * plane);
      for (let i = 0, p = 0; p < plane; i += 4, p++) {
        data[p] = (px[i] / 255 - mean[0]) / std[0];
        data[plane + p] = (px[i + 1] / 255 - mean[1]) / std[1];
        data[2 * plane + p] = (px[i + 2] / 255 - mean[2]) / std[2];
      }
      const out = await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, H, W]) });
      const t = out[this.session.outputNames[0]];
      const [, ch, oh, ow] = t.dims;
      const prob = (ox, oy) => {
        const idx = oy * ow + ox;
        if (ch === 1) { const v = t.data[idx]; return v >= 0 && v <= 1 ? v : 1 / (1 + Math.exp(-v)); }
        const a = t.data[idx], b = t.data[oh * ow + idx];
        return 1 / (1 + Math.exp(a - b)); // softmax de 2 clases
      };
      // Proyección de vuelta a la rejilla (umbral bajo 0.35 → más cobertura).
      const fw = bitmap.width, fh = bitmap.height;
      const mask = new Uint8Array(gw * gh);
      for (let gy = 0; gy < gh; gy++) {
        const fy = ((gy + 0.5) / gh) * fh;
        if (fy < det.y1 || fy >= det.y2) continue;
        const oy = Math.min(oh - 1, Math.floor(((fy - det.y1) / bh) * oh));
        for (let gx = 0; gx < gw; gx++) {
          const i = gy * gw + gx;
          if (!personMask[i]) continue;
          const fx = ((gx + 0.5) / gw) * fw;
          if (fx < det.x1 || fx >= det.x2) continue;
          const ox = Math.min(ow - 1, Math.floor(((fx - det.x1) / bw) * ow));
          if (prob(ox, oy) > 0.35) mask[i] = 255;
        }
      }
      return mask;
    }
  }

  self.SkinSegmenter = SkinSegmenter;
})();
