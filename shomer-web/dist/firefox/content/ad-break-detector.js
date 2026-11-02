/**
 * ad-break-detector.js — Máquina de estados para detectar cortes comerciales.
 *
 * Combina señales (pesos entre paréntesis):
 *   - Ausencia del marcador/reloj del partido               (0.5)
 *   - Paleta de color distinta a la del partido              (0.3)
 *   - Audio más fuerte/distinto del sonido del estadio       (0.2)
 *   - Muchos cortes de escena (anuncios = montaje rápido)    (0.1)
 *   - El reproductor de la página indica que hay anuncio     (inmediato)
 *
 * Se exige "sin marcador" + otra señal: así las repeticiones (que también
 * ocultan el marcador pero conservan el césped/duela) no se confunden con
 * anuncios. Como la imagen se muestra con retraso, el inicio del anuncio se
 * "retrofecha" al momento en que empezó la evidencia, de modo que el usuario
 * no llega a ver los primeros segundos del anuncio.
 *
 * Expone `globalThis.ShomerAdBreakDetector`.
 */
(function () {
  'use strict';

  const BOARD_ABSENT = 0.30;   // scoreboardScore por debajo → no hay marcador
  const BOARD_PRESENT = 0.45;  // por encima → hay marcador
  const PALETTE_LOW = 0.45;    // similitud de paleta baja
  const AD_SCORE = 0.75;       // puntuación necesaria para entrar en "anuncio"
  const BACK_TO_GAME_MS = 2000;
  const CUT_WINDOW_MS = 6000;

  class AdBreakDetector {
    constructor() { this.reset(); }

    reset() {
      this.state = 'game';
      this.timeline = [{ t: -Infinity, state: 'game' }];
      this.cuts = [];
      this.adCandidate = null;
      this.gameCandidate = null;
      this.audioBase = null;
      this.lastScore = 0;
    }

    /**
     * Registra las señales de un cuadro analizado.
     * @param {number} t           marca de tiempo de captura (performance.now)
     * @param {object|null} b      señales visuales del worker (broadcast)
     * @param {number|null} audioDb sonoridad del audio (dBFS) en ese instante
     * @param {boolean} domAd      el reproductor de la página muestra un anuncio
     * @param {number} confirmMs   tiempo de evidencia necesario para declarar anuncio
     */
    observe(t, b, audioDb, domAd, confirmMs) {
      // Cortes de escena en la ventana reciente
      if (b && b.sceneCut) this.cuts.push(t);
      while (this.cuts.length && t - this.cuts[0] > CUT_WINDOW_MS) this.cuts.shift();
      const cutRate = this.cuts.length / (CUT_WINDOW_MS / 1000);

      const tplReady = Boolean(b && b.templateReady);
      const noBoard = tplReady && b.scoreboardScore < BOARD_ABSENT;
      const board = !tplReady || (b && b.scoreboardScore > BOARD_PRESENT);
      const paletteLow = Boolean(b && b.paletteSim != null && b.paletteSim < PALETTE_LOW);

      // Audio: línea base aprendida solo durante el juego con marcador visible.
      let loud = false;
      if (audioDb != null && isFinite(audioDb) && audioDb > -70) {
        if (this.state === 'game' && board && tplReady) {
          this.audioBase = this.audioBase == null ? audioDb : this.audioBase + 0.02 * (audioDb - this.audioBase);
        }
        if (this.audioBase != null) loud = Math.abs(audioDb - this.audioBase) > 6;
      }

      const score = (noBoard ? 0.5 : 0) + (paletteLow ? 0.3 : 0) + (loud ? 0.2 : 0) + (cutRate > 0.4 ? 0.1 : 0);
      this.lastScore = score;

      if (this.state === 'game') {
        if (domAd) {
          this._set('ad', t - 300);
        } else if (score >= AD_SCORE) {
          if (this.adCandidate == null) this.adCandidate = t;
          if (t - this.adCandidate >= confirmMs) this._set('ad', this.adCandidate);
        } else {
          this.adCandidate = null;
        }
      } else {
        if (!domAd && board && score < AD_SCORE) {
          if (this.gameCandidate == null) this.gameCandidate = t;
          if (t - this.gameCandidate >= BACK_TO_GAME_MS) this._set('game', this.gameCandidate);
        } else {
          this.gameCandidate = null;
        }
      }
      return this.state;
    }

    _set(state, from) {
      const last = this.timeline[this.timeline.length - 1];
      from = Math.max(from, last.t); // la línea de tiempo siempre ordenada
      this.state = state;
      this.adCandidate = null;
      this.gameCandidate = null;
      this.timeline.push({ t: from, state });
      if (this.timeline.length > 64) this.timeline.splice(1, this.timeline.length - 64);
    }

    /** Estado vigente en el instante `t` (para el cuadro que se va a mostrar). */
    stateAt(t) {
      for (let i = this.timeline.length - 1; i >= 0; i--) {
        if (this.timeline[i].t <= t) return this.timeline[i].state;
      }
      return 'game';
    }
  }

  globalThis.ShomerAdBreakDetector = AdBreakDetector;
})();
