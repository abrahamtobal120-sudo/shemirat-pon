/**
 * gender.js — Clasificación de género por persona (recorte de cuerpo completo).
 *
 * Se espera un modelo ONNX ligero (p. ej. MobileNetV3 entrenado en PA-100K,
 * ver scripts/train_gender_classifier.py) con:
 *   entrada  [B, 3, H, W] float32 normalizada con mean/std
 *   salida   [B, 2] (softmax, índice `femaleIndex` = mujer)  ó  [B, 1] (sigmoide = P(mujer))
 * La configuración viene de models/models.json → "gender".
 * Queda disponible como `self.GenderClassifier`.
 */
(function () {
  'use strict';

  class GenderClassifier {
    constructor(session, cfg) {
      this.session = session;
      this.cfg = Object.assign(
        { width: 128, height: 256, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225],
          output: 'softmax', femaleIndex: 1, pad: 0.08 },
        cfg
      );
      this.canvas = new OffscreenCanvas(this.cfg.width, this.cfg.height);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.batchOk = true; // se desactiva si el modelo no admite lotes dinámicos
    }

    /**
     * Devuelve P(mujer) ∈ [0,1] para cada caja.
     * @param {ImageBitmap} bitmap cuadro de análisis
     * @param {Array<{x1,y1,x2,y2}>} boxes
     */
    async classify(bitmap, boxes) {
      if (!boxes.length) return [];
      const { width: W, height: H, mean, std, pad } = this.cfg;
      const per = 3 * W * H;
      const data = new Float32Array(per * boxes.length);

      boxes.forEach((b, n) => {
        // Recorte con un pequeño margen y relleno negro fuera de la imagen.
        const bw = b.x2 - b.x1, bh = b.y2 - b.y1;
        const sx = b.x1 - bw * pad, sy = b.y1 - bh * pad;
        const sw = bw * (1 + 2 * pad), sh = bh * (1 + 2 * pad);
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, W, H);
        this.ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, W, H);
        const px = this.ctx.getImageData(0, 0, W, H).data;
        const off = n * per, plane = W * H;
        for (let i = 0, p = 0; p < plane; i += 4, p++) {
          data[off + p] = (px[i] / 255 - mean[0]) / std[0];
          data[off + plane + p] = (px[i + 1] / 255 - mean[1]) / std[1];
          data[off + 2 * plane + p] = (px[i + 2] / 255 - mean[2]) / std[2];
        }
      });

      if (this.batchOk) {
        try {
          return await this._run(data, boxes.length);
        } catch (e) {
          // El modelo se exportó con lote fijo = 1: pasamos a una inferencia por persona.
          this.batchOk = false;
        }
      }
      const res = [];
      for (let n = 0; n < boxes.length; n++) {
        res.push(...(await this._run(data.subarray(n * per, (n + 1) * per), 1)));
      }
      return res;
    }

    async _run(data, B) {
      const { width: W, height: H, output, femaleIndex } = this.cfg;
      const input = new ort.Tensor('float32', data, [B, 3, H, W]);
      const out = await this.session.run({ [this.session.inputNames[0]]: input });
      const t = out[this.session.outputNames[0]];
      const k = t.data.length / B;
      const probs = [];
      for (let n = 0; n < B; n++) {
        if (output === 'sigmoid' || k === 1) {
          const v = t.data[n * k];
          probs.push(v >= 0 && v <= 1 ? v : 1 / (1 + Math.exp(-v)));
        } else {
          // softmax sobre las k clases
          let max = -Infinity, sum = 0;
          for (let j = 0; j < k; j++) max = Math.max(max, t.data[n * k + j]);
          const e = [];
          for (let j = 0; j < k; j++) { e[j] = Math.exp(t.data[n * k + j] - max); sum += e[j]; }
          probs.push(e[femaleIndex] / sum);
        }
      }
      return probs;
    }
  }

  self.GenderClassifier = GenderClassifier;
})();
