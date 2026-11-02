/**
 * engine.js — Puente entre el content script y el Web Worker de inferencia.
 *
 * El content script nos envía un MessagePort privado (MessageChannel). Lo
 * transferimos tal cual al worker, de modo que el content script y el worker
 * hablan directamente (ImageBitmap transferibles, sin copias) y la página web
 * no puede escuchar la conversación.
 */
'use strict';

const worker = new Worker('inference-worker.js');

window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || data.type !== 'shomer-connect' || !ev.ports[0]) return;
  // Cada video/documento obtiene su propio canal hacia el mismo worker.
  worker.postMessage({ type: 'port' }, [ev.ports[0]]);
});
