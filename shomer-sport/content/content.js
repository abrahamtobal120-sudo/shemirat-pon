/**
 * content.js — Punto de entrada del content script.
 *
 *  - Lee los ajustes y reacciona a sus cambios.
 *  - Busca elementos <video> (también los que aparecen después) y crea un
 *    ShomerVideoFilter para cada video principal.
 *  - Oculta por completo los videos pequeños (vistas previas, anuncios en
 *    miniatura): no merece la pena analizarlos y es lo más seguro.
 *  - Crea UN iframe oculto con el motor de inferencia, compartido por todos
 *    los videos del documento.
 *  - Responde al popup con el estado del filtro.
 */
(function () {
  'use strict';

  if (globalThis.__shomerSportLoaded) return;
  globalThis.__shomerSportLoaded = true;

  const MIN_W = 200, MIN_H = 112;      // por debajo: video "pequeño" → se oculta
  const SCAN_MS = 1500;

  let settings = null;
  const filters = new Map();           // video → ShomerVideoFilter
  const hiddenSmall = new Set();       // videos pequeños ocultados

  // ------------------------------------------------------------------ Motor

  const hub = {
    frame: null,
    ready: null,
    /** Devuelve un MessagePort conectado directamente al worker de inferencia. */
    connect() {
      if (!this.ready) {
        this.ready = new Promise((resolve, reject) => {
          const f = document.createElement('iframe');
          f.src = chrome.runtime.getURL('engine/engine.html');
          f.className = 'shomer-engine-frame';
          f.setAttribute('aria-hidden', 'true');
          f.tabIndex = -1;
          const timer = setTimeout(() => reject(new Error('El motor no respondió')), 20000);
          f.addEventListener('load', () => { clearTimeout(timer); resolve(f); }, { once: true });
          (document.body || document.documentElement).appendChild(f);
          this.frame = f;
        });
        this.ready.catch(() => { this.ready = null; });
      }
      return this.ready.then((f) => {
        const ch = new MessageChannel();
        f.contentWindow.postMessage({ type: 'shomer-connect' }, new URL(f.src).origin, [ch.port2]);
        return ch.port1;
      });
    }
  };

  // ------------------------------------------------------------- Escaneo

  function isLarge(v) {
    const w = v.offsetWidth, h = v.offsetHeight;
    return w >= MIN_W && h >= MIN_H;
  }

  function scan() {
    if (!settings || !settings.enabled) return;
    const videos = document.querySelectorAll('video');
    const alive = new Set(videos);

    for (const v of videos) {
      if (isLarge(v)) {
        if (hiddenSmall.has(v)) { hiddenSmall.delete(v); v.classList.remove('shomer-hidden-video'); }
        if (!filters.has(v) && v.parentElement) filters.set(v, new ShomerVideoFilter(v, hub, settings));
      } else if (!filters.has(v)) {
        v.classList.add('shomer-hidden-video');
        hiddenSmall.add(v);
      }
    }
    // Videos que ya no están en el documento
    for (const [v, f] of filters) if (!alive.has(v) || !v.isConnected) { f.destroy(); filters.delete(v); }
    for (const v of hiddenSmall) if (!v.isConnected) hiddenSmall.delete(v);
  }

  function stopAll() {
    for (const f of filters.values()) f.destroy();
    filters.clear();
    for (const v of hiddenSmall) v.classList.remove('shomer-hidden-video');
    hiddenSmall.clear();
  }

  function applySettings(s) {
    settings = s;
    if (s.enabled && s.adBlock) ShomerCosmetic.enable(); else ShomerCosmetic.disable();
    if (!s.enabled) { stopAll(); return; }
    for (const f of filters.values()) f.updateSettings(s);
    scan();
  }

  // ------------------------------------------------------------ Arranque

  ShomerSettings.load().then((s) => {
    applySettings(s);
    const mo = new MutationObserver(() => {
      // Agrupa ráfagas de mutaciones en un solo escaneo.
      if (mo._pending) return;
      mo._pending = true;
      setTimeout(() => { mo._pending = false; scan(); }, 200);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, SCAN_MS); // también detecta cambios de tamaño
  });
  ShomerSettings.onChange(applySettings);

  // -------------------------------------------------------------- Popup

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'shomer-status' && filters.size) {
      const first = filters.values().next().value;
      sendResponse({ hasVideo: true, videos: filters.size, ...first.status() });
    }
    return false; // los marcos sin video no responden (deja contestar a otro)
  });
})();
