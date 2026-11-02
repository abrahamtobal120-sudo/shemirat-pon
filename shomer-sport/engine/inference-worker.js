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
