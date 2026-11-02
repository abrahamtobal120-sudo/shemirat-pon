/**
 * sport-autoplay.js — Pone sola la transmisión cuando se busca un deporte.
 *
 * Solo actúa en búsquedas abiertas desde Shomer Sport (`shomer_play=1`, ver
 * common/sports.js). Espera a que YouTube muestre los resultados en vivo y
 * abre el primero cuyo canal tenga la insignia de verificado. Si no hay
 * ninguno, muestra un aviso y no abre nada: los canales sin verificar suelen
 * ser retransmisiones piratas.
 */
(function () {
  'use strict';

  if (location.hostname !== 'www.youtube.com' || location.pathname !== '/results') return;
  if (new URLSearchParams(location.search).get('shomer_play') !== '1') return;

  const TIMEOUT_MS = 15000;
  const started = Date.now();

  function pick() {
    for (const item of document.querySelectorAll('ytd-video-renderer')) {
      const verified = item.querySelector(
        '#channel-info .badge-style-type-verified, #channel-info .badge-style-type-verified-artist, ' +
        'ytd-channel-name .badge-style-type-verified, ytd-channel-name .badge-style-type-verified-artist');
      const link = item.querySelector('a#video-title[href^="/watch"]');
      if (verified && link) return link;
    }
    return null;
  }

  function notice(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;z-index:2147483647;top:70px;left:50%;transform:translateX(-50%);' +
      'background:#1f6feb;color:#fff;padding:10px 16px;border-radius:8px;font:600 14px system-ui,sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  }

  function tick() {
    const link = pick();
    if (link) {
      notice('Shomer Sport: abriendo ' + (link.title || link.textContent.trim()));
      location.assign(link.href);
      return;
    }
    const anyResult = document.querySelector('ytd-video-renderer');
    if (Date.now() - started > TIMEOUT_MS || (anyResult && Date.now() - started > 6000)) {
      notice(anyResult
        ? 'Shomer Sport: no hay canales oficiales en vivo de este deporte ahora. Elige uno de la lista con cuidado.'
        : 'Shomer Sport: ahora no hay transmisiones en vivo de este deporte.');
      return;
    }
    setTimeout(tick, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
})();
