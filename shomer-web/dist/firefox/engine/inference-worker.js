/**
 * inference-worker.js — Web Worker de inferencia de Shomer Sport.
 *
 * Por cada cuadro de análisis:
 *   1. YOLO-seg  → personas (caja + máscara)
 *   2. Género    → P(mujer) por persona
 *   3. Piel      → máscara de piel dentro de cada mujer (modo Normal)
 *                  ó persona completa (modo Estricto)
 *   4. Une, dilata y devuelve una máscara binaria de baja resolución
 *   5. Señales de transmisión (marcador, cortes, paleta, banners)
 *
 * Los modelos se ejecutan con ONNX Runtime Web probando WebGPU → WebGL → WASM.
 * Nada sale del equipo: los cuadros llegan por un MessagePort privado.
 *
 * Shomer Web añade el análisis de imágenes sueltas (mensaje 'image'): el
 * worker descarga la imagen él mismo (la extensión tiene permiso en todos los
 * sitios, así que no le afecta CORS), la analiza y, si hay algo que cubrir,
 * devuelve una copia ya filtrada para sustituir a la original.
 */
'use strict';

importScripts(
  '../lib/ort.all.min.js',
  'mask-utils.js',
  'yolo-seg.js',
  'gender.js',
  'skin.js',
  'broadcast-analyzer.js'
);

const GRID_W = 256; // ancho de la máscara de salida (el alto sigue la proporción del video)

const engine = {
  state: 'loading',     // 'loading' | 'ready' | 'error'
  backend: null,
  error: null,
  yolo: null,
  gender: null,
  skin: null,
  genderMissing: false
};
const ports = new Set();
let queue = Promise.resolve(); // serializa las inferencias (una sesión ORT a la vez)
let markLoaded;
const loaded = new Promise((r) => { markLoaded = r; }); // se resuelve al terminar loadModels (bien o mal)

// ---------------------------------------------------------------------------
// Carga de modelos
// ---------------------------------------------------------------------------

ort.env.wasm.wasmPaths = new URL('../lib/', self.location.href).href;
// Sin aislamiento de origen cruzado no hay SharedArrayBuffer → 1 hilo.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

function candidateBackends() {
  const list = [];
  if (self.navigator && navigator.gpu) list.push('webgpu');
  list.push('webgl', 'wasm');
  return list;
}

