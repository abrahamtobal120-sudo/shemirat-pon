/**
 * video-filter.js — Filtro de un elemento <video>.
 *
 * Cómo garantizamos que el usuario NO vea un cuadro sin filtrar:
 *   1. El <video> original se vuelve invisible (opacity: 0) pero sigue reproduciéndose.
 *   2. Cada cuadro nuevo se copia a un búfer (ImageBitmap) con su hora de captura.
 *   3. A ~15 fps se envía una copia reducida al motor (worker) para analizarla.
 *   4. Un <canvas> superpuesto muestra el cuadro de hace `delaySec` segundos,
 *      cuando ya tenemos los resultados del análisis de ANTES y DESPUÉS de él.
 *      La máscara aplicada es la UNIÓN de ambos (interpolación conservadora:
 *      sin parpadeos y sin huecos cuando la persona se mueve).
 *   5. El audio se retrasa lo mismo con Web Audio (DelayNode) para que siga
 *      sincronizado, y se puede silenciar exactamente en los cuadros filtrados.
 *   6. Si el motor se atrasa o falla → se desenfoca el cuadro completo.
 *
 * Expone `globalThis.ShomerVideoFilter`.
 */
(function () {
  'use strict';

  const ANALYSIS_WIDTH = 640;      // ancho de los cuadros enviados al motor
  const BUFFER_MIN_GAP_MS = 30;    // máx. ~33 fps en el búfer (ahorra memoria con videos a 60 fps)
  const MAX_RESULT_GAP_MS = 600;   // un resultado sirve para cuadros a ±600 ms
  const MAX_IN_FLIGHT = 1;         // cuadros en análisis simultáneos por video
  const FILTER_MUTE_COVERAGE = 0.01;

  // Un <video> solo admite UNA llamada a createMediaElementSource en toda su vida,
  // así que guardamos el grafo de audio por elemento y lo reutilizamos.
  const audioGraphs = new WeakMap();

  class VideoFilter {
    /**
     * @param {HTMLVideoElement} video
     * @param {{connect: () => Promise<MessagePort>}} hub  conexión con el motor
     * @param {object} settings
     */
    constructor(video, hub, settings) {
      this.video = video;
      this.hub = hub;
      this.s = settings;
      this.frames = [];         // [{t, bmp}]
      this.results = [];        // [{t, id, gw, gh, mask, coverage, banners, maskCanvas}]
      this.inFlight = 0;
      this.nextId = 1;
      this.lastCapT = 0;
      this.lastAnaT = 0;
      this.engine = { state: 'loading', backend: null, genderMissing: false };
      this.taint = false;
      this.ad = new ShomerAdBreakDetector();
      this.muteUntil = 0;
      this.ourMute = false;      // ¿silenciamos nosotros video.muted? (modo sin Web Audio)
      this.analysisTimes = [];  // para medir fps de análisis
      this.pendingAudio = new Map(); // t de captura → sonoridad del audio en ese instante
      this.drawnFrame = null;
      this.dirty = true;
      this.destroyed = false;
      this._setupDom();
      // El audio se enruta cuando conocemos el origen del medio (ver _setupAudio).
      this.audio = { routed: false };
      if (video.currentSrc) this._setupAudio();
      else video.addEventListener('loadedmetadata', () => !this.destroyed && this._setupAudio(), { once: true });
      this._connect();
      this._bindEvents();
      this._scheduleCapture();
      this._raf = requestAnimationFrame(() => this._render());
    }

    // ------------------------------------------------------------------ DOM

    _setupDom() {
      const v = this.video;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'shomer-overlay-canvas';
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.msg = document.createElement('div');
      this.msg.className = 'shomer-overlay-msg';
      this.msg.hidden = true;
      v.insertAdjacentElement('afterend', this.canvas);
      this.canvas.insertAdjacentElement('afterend', this.msg);
      v.classList.add('shomer-hidden-video');

      // Picture-in-Picture mostraría el video sin filtrar → se desactiva.
      v.disablePictureInPicture = true;

      this.fx = new OffscreenCanvas(2, 2);       // capa de efecto (desenfoque o color)
      this.fxCtx = this.fx.getContext('2d');
      this.tiny = new OffscreenCanvas(2, 2);     // cuadro diminuto para desenfoque barato
      this.tinyCtx = this.tiny.getContext('2d');
    }

    /** Coloca el canvas exactamente encima del video (se llama en cada cuadro de render). */
    _syncPosition() {
      const v = this.video, c = this.canvas, m = this.msg;
      const left = v.offsetLeft + 'px', top = v.offsetTop + 'px';
      const w = v.offsetWidth, h = v.offsetHeight;
      if (c.style.left !== left) { c.style.left = left; m.style.left = left; }
      if (c.style.top !== top) { c.style.top = top; m.style.top = top; }
      if (c.style.width !== w + 'px') { c.style.width = m.style.width = w + 'px'; }
      if (c.style.height !== h + 'px') { c.style.height = m.style.height = h + 'px'; }
      const z = getComputedStyle(v).zIndex;
      if (c.style.zIndex !== z) { c.style.zIndex = z; m.style.zIndex = z; }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bw = Math.max(2, Math.round(w * dpr)), bh = Math.max(2, Math.round(h * dpr));
      if (c.width !== bw || c.height !== bh) {
        c.width = bw; c.height = bh;
        this.dirty = true;
      }
    }

    /** Rectángulo donde se dibuja la imagen dentro del canvas (respeta object-fit). */
    _contentRect() {
      const c = this.canvas, v = this.video;
      const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
      const fit = getComputedStyle(v).objectFit;
      if (fit === 'fill') return { x: 0, y: 0, w: c.width, h: c.height };
      const scale = fit === 'cover' ? Math.max(c.width / vw, c.height / vh) : Math.min(c.width / vw, c.height / vh);
      const w = vw * scale, h = vh * scale;
      return { x: (c.width - w) / 2, y: (c.height - h) / 2, w, h };
    }

    /** @param {'loading'|'ad'|'blocked'} kind  estilo del aviso (icono) */
    _showMessage(title, sub, kind) {
      const lang = this.s.lang;
      this.msg.dir = ShomerI18n.t(lang, 'dir');
      const key = kind + '|' + title + '|' + (sub || '');
      if (this.msg.dataset.key !== key) {
        this.msg.dataset.key = key;
        this.msg.dataset.kind = kind;
        this.msg.textContent = '';
        const icon = document.createElement('div');
        icon.className = 'shomer-msg-icon';
        this.msg.appendChild(icon);
        const b = document.createElement('div');
        b.className = 'shomer-msg-title';
        b.textContent = title;
        this.msg.appendChild(b);
        if (sub) {
          const s = document.createElement('div');
          s.className = 'shomer-msg-sub';
          s.textContent = sub;
          this.msg.appendChild(s);
        }
      }
      this.msg.hidden = false;
    }

    _hideMessage() { this.msg.hidden = true; }

    /** Aviso mientras no hay análisis utilizable: cargando, analizando o error del motor. */
    _showEngineWait() {
      const L = this.s.lang, st = this.engine.state;
      if (st === 'error') {
        this._showMessage(ShomerI18n.t(L, 'statusError'), this.engine.error, 'blocked');
      } else {
        this._showMessage(ShomerI18n.t(L, st === 'ready' ? 'engineFailSafe' : 'statusLoading'),
          ShomerI18n.t(L, 'engineFailSafeSub'), 'loading');
      }
    }

    // ---------------------------------------------------------------- Audio

    _setupAudio() {
      const v = this.video;
      let g = audioGraphs.get(v);
      if (!g) {
        g = { routed: false };
        // Web Audio silencia los medios de otro origen sin CORS; en ese caso no enrutamos.
        const src = v.currentSrc || v.src || '';
        let sameOrigin = src.startsWith('blob:') || src.startsWith('data:') || v.crossOrigin != null;
        if (!sameOrigin) {
          try { sameOrigin = new URL(src, location.href).origin === location.origin; } catch { /* nada */ }
        }
        if (sameOrigin) {
          try {
            const ctx = new AudioContext({ latencyHint: 'playback' });
            const source = ctx.createMediaElementSource(v);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            const delay = ctx.createDelay(4);
            const gain = ctx.createGain();
            source.connect(analyser);
            source.connect(delay).connect(gain).connect(ctx.destination);
            g = { routed: true, ctx, source, analyser, delay, gain, buf: new Float32Array(analyser.fftSize) };
            const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
            v.addEventListener('play', resume);
            window.addEventListener('pointerdown', resume, true);
            window.addEventListener('keydown', resume, true);
            resume();
          } catch (e) {
            // La página ya conectó este video a su propio AudioContext.
            g = { routed: false };
          }
        }
        audioGraphs.set(v, g);
      }
      this.audio = g;
      this._applyAudioDelay();
    }

    _applyAudioDelay() {
      const a = this.audio;
      if (a.routed) a.delay.delayTime.setTargetAtTime(this.s.delaySec, a.ctx.currentTime, 0.05);
    }

    /** Sonoridad (dBFS) del audio en vivo, antes del retraso. */
    _audioDb() {
      const a = this.audio;
      if (!a.routed) return null;
      a.analyser.getFloatTimeDomainData(a.buf);
      let sum = 0;
      for (let i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
      return 10 * Math.log10(sum / a.buf.length + 1e-12);
    }

    _setMuted(muted) {
      const a = this.audio;
      if (a.routed) {
        a.gain.gain.setTargetAtTime(muted ? 0 : 1, a.ctx.currentTime, 0.02);
      } else if (muted && !this.video.muted) {
        this.video.muted = true; this.ourMute = true;
      } else if (!muted && this.ourMute) {
        this.video.muted = false; this.ourMute = false;
      }
    }

    // --------------------------------------------------------------- Motor

    async _connect() {
      try {
        this.port = await this.hub.connect();
      } catch (e) {
        this.engine = { state: 'error', error: String(e) };
        return;
      }
      if (this.destroyed) { this.port.close(); return; }
      this.port.onmessage = (ev) => this._onEngineMessage(ev.data);
      this.port.postMessage({ type: 'hello' });
    }

    _onEngineMessage(msg) {
      if (msg.type === 'status') {
        this.engine = msg;
        return;
      }
      if (msg.type === 'error') {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.pendingAudio.delete(msg.t);
        if (msg.code === 'tainted') this.taint = true;
        if (msg.code === 'engine') this.engine = { ...this.engine, state: 'error', error: msg.message };
        return;
      }
      if (msg.type !== 'result') return;
      this.inFlight = Math.max(0, this.inFlight - 1);
      const audioDb = this.pendingAudio.get(msg.t) ?? null;
      this.pendingAudio.delete(msg.t);
      const now = performance.now();
      this.analysisTimes.push(now);
      while (this.analysisTimes.length && now - this.analysisTimes[0] > 2000) this.analysisTimes.shift();

      const r = {
        t: msg.t, id: msg.id, gw: msg.gw, gh: msg.gh, mask: msg.mask, coverage: msg.coverage,
        banners: (msg.broadcast && msg.broadcast.banners) || [], maskCanvas: null
      };
      // Insertar ordenado por tiempo
      let i = this.results.length;
      while (i > 0 && this.results[i - 1].t > r.t) i--;
      this.results.splice(i, 0, r);

      if (this.s.adBlock) {
        const domAd = ShomerCosmetic.playerShowsAd(this.video);
        const confirmMs = Math.max(1000, this.s.delaySec * 1000 - 300);
        this.ad.observe(msg.t, msg.broadcast, audioDb, domAd, confirmMs);
      }
      this.dirty = true;
    }

    // -------------------------------------------------------------- Captura

    _scheduleCapture() {
      if (this.destroyed) return;
      const v = this.video;
      if ('requestVideoFrameCallback' in v) {
        this._rvfc = v.requestVideoFrameCallback(() => { this._capture(); this._scheduleCapture(); });
      } else {
        // Respaldo: sondeo con requestAnimationFrame cuando cambia currentTime.
        this._lastTime = -1;
        const poll = () => {
          if (this.destroyed) return;
          if (v.currentTime !== this._lastTime) { this._lastTime = v.currentTime; this._capture(); }
          this._pollRaf = requestAnimationFrame(poll);
        };
        this._pollRaf = requestAnimationFrame(poll);
      }
    }

    async _capture() {
      const v = this.video;
      if (!v.videoWidth || !v.videoHeight) return;
      const t = performance.now();
      const aspect = v.videoWidth / v.videoHeight;

      // 1) Búfer de visualización
      if (t - this.lastCapT >= BUFFER_MIN_GAP_MS) {
        this.lastCapT = t;
        const dh = Math.min(v.videoHeight, this.s.displayMaxHeight);
        const dw = Math.round(dh * aspect);
        createImageBitmap(v, { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'medium' })
          .then((bmp) => {
            if (this.destroyed) { bmp.close(); return; }
            let i = this.frames.length;
            while (i > 0 && this.frames[i - 1].t > t) i--;
            this.frames.splice(i, 0, { t, bmp });
          })
          .catch(() => {});
      }

      // 2) Cuadro de análisis
      const interval = 1000 / this.s.analysisFps;
      if (this.port && this.engine.state === 'ready' && this.inFlight < MAX_IN_FLIGHT && t - this.lastAnaT >= interval) {
        this.lastAnaT = t;
        this.inFlight++;
        const aw = Math.min(ANALYSIS_WIDTH, v.videoWidth);
        const ah = Math.round(aw / aspect);
        // El worker no conoce el audio: lo anotamos para cuando vuelva el resultado.
        this.pendingAudio.set(t, this._audioDb());
        try {
          const bitmap = await createImageBitmap(v, { resizeWidth: aw, resizeHeight: ah, resizeQuality: 'low' });
          if (this.destroyed || !this.port) { bitmap.close(); this.inFlight--; return; }
          const s = this.s;
          this.port.postMessage({
            type: 'frame', id: this.nextId++, t, bitmap, adState: this.ad.state,
            opts: {
              level: s.level, personConf: s.personConf, femaleThreshold: s.femaleThreshold,
              minPersonFrac: s.minPersonFrac, maskDilatePx: s.maskDilatePx, adBlock: s.adBlock
            }
          }, [bitmap]);
        } catch (e) {
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.pendingAudio.delete(t);
        }
      }
    }

    // --------------------------------------------------------------- Render

    _render() {
      if (this.destroyed) return;
      this._raf = requestAnimationFrame(() => this._render());
      this._syncPosition();

      const now = performance.now();
      const target = now - this.s.delaySec * 1000;

      // Avanza el búfer hasta el cuadro más reciente que ya "toca" mostrar.
      while (this.frames.length > 1 && this.frames[1].t <= target) {
        const old = this.frames.shift();
        if (old !== this.drawnFrame) old.bmp.close();
      }
      const cur = this.frames.length && this.frames[0].t <= target ? this.frames[0] : null;

      // Limpia resultados viejos.
      while (this.results.length > 2 && this.results[1].t < target - 2000) this.results.shift();

      if (!cur) {
        if (!this.drawnFrame) {
          this.ctx.fillStyle = '#000';
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
          // Aún no hay cuadros con el retraso cumplido: avisar en vez de un recuadro negro mudo.
          if (!this.video.paused) this._showEngineWait(); else this._hideMessage();
        }
        this._updateMute(null);
        return;
      }
      if (cur === this.drawnFrame && !this.dirty) return;
      if (this.drawnFrame && this.drawnFrame !== cur && !this.frames.includes(this.drawnFrame)) {
        this.drawnFrame.bmp.close();
      }
      this.drawnFrame = cur;
      this.dirty = false;
      this._compose(cur);
    }

    _compose(cur) {
      const ctx = this.ctx, c = this.canvas, s = this.s, L = s.lang;
      const rect = this._contentRect();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);

      // --- Corte comercial ---
      if (s.adBlock && this.ad.stateAt(cur.t) === 'ad') {
        ctx.fillStyle = '#14171c';
        ctx.fillRect(0, 0, c.width, c.height);
        this._showMessage(ShomerI18n.t(L, 'adBreak'), ShomerI18n.t(L, 'adBreakSub'), 'ad');
        this._updateMute({ ad: true, coverage: 0 });
        return;
      }

      // --- Video protegido (DRM) o de otro origen sin CORS: no se puede analizar ---
      if (this.video.mediaKeys || this.taint) {
        ctx.fillStyle = '#14171c';
        ctx.fillRect(0, 0, c.width, c.height);
        this._showMessage(ShomerI18n.t(L, 'title'), ShomerI18n.t(L, 'drmWarning'), 'blocked');
        this._updateMute({ ad: false, coverage: 0 });
        return;
      }

      ctx.drawImage(cur.bmp, rect.x, rect.y, rect.w, rect.h);

      // --- Resultados que rodean al cuadro: antes (r0) y después (r1) ---
      let r0 = null, r1 = null;
      for (const r of this.results) {
        if (r.t <= cur.t) r0 = r;
        else { r1 = r; break; }
      }
      const near = [r0, r1].filter((r) => r && Math.abs(r.t - cur.t) <= MAX_RESULT_GAP_MS);

      if (!near.length) {
        // El motor no ha analizado nada cercano → a prueba de fallos.
        if (s.failSafeBlur || this.engine.state !== 'ready') {
          this._cover(cur, rect, null);
          this._showEngineWait();
        } else {
          this._hideMessage();
        }
        this._updateMute({ ad: false, coverage: 1 });
        return;
      }
      this._hideMessage();

      // Unión de máscaras (interpolación conservadora).
      const withMask = near.filter((r) => r.mask);
      if (withMask.length) this._cover(cur, rect, this._unionMaskCanvas(withMask));

      // Banners superpuestos detectados en la transmisión.
      if (s.adBlock) {
        const seen = new Set();
        for (const r of near) {
          for (const b of r.banners) {
            const k = [b.x, b.y, b.w, b.h].map((v) => v.toFixed(2)).join();
            if (seen.has(k)) continue;
            seen.add(k);
            this._coverRect(cur, rect, b);
          }
        }
      }
      this._updateMute({ ad: false, coverage: Math.max(...near.map((r) => r.coverage || 0)) });
    }

    /** Canvas con la unión de máscaras (alfa = zona a cubrir), con caché. */
    _unionMaskCanvas(list) {
      if (list.length === 1) return this._maskCanvas(list[0]);
      const key = list.map((r) => r.id).join('_');
      if (this._unionKey === key) return this._unionCanvas;
      const a = list[0], b = list[1];
      const mc = new OffscreenCanvas(a.gw, a.gh);
      const mctx = mc.getContext('2d');
      mctx.drawImage(this._maskCanvas(a), 0, 0);
      mctx.drawImage(this._maskCanvas(b), 0, 0, a.gw, a.gh); // alfa "source-over" ≈ unión
      this._unionKey = key;
      this._unionCanvas = mc;
      return mc;
    }

    _maskCanvas(r) {
      if (r.maskCanvas) return r.maskCanvas;
      const img = new ImageData(r.gw, r.gh);
      for (let i = 0, j = 3; i < r.mask.length; i++, j += 4) img.data[j] = r.mask[i];
      const mc = new OffscreenCanvas(r.gw, r.gh);
      mc.getContext('2d').putImageData(img, 0, 0);
      r.maskCanvas = mc;
      return mc;
    }

    /** Prepara la capa de efecto (desenfoque fuerte o color sólido) del tamaño de `rect`. */
    _prepareFx(cur, rect) {
      const w = Math.max(2, Math.round(rect.w)), h = Math.max(2, Math.round(rect.h));
      if (this.fx.width !== w || this.fx.height !== h) { this.fx.width = w; this.fx.height = h; }
      const f = this.fxCtx;
      f.globalCompositeOperation = 'source-over';
      f.filter = 'none';
      if (this.s.cover === 'solid') {
        f.fillStyle = this.s.solidColor;
        f.fillRect(0, 0, w, h);
      } else {
        // Desenfoque barato y muy fuerte: reducir 1/24, desenfocar y volver a escalar.
        const tw = Math.max(2, Math.round(w / 24)), th = Math.max(2, Math.round(h / 24));
        if (this.tiny.width !== tw || this.tiny.height !== th) { this.tiny.width = tw; this.tiny.height = th; }
        this.tinyCtx.drawImage(cur.bmp, 0, 0, tw, th);
        f.imageSmoothingEnabled = true;
        f.filter = 'blur(12px)';
        f.drawImage(this.tiny, -12, -12, w + 24, h + 24);
        f.filter = 'none';
      }
      return f;
    }

    /** Cubre la zona de `maskCanvas` (o el cuadro completo si es null). */
    _cover(cur, rect, maskCanvas) {
      const f = this._prepareFx(cur, rect);
      if (maskCanvas) {
        f.globalCompositeOperation = 'destination-in';
        f.imageSmoothingEnabled = true; // bordes suaves al escalar la máscara
        f.drawImage(maskCanvas, 0, 0, this.fx.width, this.fx.height);
        f.globalCompositeOperation = 'source-over';
      }
      this.ctx.drawImage(this.fx, rect.x, rect.y, rect.w, rect.h);
    }

    /** Cubre un rectángulo normalizado (banner). */
    _coverRect(cur, rect, b) {
      this._prepareFx(cur, rect);
      const sx = b.x * this.fx.width, sy = b.y * this.fx.height;
      const sw = b.w * this.fx.width, sh = b.h * this.fx.height;
      this.ctx.drawImage(this.fx, sx, sy, sw, sh,
        rect.x + b.x * rect.w, rect.y + b.y * rect.h, b.w * rect.w, b.h * rect.h);
    }

    _updateMute(info) {
      const now = performance.now();
      let mute = now < this.muteUntil;
      if (info) {
        if (info.ad) mute = true;
        if (this.s.muteOnFilter && info.coverage > FILTER_MUTE_COVERAGE) mute = true;
      }
      if (!this.audio.routed && this.s.adBlock && this.ad.state === 'ad') mute = true; // sin retraso de audio: estado en vivo
      if (mute !== this._lastMute) { this._lastMute = mute; this._setMuted(mute); }
    }

    // --------------------------------------------------------------- Eventos

    _bindEvents() {
      const v = this.video;
      this._onSeeking = () => {
        // Vacía el búfer y silencia mientras el DelayNode aún contiene audio viejo.
        for (const f of this.frames) if (f !== this.drawnFrame) f.bmp.close();
        this.frames = [];
        this.results = [];
        this.muteUntil = performance.now() + this.s.delaySec * 1000;
      };
      this._onNewSource = () => {
        this._onSeeking();
        this.ad.reset();
        this.port && this.port.postMessage({ type: 'reset' });
      };
      this._onPip = () => { document.exitPictureInPicture && document.exitPictureInPicture().catch(() => {}); };
      this._onFullscreen = () => {
        // Si el propio <video> pasa a pantalla completa, nuestro canvas no se vería.
        if (document.fullscreenElement === v) document.exitFullscreen().catch(() => {});
      };
      v.addEventListener('seeking', this._onSeeking);
      v.addEventListener('emptied', this._onNewSource);
      v.addEventListener('enterpictureinpicture', this._onPip);
      document.addEventListener('fullscreenchange', this._onFullscreen);
    }

    // ------------------------------------------------------------ API pública

    updateSettings(s) {
      const levelChanged = s.level !== this.s.level;
      this.s = s;
      this._applyAudioDelay();
      if (levelChanged) this.results = []; // las máscaras viejas eran de otro nivel
      if (this.msg.dataset) delete this.msg.dataset.key;
      this.dirty = true;
    }

    status() {
      return {
        state: this.engine.state,
        backend: this.engine.backend,
        error: this.engine.error,
        genderMissing: this.engine.genderMissing,
        fps: this.analysisTimes.length / 2,
        adState: this.ad.state,
        audioRouted: this.audio.routed,
        taint: this.taint
      };
    }

    destroy() {
      this.destroyed = true;
      cancelAnimationFrame(this._raf);
      cancelAnimationFrame(this._pollRaf);
      if (this._rvfc && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._rvfc);
      const v = this.video;
      v.removeEventListener('seeking', this._onSeeking);
      v.removeEventListener('emptied', this._onNewSource);
      v.removeEventListener('enterpictureinpicture', this._onPip);
      document.removeEventListener('fullscreenchange', this._onFullscreen);
      v.classList.remove('shomer-hidden-video');
      v.disablePictureInPicture = false;
      this.canvas.remove();
      this.msg.remove();
      for (const f of this.frames) f.bmp.close();
      if (this.drawnFrame && !this.frames.includes(this.drawnFrame)) this.drawnFrame.bmp.close();
      this.frames = [];
      // El grafo de audio no se puede deshacer: lo dejamos transparente.
      const a = this.audio;
      if (a.routed) {
        a.delay.delayTime.setTargetAtTime(0, a.ctx.currentTime, 0.05);
        a.gain.gain.setTargetAtTime(1, a.ctx.currentTime, 0.02);
      } else if (this.ourMute) {
        v.muted = false;
      }
      if (this.port) { this.port.postMessage({ type: 'close' }); this.port.close(); }
    }
  }

  globalThis.ShomerVideoFilter = VideoFilter;
})();
