/**
 * broadcast-analyzer.js — Señales visuales de la transmisión para detectar
 * cortes comerciales y banners superpuestos. Sin modelos: solo estadística
 * de imagen sobre un cuadro reducido (≈192×108), muy barata.
 *
 * Ideas clave:
 *  - Marcador/reloj: es un gráfico superpuesto que NO se mueve mientras la
 *    cámara sí se mueve. Acumulamos la "persistencia" de bordes cuando la
 *    cámara se desplaza; lo que persiste en las franjas superior/inferior es
 *    el marcador (plantilla). Después medimos en cada cuadro qué fracción de
 *    esa plantilla sigue presente → `scoreboardScore`.
 *  - Corte de escena: diferencia de histogramas de color.
 *  - Paleta del partido: histograma promedio del juego (césped, duela…);
 *    los anuncios suelen tener otra paleta → `paletteSim`.
 *  - Banners: bordes que persisten ~0.5 s mientras la cámara se mueve y que
 *    no forman parte del marcador → rectángulos superpuestos nuevos.
 *
 * Queda disponible como `self.BroadcastAnalyzer`.
 */
(function () {
  'use strict';

  const BW = 192;                 // ancho del cuadro reducido
  const EDGE_THR = 48;            // umbral de magnitud Sobel
  const LONG_ALPHA = 0.012;       // persistencia larga (≈ 5–6 s a 15 fps)
  const SHORT_ALPHA = 0.25;       // persistencia corta (≈ 0.3–0.5 s)
  const CAMERA_MOVING = 0.30;     // fracción de píxeles que cambian → la cámara se mueve
  const WARMUP_FRAMES = 240;      // cuadros de aprendizaje antes de fiarnos de la plantilla (~16 s)
  const BLOCK = 8;                // tamaño de bloque para agrupar banners

  class BroadcastAnalyzer {
    constructor() { this.reset(); }

    reset() {
      this.w = 0; this.h = 0;
      this.prevGray = null; this.prevHist = null;
      this.persistLong = null; this.persistShort = null;
      this.learned = 0; this.frameNo = 0;
      this.template = null; this.templateDil = null; this.templateCount = 0;
      this.palette = new Float32Array(64); this.paletteFrames = 0;
      this.lastBanners = []; this.bannersAge = 0;
      this.canvas = null; this.ctx = null;
    }

    _ensure(bitmap) {
      const h = Math.max(2, Math.round((BW * bitmap.height) / bitmap.width));
      if (this.w === BW && this.h === h) return;
      this.reset();
      this.w = BW; this.h = h;
      this.canvas = new OffscreenCanvas(BW, h);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.persistLong = new Float32Array(BW * h);
      this.persistShort = new Float32Array(BW * h);
    }

    /**
     * Analiza un cuadro.
     * @param {ImageBitmap} bitmap
     * @param {string} adState 'game' | 'ad' — se congela el aprendizaje durante anuncios
     */
    update(bitmap, adState) {
      this._ensure(bitmap);
      const { w, h } = this;
      const n = w * h;
      this.ctx.drawImage(bitmap, 0, 0, w, h);
      const rgba = this.ctx.getImageData(0, 0, w, h).data;
      this.frameNo++;

      // Gris + histograma de color 4×4×4
      const gray = new Float32Array(n);
      const hist = new Float32Array(64);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
        gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)] += 1 / n;
      }

      // Bordes (Sobel) binarios
      const edges = new Uint8Array(n);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
          const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
          if (Math.abs(gx) + Math.abs(gy) > EDGE_THR * 2) edges[i] = 255;
        }
      }
      const edgesDil = MaskUtils.dilate(edges, w, h, 1);

      // Movimiento y corte de escena
      let motion = 0, moving = 0, sceneCut = false;
      if (this.prevGray) {
        for (let i = 0; i < n; i++) {
          const d = Math.abs(gray[i] - this.prevGray[i]);
          motion += d;
          if (d > 10) moving++;
        }
        motion /= n * 255;
        let l1 = 0;
        for (let k = 0; k < 64; k++) l1 += Math.abs(hist[k] - this.prevHist[k]);
        sceneCut = l1 / 2 > 0.45;
      }
      const movingFrac = this.prevGray ? moving / n : 0;
      const cameraMoving = movingFrac > CAMERA_MOVING && !sceneCut;
      this.prevGray = gray; this.prevHist = hist;

      // --- Plantilla del marcador (persistencia larga) ---
      const learning = adState !== 'ad' && cameraMoving;
      if (learning) {
        const a = LONG_ALPHA, pl = this.persistLong;
        for (let i = 0; i < n; i++) pl[i] += a * ((edges[i] ? 1 : 0) - pl[i]);
        this.learned++;
      }
      if (this.learned >= WARMUP_FRAMES && (this.frameNo % 30 === 0 || !this.template)) this._rebuildTemplate();

      let scoreboardScore = null;
      if (this.template && this.templateCount >= 30) {
        let hit = 0;
        for (const i of this.template) if (edgesDil[i]) hit++;
        scoreboardScore = hit / this.templateCount;
      }

      // --- Paleta del partido ---
      if (learning && (scoreboardScore === null || scoreboardScore > 0.5)) {
        const a = 0.01;
        for (let k = 0; k < 64; k++) this.palette[k] += a * (hist[k] - this.palette[k]);
        this.paletteFrames++;
      }
      let paletteSim = null;
      if (this.paletteFrames > 120) {
        // Normalizamos la paleta aprendida (la EMA arranca en 0).
        let s = 0;
        for (let k = 0; k < 64; k++) s += this.palette[k];
        let inter = 0;
        for (let k = 0; k < 64; k++) inter += Math.min(this.palette[k] / s, hist[k]);
        paletteSim = inter;
      }

      // --- Banners superpuestos (persistencia corta) ---
      const banners = this._banners(edges, cameraMoving);

      return {
        sceneCut, motion, movingFrac, scoreboardScore,
        templateReady: scoreboardScore !== null, paletteSim, banners
      };
    }

    _rebuildTemplate() {
      const { w, h } = this;
      const m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) {
        const y = (i / w) | 0;
        // El marcador casi siempre está en el 30 % superior o inferior.
        if ((y < h * 0.3 || y > h * 0.7) && this.persistLong[i] > 0.6) m[i] = 255;
      }
      const idx = [];
      for (let i = 0; i < m.length; i++) if (m[i]) idx.push(i);
      this.template = Uint32Array.from(idx);
      this.templateCount = idx.length;
      this.templateDil = MaskUtils.dilate(m, w, h, 3);
    }

    _banners(edges, cameraMoving) {
      const { w, h } = this;
      if (!cameraMoving) {
        // Con la cámara quieta no podemos distinguir gráfico de escenario;
        // mantenemos los últimos banners un máximo de ~2 s.
        this.bannersAge++;
        if (this.bannersAge > 30) this.lastBanners = [];
        return this.lastBanners;
      }
      const ps = this.persistShort;
      for (let i = 0; i < ps.length; i++) ps[i] += SHORT_ALPHA * ((edges[i] ? 1 : 0) - ps[i]);

      const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
      const blocks = new Uint8Array(bw * bh);
      const counts = new Uint16Array(bw * bh);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (ps[i] > 0.8 && !(this.templateDil && this.templateDil[i])) {
            counts[((y / BLOCK) | 0) * bw + ((x / BLOCK) | 0)]++;
          }
        }
      }
      for (let i = 0; i < blocks.length; i++) if (counts[i] >= 5) blocks[i] = 255;
      const closed = MaskUtils.close(blocks, bw, bh, 1);
      const total = bw * bh;
      const boxes = MaskUtils.components(closed, bw, bh)
        .filter((b) => {
          const frac = (b.w * b.h) / total;
          const fill = b.area / (b.w * b.h);
          // Rectángulos razonables: ni motas ni media pantalla, y bastante "llenos".
          return frac >= 0.004 && frac <= 0.3 && fill > 0.45;
        })
        .map((b) => ({
          x: Math.max(0, (b.x - 0.5) / bw), y: Math.max(0, (b.y - 0.5) / bh),
          w: Math.min(1, (b.w + 1) / bw), h: Math.min(1, (b.h + 1) / bh)
        }));
      this.lastBanners = boxes;
      this.bannersAge = 0;
      return boxes;
    }
  }

  self.BroadcastAnalyzer = BroadcastAnalyzer;
})();
