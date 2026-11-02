/**
 * cosmetic-adblock.js — Bloqueo "cosmético" de anuncios en la página.
 *
 * Las reglas de red (rules/ad_rules.json) impiden que se descarguen los
 * anuncios; aquí ocultamos los huecos/contenedores que quedan y los banners
 * servidos desde el propio dominio. Expone `globalThis.ShomerCosmetic`.
 */
(function () {
  'use strict';

  // Selectores genéricos (subconjunto conservador inspirado en EasyList).
  // Se evitan selectores demasiado amplios para no romper el reproductor.
  const SELECTORS = [
    'ins.adsbygoogle',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication"]',
    'iframe[id^="google_ads_iframe"]',
    'div[id^="div-gpt-ad"]',
    'div[id^="google_ads_"]',
    '[data-ad-slot]',
    '[data-google-query-id]',
    '.adsbygoogle',
    '.ad-banner', '.ad_banner', '.banner-ad', '.banner_ad',
    '.ad-container', '.ad_container', '.ad-wrapper', '.ad-slot',
    '.advertisement', '.advertising', '.sponsored-content',
    '.taboola', '[id^="taboola-"]', '.OUTBRAIN', '[data-widget-id^="AR_"]',
    // Overlays de anuncios de reproductores conocidos
    '.ima-ad-container', '.vjs-ima', '.jw-plugin-vast', '.jw-ad-',
    '.ytp-ad-module', '.ytp-ad-overlay-container', '.ytp-ad-player-overlay',
    '.video-ads', '.ad-showing .ytp-ad-text'
  ];

  const STYLE_ID = 'shomer-cosmetic-adblock';

  function enable() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = SELECTORS.join(',\n') +
      ' { display: none !important; visibility: hidden !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  function disable() {
    document.getElementById(STYLE_ID)?.remove();
  }

  /**
   * Detecta si el reproductor de la página está mostrando un anuncio propio
   * (p. ej. YouTube añade la clase `ad-showing`). Se usa como señal extra
   * para el detector de cortes comerciales.
   */
  function playerShowsAd(video) {
    const player = video.closest('.ad-showing, .ad-interrupting, .jw-flag-ads, .vjs-ad-playing');
    return Boolean(player);
  }

  globalThis.ShomerCosmetic = { enable, disable, playerShowsAd };
})();
