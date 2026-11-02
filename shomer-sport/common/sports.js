/**
 * sports.js — Buscador "escribe el deporte y se pone".
 *
 * Abre la búsqueda de YouTube filtrada a transmisiones EN VIVO, con una marca
 * en la URL (`shomer_play=1`) para que content/sport-autoplay.js reproduzca
 * sola la primera transmisión de un canal verificado (oficial). No usa
 * fuentes piratas: si no hay ningún canal verificado en vivo, no reproduce
 * nada y deja elegir a mano.
 * Expone `globalThis.ShomerSports`.
 */
(function () {
  'use strict';

  // Botones rápidos: texto del botón → lo que se busca en YouTube.
  const QUICK = [
    { label: '⚽ Fútbol', query: 'fútbol partido en vivo' },
    { label: '🇲🇽 Liga MX', query: 'Liga MX en vivo' },
    { label: '🏈 NFL', query: 'NFL en vivo' },
    { label: '⚾ Béisbol', query: 'béisbol en vivo' },
    { label: '🏀 Básquet', query: 'basketball en vivo' },
    { label: '🥊 Box', query: 'box en vivo' },
    { label: '🎾 Tenis', query: 'tenis en vivo' },
    { label: '🏉 Rugby', query: 'rugby live' },
    { label: '🏃 Atletismo', query: 'athletics live' },
    { label: '🏎️ Motor', query: 'carrera en vivo' },
    { label: '♟️ Ajedrez', query: 'chess live' },
    { label: '🎮 eSports', query: 'esports en vivo' },
  ];

  // sp=EgJAAQ%3D%3D es el filtro "En vivo" de la búsqueda de YouTube.
  function searchUrl(text) {
    let q = String(text || '').trim();
    if (!q) return null;
    if (!/\b(en vivo|live|directo)\b/i.test(q)) q += ' en vivo';
    return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) +
      '&sp=EgJAAQ%253D%253D&shomer_play=1';
  }

  globalThis.ShomerSports = { QUICK, searchUrl };
})();