/** Crea una sesión probando backends en orden; devuelve {session, backend}. */
async function createSession(url, preferred) {
  const order = preferred ? [preferred, ...candidateBackends().filter((b) => b !== preferred)] : candidateBackends();
  let lastErr;
  for (const ep of order) {
    try {
      const session = await ort.InferenceSession.create(url, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all'
      });
      return { session, backend: ep };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fileExists(url) {
  try { return (await fetch(url, { method: 'HEAD' })).ok; } catch { return false; }
}

async function loadModels() {
  try {
    const base = new URL('../models/', self.location.href);
    const cfg = await (await fetch(new URL('models.json', base))).json();

    // 1) Detector/segmentador de personas (obligatorio)
    const yoloUrl = new URL(cfg.yolo.file, base).href;
    if (!(await fileExists(yoloUrl))) throw new Error(`Falta el modelo ${cfg.yolo.file}. Ejecuta scripts/setup.sh`);
    const y = await createSession(yoloUrl);
    engine.backend = y.backend;
    let size = cfg.yolo.size || 640;
    const shape = y.session.inputMetadata?.[0]?.shape;
    if (Array.isArray(shape) && typeof shape[2] === 'number') size = shape[2];
    engine.yolo = new YoloSeg(y.session, size);

    // 2) Clasificador de género (si falta → modo a prueba de fallos: todas las personas se filtran)
    if (cfg.gender && (await fileExists(new URL(cfg.gender.file, base).href))) {
      const g = await createSession(new URL(cfg.gender.file, base).href, y.backend);
      engine.gender = new GenderClassifier(g.session, cfg.gender);
    } else {
      engine.genderMissing = true;
    }

    // 3) Segmentador de piel (opcional; si no hay, regla de color)
    if (cfg.skin && (await fileExists(new URL(cfg.skin.file, base).href))) {
      const s = await createSession(new URL(cfg.skin.file, base).href, y.backend);
      engine.skin = new SkinSegmenter(s.session, cfg.skin);
    } else {
      engine.skin = new SkinSegmenter();
    }

    engine.state = 'ready';
  } catch (e) {
    engine.state = 'error';
    engine.error = String(e && e.message ? e.message : e);
  }
  markLoaded();
  broadcastStatus();
}

function statusMsg() {
  return { type: 'status', state: engine.state, backend: engine.backend, error: engine.error, genderMissing: engine.genderMissing };
}
function broadcastStatus() { for (const p of ports) p.postMessage(statusMsg()); }

// ---------------------------------------------------------------------------
// Procesamiento de un cuadro
// ---------------------------------------------------------------------------

/** Rejilla RGBA del cuadro al tamaño de la máscara (para la regla de piel). */
const gridCanvas = new OffscreenCanvas(GRID_W, 144);
const gridCtx = gridCanvas.getContext('2d', { willReadFrequently: true });

async function analyzeFrame(bitmap, opts, analyzer, adState) {
  const t0 = performance.now();
  const fw = bitmap.width, fh = bitmap.height;
  const gw = GRID_W, gh = Math.max(2, Math.round((GRID_W * fh) / fw));

  // --- 1) Personas ---
  const { dets, letterbox } = await engine.yolo.detect(bitmap, opts.personConf);
  const big = dets.filter((d) => (d.y2 - d.y1) / fh >= opts.minPersonFrac);

  // --- 2) Género ---
  let pFemale;
  if (engine.gender) pFemale = await engine.gender.classify(bitmap, big);
  else pFemale = big.map(() => 1); // sin modelo de género: a prueba de fallos

  // --- 3) Máscara ---
  const mask = new Uint8Array(gw * gh);
  let needGrid = opts.level !== 'strict';
  let gridRGBA = null;
  const persons = [];
  for (let k = 0; k < big.length; k++) {
    const d = big[k];
    const filtered = pFemale[k] >= opts.femaleThreshold; // duda → se filtra
    persons.push({
      x: d.x1 / fw, y: d.y1 / fh, w: (d.x2 - d.x1) / fw, h: (d.y2 - d.y1) / fh,
      score: +d.score.toFixed(2), female: +pFemale[k].toFixed(2), filtered
    });
    if (!filtered) continue;
    const pm = YoloSeg.projectMask(d, letterbox, fw, fh, gw, gh);
    if (opts.level === 'strict') {
      MaskUtils.unionInto(mask, pm);
    } else {
      if (needGrid) {
        if (gridCanvas.height !== gh) gridCanvas.height = gh;
        gridCtx.drawImage(bitmap, 0, 0, gw, gh);
        gridRGBA = gridCtx.getImageData(0, 0, gw, gh).data;
        needGrid = false;
      }
      const skin = await engine.skin.segment(gridRGBA, pm, gw, gh, d, bitmap);
      // Cierre para rellenar huecos (p. ej. sombras en brazos y piernas).
      MaskUtils.unionInto(mask, MaskUtils.close(skin, gw, gh, 2));
    }
  }
  const finalMask = MaskUtils.dilate(mask, gw, gh, opts.maskDilatePx);
  const coverage = MaskUtils.coverage(finalMask);

  // --- 4) Transmisión (cortes comerciales / banners) ---
  const broadcast = opts.adBlock ? analyzer.update(bitmap, adState) : null;

  return {
    gw, gh,
    mask: coverage > 0 ? finalMask : null,
    coverage, persons, broadcast,
    ms: performance.now() - t0
  };
}

// ---------------------------------------------------------------------------
// Imágenes (Shomer Web)
// ---------------------------------------------------------------------------

const IMG_MAX_SIDE = 1600;   // tamaño máximo de la copia filtrada
const IMG_CACHE_MAX = 300;
const imageCache = new Map(); // clave (url + ajustes) → Promise<{verdict, blob?}>

async function fetchBitmap(url) {
  let res;
  try { res = await fetch(url, { credentials: 'include' }); } catch { res = null; }
  if (!res || !res.ok) res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return createImageBitmap(await res.blob());
}

/** Copia de la imagen con las zonas de la máscara cubiertas (desenfoque o bloque). */
async function composeFiltered(bitmap, r, opts) {
  const sc = Math.min(1, IMG_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * sc)), h = Math.max(1, Math.round(bitmap.height * sc));
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);

  // Capa de cubierta del tamaño completo…
  const layer = new OffscreenCanvas(w, h);
  const lc = layer.getContext('2d');
  if (opts.cover === 'solid') {
    lc.fillStyle = opts.solidColor;
    lc.fillRect(0, 0, w, h);
  } else {
    // Desenfoque fuerte: reducir mucho y volver a ampliar (funciona igual en Chrome y Firefox).
    const sw = Math.max(1, Math.round(w / 40)), sh = Math.max(1, Math.round(h / 40));
    const small = new OffscreenCanvas(sw, sh);
    small.getContext('2d').drawImage(bitmap, 0, 0, sw, sh);
    lc.imageSmoothingEnabled = true;
    lc.drawImage(small, 0, 0, w, h);
  }
  // …recortada a la forma de la máscara.
  const m = new OffscreenCanvas(r.gw, r.gh);
  const mc = m.getContext('2d');
  const img = mc.createImageData(r.gw, r.gh);
  for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) img.data[i * 4 + 3] = 255;
  mc.putImageData(img, 0, 0);
  lc.globalCompositeOperation = 'destination-in';
  lc.imageSmoothingEnabled = true;
  lc.drawImage(m, 0, 0, w, h);

  ctx.drawImage(layer, 0, 0);
  return out.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

