/**
 * yolo-seg.js — Detección + segmentación de personas con YOLOv8/YOLO11-seg (ONNX).
 *
 * Salidas esperadas del modelo exportado con Ultralytics:
 *   output0: [1, 4 + nc + nm, N]  → cx, cy, w, h, puntuaciones por clase, coeficientes de máscara
 *   output1: [1, nm, ph, pw]      → prototipos de máscara (normalmente nm = 32, ph = pw = S/4)
 * Solo usamos la clase 0 (persona) del dataset COCO.
 * Queda disponible como `self.YoloSeg`.
 */
(function () {
  'use strict';

  const PERSON = 0;
  const MAX_PERSONS = 40;
  const NMS_IOU = 0.5;
  // Umbral de la máscara en logit: 0 equivale a p = 0.5; -0.4 ≈ p = 0.4
  // (un poco más generoso → la máscara cubre algo más: preferimos falsos positivos).
  const MASK_LOGIT_THR = -0.4;

  class YoloSeg {
    /** @param {ort.InferenceSession} session  @param {number} size lado de entrada (p. ej. 384 ó 640) */
    constructor(session, size) {
      this.session = session;
      this.size = size;
      this.canvas = new OffscreenCanvas(size, size);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.input = new Float32Array(3 * size * size);
    }

    /**
     * Ejecuta el modelo sobre `bitmap` (cuadro de análisis).
     * @returns {Promise<{dets: Array, letterbox: object}>}
     */
    async detect(bitmap, confThr) {
      const S = this.size;
      const fw = bitmap.width, fh = bitmap.height;
      const scale = Math.min(S / fw, S / fh);
      const nw = Math.round(fw * scale), nh = Math.round(fh * scale);
      const padX = (S - nw) / 2, padY = (S - nh) / 2;

      // Letterbox: relleno gris 114 como en Ultralytics.
      this.ctx.fillStyle = 'rgb(114,114,114)';
      this.ctx.fillRect(0, 0, S, S);
      this.ctx.drawImage(bitmap, padX, padY, nw, nh);
      const rgba = this.ctx.getImageData(0, 0, S, S).data; // lanza SecurityError si el video está "contaminado"

      // HWC RGBA uint8 → CHW RGB float32 [0,1]
      const plane = S * S, inp = this.input;
      for (let i = 0, p = 0; p < plane; i += 4, p++) {
        inp[p] = rgba[i] / 255;
        inp[p + plane] = rgba[i + 1] / 255;
        inp[p + 2 * plane] = rgba[i + 2] / 255;
      }

      const feeds = { [this.session.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, S, S]) };
      const out = await this.session.run(feeds);

      // Identifica salidas por número de dimensiones (el nombre varía entre exportaciones).
      let pred, proto;
      for (const name of this.session.outputNames) {
        const t = out[name];
        if (t.dims.length === 3) pred = t; else if (t.dims.length === 4) proto = t;
      }
      if (!pred || !proto) throw new Error('El modelo YOLO no parece ser de segmentación (-seg).');

      const [, C, N] = pred.dims;
      const [, nm, ph, pw] = proto.dims;
      const P = pred.data, PR = proto.data;

      // 1) Candidatos de persona por encima del umbral.
      const cands = [];
      for (let i = 0; i < N; i++) {
        const score = P[(4 + PERSON) * N + i];
        if (score < confThr) continue;
        const cx = P[i], cy = P[N + i], w = P[2 * N + i], h = P[3 * N + i];
        cands.push({ i, score, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 });
      }
      cands.sort((a, b) => b.score - a.score);

      // 2) Supresión de no máximos.
      const kept = [];
      for (const c of cands) {
        if (kept.length >= MAX_PERSONS) break;
        if (kept.every((k) => iou(k, c) < NMS_IOU)) kept.push(c);
      }

      // 3) Máscara de cada persona sobre la rejilla de prototipos (recortada a su caja).
      const coef = new Float32Array(nm);
      const dets = kept.map((d) => {
        for (let k = 0; k < nm; k++) coef[k] = P[(C - nm + k) * N + d.i];
        const bx1 = clamp(Math.floor((d.x1 / S) * pw), 0, pw - 1);
        const by1 = clamp(Math.floor((d.y1 / S) * ph), 0, ph - 1);
        const bx2 = clamp(Math.ceil((d.x2 / S) * pw), 0, pw - 1);
        const by2 = clamp(Math.ceil((d.y2 / S) * ph), 0, ph - 1);
        const m = new Uint8Array(pw * ph);
        const pp = pw * ph;
        for (let y = by1; y <= by2; y++) {
          for (let x = bx1; x <= bx2; x++) {
            const idx = y * pw + x;
            let v = 0;
            for (let k = 0; k < nm; k++) v += coef[k] * PR[k * pp + idx];
            if (v > MASK_LOGIT_THR) m[idx] = 255;
          }
        }
        // Caja en coordenadas del cuadro de análisis (deshaciendo el letterbox).
        return {
          score: d.score,
          x1: clamp((d.x1 - padX) / scale, 0, fw), y1: clamp((d.y1 - padY) / scale, 0, fh),
          x2: clamp((d.x2 - padX) / scale, 0, fw), y2: clamp((d.y2 - padY) / scale, 0, fh),
          protoMask: m
        };
      });

      return { dets, letterbox: { S, scale, padX, padY, pw, ph } };
    }

    /**
     * Proyecta la máscara de prototipo de `det` a la rejilla de salida (gw×gh),
     * que cubre el cuadro de análisis completo (fw×fh).
     */
    static projectMask(det, lb, fw, fh, gw, gh) {
      const out = new Uint8Array(gw * gh);
      const gx1 = Math.floor((det.x1 / fw) * gw), gx2 = Math.ceil((det.x2 / fw) * gw);
      const gy1 = Math.floor((det.y1 / fh) * gh), gy2 = Math.ceil((det.y2 / fh) * gh);
      for (let gy = Math.max(0, gy1); gy < Math.min(gh, gy2); gy++) {
        const fy = ((gy + 0.5) / gh) * fh;
        const py = clamp(Math.floor(((fy * lb.scale + lb.padY) / lb.S) * lb.ph), 0, lb.ph - 1);
        for (let gx = Math.max(0, gx1); gx < Math.min(gw, gx2); gx++) {
          const fx = ((gx + 0.5) / gw) * fw;
          const px = clamp(Math.floor(((fx * lb.scale + lb.padX) / lb.S) * lb.pw), 0, lb.pw - 1);
          if (det.protoMask[py * lb.pw + px]) out[gy * gw + gx] = 255;
        }
      }
      return out;
    }
  }

  function iou(a, b) {
    const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const inter = ix * iy;
    const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return ua > 0 ? inter / ua : 0;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  self.YoloSeg = YoloSeg;
})();
