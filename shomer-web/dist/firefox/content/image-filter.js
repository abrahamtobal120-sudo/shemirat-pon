/**
 * image-filter.js — Filtro de imágenes de Shomer Web.
 *
 *  - Mientras una imagen no se ha analizado, el CSS la muestra desenfocada.
 *  - Las imágenes se analizan cuando se acercan a la parte visible de la
 *    página (IntersectionObserver), como mucho MAX_INFLIGHT a la vez.
 *  - Resultado "limpia" → se muestra tal cual. "Filtrada" → se sustituye por
 *    la copia cubierta que devuelve el motor. Si no se puede analizar → se
 *    queda desenfocada (a prueba de fallos).
 *  - Los iconos y miniaturas diminutas no se analizan.
 *
 * Expone `globalThis.ShomerImageFilter`.
 */
(function () {
  'use strict';

  const MIN_NATURAL = 64;      // imágenes más pequeñas (iconos) no se analizan
  const MIN_SHOWN = 40;        // ni las que se muestran a menos de 40×40 px
  const MAX_INFLIGHT = 2;
  const STATE = 'data-shomer-state'; // 'pending' | 'ok' | 'filtered' | 'blocked'

  class ShomerImageFilter {
    constructor(hub) {
      this.hub = hub;
      this.settings = null;
      this.active = false;
      this.canAnalyze = true;     // false en iframes pequeños (anuncios): no cargan el motor
      this.port = null;
      this.portPromise = null;
      this.nextId = 1;
      this.waiting = new Map();   // id → img
      this.queue = [];
      this.inflight = 0;
      this.tracked = new Set();
      this.stats = { ok: 0, filtered: 0, blocked: 0 };

      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { this.io.unobserve(e.target); this._enqueue(e.target); }
      }, { rootMargin: '800px 0px' });

      // Imágenes que cambian de src (carga diferida, carruseles…) → volver a analizar.
      this.attrObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          const img = m.target;
          if (img.tagName !== 'IMG' || !this.tracked.has(img)) continue;
          if (img._shomerOwn && img.src === img._shomerOwn) continue;
          this._reset(img, false);
          this._track(img);
        }
      });
    }

    update(settings, enabled) {
      const prev = this.settings;
      this.settings = settings;
      if (!enabled) { this.stop(); return; }
      document.documentElement.removeAttribute('data-shomer-img');
      if (!this.active) {
        this.active = true;
        this.attrObserver.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
      } else if (prev && ['level', 'cover', 'solidColor'].some((k) => prev[k] !== settings[k])) {
        // Cambió cómo se cubre: volver a analizar todo con los ajustes nuevos.
        for (const img of [...this.tracked]) this._reset(img, true);
      }
      this.scan();
    }

    stop() {
      this.active = false;
      document.documentElement.setAttribute('data-shomer-img', 'off');
      this.attrObserver.disconnect();
      for (const img of [...this.tracked]) this._reset(img, true);
      this.queue = [];
      this.waiting.clear();
    }

    scan() {
      if (!this.active) return;
      for (const img of document.getElementsByTagName('img')) if (!this.tracked.has(img)) this._track(img);
      for (const img of this.tracked) if (!img.isConnected) { this.tracked.delete(img); this.io.unobserve(img); }
    }

    status() {
      return { images: this.tracked.size, ...this.stats };
    }

    // ------------------------------------------------------------ Interno

    _track(img) {
      this.tracked.add(img);
      img.setAttribute(STATE, 'pending');
      this.io.observe(img);
    }

    /** Devuelve la imagen a su estado original. `untrack` = dejar de vigilarla. */
    _reset(img, untrack) {
      if (img._shomerOrig) {
        const o = img._shomerOrig;
        img._shomerOrig = null;
        const own = img._shomerOwn;
        img._shomerOwn = null;
        for (const [src, set] of o.sources) src.setAttribute('srcset', set);
        if (o.srcset != null) img.setAttribute('srcset', o.srcset);
        img.src = o.src;
        if (own) URL.revokeObjectURL(own);
      }
      img._shomerJob = null;
      this.io.unobserve(img);
      if (untrack) { this.tracked.delete(img); img.removeAttribute(STATE); }
    }

    _setState(img, st) {
      img.setAttribute(STATE, st);
      if (st in this.stats) this.stats[st]++;
    }

    _enqueue(img) {
      if (!this.active || !img.isConnected) return;
      if (!img.complete || !img.naturalWidth) {
        img.addEventListener('load', () => this._enqueue(img), { once: true });
        img.addEventListener('error', () => this._setState(img, 'ok'), { once: true }); // imagen rota: nada que ver
        return;
      }
      const url = img.currentSrc || img.src;
      const shownSmall = img.offsetWidth > 0 && img.offsetWidth < MIN_SHOWN && img.offsetHeight < MIN_SHOWN;
      if (!url || Math.min(img.naturalWidth, img.naturalHeight) < MIN_NATURAL || shownSmall ||
          /^data:image\/svg|\.svg(\?|#|$)/i.test(url)) {
        this._setState(img, 'ok');
        return;
      }
      if (!this.canAnalyze) { this._setState(img, 'blocked'); return; }
      this.queue.push(img);
      this._pump();
    }

    async _pump() {
      while (this.inflight < MAX_INFLIGHT && this.queue.length) {
        const img = this.queue.shift();
        if (!img.isConnected || !this.active) continue;
        this.inflight++;
        this._analyze(img).finally(() => { this.inflight--; this._pump(); });
      }
    }

    _getPort() {
      if (!this.portPromise) {
        this.portPromise = this.hub.connect().then((port) => {
          port.onmessage = (ev) => this._onMessage(ev.data);
          this.port = port;
          return port;
        });
        this.portPromise.catch(() => { this.portPromise = null; });
      }
      return this.portPromise;
    }

    async _analyze(img) {
      const url = img.currentSrc || img.src;
      const job = {};
      img._shomerJob = job;
      let port;
      try { port = await this._getPort(); } catch { this._setState(img, 'blocked'); return; }

      const s = this.settings;
      const opts = {
        level: s.level, cover: s.cover, solidColor: s.solidColor,
        personConf: s.personConf, femaleThreshold: s.femaleThreshold,
        minPersonFrac: 0.05, maskDilatePx: s.maskDilatePx
      };
      const id = this.nextId++;
      const msg = { type: 'image', id, opts };
      const transfer = [];
      if (url.startsWith('blob:')) {
        // El motor no puede descargar blobs de la página: le pasamos los píxeles.
        try { msg.bitmap = await createImageBitmap(img); transfer.push(msg.bitmap); } catch { this._setState(img, 'blocked'); return; }
      } else {
        msg.url = url;
      }
      const done = new Promise((resolve) => this.waiting.set(id, { img, job, url, resolve }));
      port.postMessage(msg, transfer);
      await done;
    }

    _onMessage(msg) {
      if (!msg || msg.type !== 'imageResult') return;
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      w.resolve();
      const { img, job, url } = w;
      // La imagen cambió mientras se analizaba: el resultado ya no vale.
      if (img._shomerJob !== job || (img.currentSrc || img.src) !== url || !this.active) return;
      img._shomerJob = null;

      if (msg.verdict === 'clean') { this._setState(img, 'ok'); return; }
      if (msg.verdict !== 'filtered' || !msg.blob) { this._setState(img, 'blocked'); return; }

      // Sustituir por la copia filtrada (incluidas las <source> de un <picture>).
      const sources = [];
      if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
        for (const src of img.parentElement.querySelectorAll('source[srcset]')) {
          sources.push([src, src.getAttribute('srcset')]);
          src.removeAttribute('srcset');
        }
      }
      img._shomerOrig = { src: img.src, srcset: img.getAttribute('srcset'), sources };
      const own = URL.createObjectURL(msg.blob);
      img._shomerOwn = own;
      img.addEventListener('load', () => { if (img._shomerOwn === own) this._setState(img, 'filtered'); }, { once: true });
      img.addEventListener('error', () => { if (img._shomerOwn === own) this._setState(img, 'blocked'); }, { once: true });
      img.removeAttribute('srcset');
      img.src = own;
    }
  }

  globalThis.ShomerImageFilter = ShomerImageFilter;
})();