async function analyzeImage(url, bitmap, opts) {
  if (!bitmap) bitmap = await fetchBitmap(url);
  try {
    const r = await new Promise((resolve, reject) => {
      queue = queue.then(() => analyzeFrame(bitmap, { ...opts, adBlock: false }, null, null).then(resolve, reject));
    });
    if (!r.mask) return { verdict: 'clean' };
    return { verdict: 'filtered', blob: await composeFiltered(bitmap, r, opts) };
  } finally {
    bitmap.close();
  }
}

async function handleImage(port, msg) {
  const { id, url, bitmap, opts } = msg;
  await loaded;
  if (engine.state !== 'ready') {
    if (bitmap) bitmap.close();
    port.postMessage({ type: 'imageResult', id, verdict: 'error', message: engine.error });
    return;
  }
  let p;
  if (url && !bitmap) {
    const key = [url, opts.level, opts.cover, opts.solidColor, opts.femaleThreshold].join('|');
    p = imageCache.get(key);
    if (!p) {
      p = analyzeImage(url, null, opts);
      imageCache.set(key, p);
      p.catch(() => imageCache.delete(key));
      if (imageCache.size > IMG_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    }
  } else {
    p = analyzeImage(null, bitmap, opts);
  }
  try {
    const r = await p;
    port.postMessage({ type: 'imageResult', id, verdict: r.verdict, blob: r.blob });
  } catch (e) {
    port.postMessage({ type: 'imageResult', id, verdict: 'error', message: String(e && e.message ? e.message : e) });
  }
}

// ---------------------------------------------------------------------------
// Canales (uno por video)
// ---------------------------------------------------------------------------

function attachPort(port) {
  ports.add(port);
  const analyzer = new BroadcastAnalyzer();

  port.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'hello') { port.postMessage(statusMsg()); return; }
    if (msg.type === 'reset') { analyzer.reset(); return; }
    if (msg.type === 'close') { ports.delete(port); port.close(); return; }
    if (msg.type === 'image') { handleImage(port, msg); return; }
    if (msg.type !== 'frame') return;

    const { id, t, bitmap, opts, adState } = msg;
    if (engine.state !== 'ready') {
      bitmap.close();
      port.postMessage({ type: 'error', id, t, code: engine.state === 'error' ? 'engine' : 'loading', message: engine.error });
      return;
    }
    queue = queue.then(async () => {
      try {
        const r = await analyzeFrame(bitmap, opts, analyzer, adState);
        const transfer = r.mask ? [r.mask.buffer] : [];
        port.postMessage({ type: 'result', id, t, ...r }, transfer);
      } catch (e) {
        // SecurityError = el video es de otro origen sin CORS y no se puede leer.
        const code = e && e.name === 'SecurityError' ? 'tainted' : 'engine';
        port.postMessage({ type: 'error', id, t, code, message: String(e && e.message ? e.message : e) });
      } finally {
        bitmap.close();
      }
    });
  };
  port.postMessage(statusMsg());
}

self.onmessage = (ev) => {
  if (ev.data && ev.data.type === 'port' && ev.ports[0]) attachPort(ev.ports[0]);
};

loadModels();
