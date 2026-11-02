# Shomer Sport 🛡️⚽

Extensión de Chrome/Edge (Manifest V3) para ver partidos con **recato (tzniut)**:
cubre la piel expuesta de las mujeres que aparecen en pantalla, bloquea cortes
comerciales, banners y anuncios web, y deja ver el partido con claridad.
**Todo se procesa en tu equipo**: ningún cuadro de video sale del navegador.

---

## 1. Arquitectura

```
┌──────────────────────────── Pestaña del sitio de streaming ─────────────────────────────┐
│                                                                                          │
│  <video> original (opacity:0, sigue sonando/reproduciéndose)                             │
│      │ requestVideoFrameCallback                                                         │
│      ▼                                                                                   │
│  ┌──────────── content script (video-filter.js) ────────────┐                            │
│  │ ① Búfer de cuadros (ImageBitmap, ≤720p, ~30 fps)          │                            │
│  │ ② Cada ~66 ms → copia 640px ──────── MessagePort ────────┼──┐                         │
│  │ ⑤ Render con retraso D (1–3 s):                           │  │                         │
│  │    cuadro(t−D) + unión de máscaras de antes/después       │  │                         │
│  │    → desenfoque/bloque en <canvas> superpuesto            │  │                         │
│  │ ⑥ Audio: MediaElementSource → DelayNode(D) → Gain(mute)   │  │                         │
│  │ ⑦ AdBreakDetector: marcador+paleta+audio+cortes → "Pausa" │  │                         │
│  └───────────────────────────────────────────────────────────┘  │                         │
│                                                                 │                         │
│  <iframe oculto chrome-extension://…/engine/engine.html>        │                         │
│     └── Web Worker (inference-worker.js) ◄──────────────────────┘                         │
│          ③ ONNX Runtime Web: WebGPU → WebGL → WASM                                       │
│             a. YOLOv8n-seg → personas (caja + máscara)                                    │
│             b. Clasificador de género (cuerpo completo) → P(mujer)                        │
│             c. Piel dentro de la silueta (regla de color YCrCb/RGB u ONNX opcional)       │
│             d. Estricto: silueta completa · Normal: solo piel  → dilatación de seguridad  │
│          ④ BroadcastAnalyzer: plantilla del marcador, cortes de escena, paleta, banners   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
  Service worker (background.js): activa/desactiva reglas declarativeNetRequest de anuncios.
  Popup: ajustes + PIN familiar + idioma (es/en/he con RTL).
```

### Componentes

| Archivo | Función |
|---|---|
| `manifest.json` | MV3: content scripts en todas las páginas, reglas DNR, iframe del motor accesible. |
| `background.js` | Activa el ruleset `ads` cuando el filtro y el bloqueo de anuncios están encendidos. |
| `rules/ad_rules.json` | 56 dominios de redes publicitarias/VAST (pre-roll, banners, tracking de anuncios). |
| `common/settings.js` | Ajustes en `chrome.storage.local`, PIN con SHA-256 + sal. Ajustes avanzados documentados. |
| `common/i18n.js` | Textos en español, inglés y hebreo (con dirección RTL). |
| `content/content.js` | Busca `<video>` (incluidos los que aparecen después), crea un filtro por video grande, **oculta** las vistas previas pequeñas, crea el iframe del motor. |
| `content/video-filter.js` | Corazón del sistema: búfer con retraso, envío al motor, composición en canvas, audio retrasado, modo a prueba de fallos, PiP/pantalla completa. |
| `content/ad-break-detector.js` | Máquina de estados juego ↔ anuncio con histéresis y retro-fechado del inicio. |
| `content/cosmetic-adblock.js` | Oculta contenedores de anuncios en la página y detecta anuncios del reproductor (p. ej. `.ad-showing` de YouTube). |
| `engine/engine.html/js` | Iframe puente: entrega un `MessagePort` privado al worker (la página no puede espiarlo). |
| `engine/inference-worker.js` | Carga de modelos con respaldo de backends; pipeline por cuadro; cola de inferencia. |
| `engine/yolo-seg.js` | Pre/post-proceso de YOLO-seg: letterbox, NMS, máscaras por prototipos. |
| `engine/gender.js` | Clasificador por lotes de recortes de cuerpo completo. |
| `engine/skin.js` | Piel por color (por defecto) o modelo ONNX opcional. |
| `engine/broadcast-analyzer.js` | Señales de transmisión sin modelos (bordes persistentes, histogramas). |
| `popup/*` | Panel: ON/OFF, Normal/Estricto, Desenfoque/Bloque, anuncios, silenciar, retraso, PIN, idioma, estado. |

### Decisiones clave
- **Retraso + interpolación conservadora.** Mostramos el cuadro de hace *D* segundos; para entonces ya
  existen los análisis de *antes y después* de ese cuadro y aplicamos la **unión** de ambas máscaras.
  Resultado: cero parpadeo y ningún hueco cuando la persona se mueve entre análisis.
- **Ante la duda, se filtra.** Umbral de "mujer" bajo (`femaleThreshold = 0.35`), máscaras con umbral
  0.4, dilatación extra, y si el motor se atrasa o falla se **desenfoca el cuadro completo**.
- **Audio sincronizado.** El audio pasa por un `DelayNode` con el mismo *D*, así que silenciar un anuncio o un
  cuadro filtrado coincide exactamente con la imagen.
- **Repeticiones ≠ anuncios.** Un anuncio requiere *sin marcador* **y** (*paleta distinta* o *audio distinto + cortes*).
- **Sin código remoto.** ONNX Runtime y los modelos van dentro de la extensión (requisito de MV3).

---

## 2. Requisitos

- Chrome/Edge ≥ 116 (WebGPU recomendado: Chrome ≥ 121 en Windows/macOS/ChromeOS; en Linux puede
  requerir `chrome://flags/#enable-unsafe-webgpu`; si no, se usa WebGL o WASM automáticamente).
- Node.js + npm (para descargar ONNX Runtime Web).
- Python 3.9+ (para exportar YOLO y, opcionalmente, entrenar el clasificador).

## 3. Modelos: descarga, conversión e inclusión

Todo queda en `lib/` y `models/` (configurados en `models/models.json`).

```bash
cd shomer-sport
bash scripts/setup.sh          # = ort + yolo + gender + icons
```

1. **ONNX Runtime Web** (`bash scripts/setup.sh ort`): descarga `onnxruntime-web` de npm y copia a `lib/`
   `ort.all.min.js` y los binarios `ort-wasm-simd-threaded*.wasm/.mjs` (WebGPU/JSEP y WASM).
2. **YOLOv8n-seg → ONNX** (`bash scripts/setup.sh yolo`): crea un entorno virtual en
   `~/.cache/shomer-sport-venv` (fuera de la extensión), instala `ultralytics` (CPU) y exporta con
   `imgsz=384, opset=17`. Variables útiles:
   - `YOLO_SIZE=320` (más rápido) o `640` (más preciso).
   - `YOLO_MODEL=yolo11n-seg` (alternativa más reciente; mismo formato de salida).
3. **Clasificador de género** (`models/gender.onnx`, ≈ 46 MB):
   - **Por defecto: CLIP zero-shot** (`bash scripts/setup.sh gender` → `scripts/export_gender_clip.py`).
     Toma el codificador de imagen de MobileCLIP2-S0 y pliega en una capa final los embeddings de texto
     "hombre"/"mujer" (varias frases promediadas, con contexto deportivo). No necesita dataset. El recorte
     vertical se rellena a cuadrado y la normalización de CLIP va dentro del grafo (`mean 0, std 1` en
     `models.json`). Salida `[B,2]` (índice 1 = mujer), lote dinámico.
     Probado: primeros planos y planos medios de mujeres → P ≈ 0.95–1.0; hombres → 0.0–0.3.
     Más flojo en planos abiertos (figuras pequeñas) y con mujeres totalmente cubiertas.
   - **Opcional, más preciso: entrenar** un MobileNetV3 propio (~6 MB, más rápido) con PA-100K:
     ```bash
     ~/.cache/shomer-sport-venv/bin/pip install timm scipy
     ~/.cache/shomer-sport-venv/bin/python scripts/train_gender_classifier.py \
         --pa100k ~/datasets/PA-100K --out models/gender.onnx
     ```
     PA-100K: atributo 0 = *Female*, licencia de investigación. Puedes añadir recortes de transmisiones con
     `--csv` (columnas `path,female`). Tras entrenar, revisa `mean/std` en `models.json`.
   - **Si falta `gender.onnx`, el motor trata a todas las personas como "posible mujer"** (a prueba de fallos):
     el partido se verá con los jugadores cubiertos. El popup muestra "⚠ gender.onnx".
4. **Piel (opcional)** `models/skin.onnx`: si existe, sustituye a la regla de color.
   Entrada `[1,3,256,128]`, salida `[1,1,H,W]` (sigmoide) o `[1,2,H,W]` (softmax).
   Sin él se usa la regla de color YCrCb + RGB, que funciona bien porque solo se aplica dentro de la silueta.

Tamaños aproximados: ONNX Runtime ≈ 90 MB (todas las variantes WASM; puedes borrar
`*.jspi.*` y `*.asyncify.*` si solo usas WebGPU/JSEP + WASM), YOLOv8n-seg ≈ 14 MB, género ≈ 46 MB (CLIP) ó ≈ 6 MB (entrenado).

## 4. Instalación en modo desarrollador

1. Ejecuta `bash scripts/setup.sh` (los modelos ya incluidos en `models/` sirven tal cual).
2. Abre `chrome://extensions` → activa **Modo de desarrollador**.
3. **Cargar descomprimida** → selecciona la carpeta `shomer-sport/`.
4. Fija el icono 🛡️ en la barra y abre el panel: elige idioma, nivel, cubierta y define un PIN.

### Probarla
```bash
cd shomer-sport/tools/test-page && python3 -m http.server 8080
```
Abre <http://localhost:8080>, elige un video de un partido de tu disco y reprodúcelo:
- Durante los primeros segundos verás "Cargando modelos…/Analizando…" con la imagen desenfocada.
- Después, el video aparece con *D* segundos de retraso y las zonas filtradas cubiertas.
- El banner amarillo `.ad-banner` debe desaparecer (bloqueo cosmético).
- El panel muestra el backend (WEBGPU/WEBGL/WASM) y los fps de análisis.
- Para depurar el motor: `chrome://extensions` → Shomer Sport → "Inspeccionar vistas" no muestra el iframe;
  usa DevTools de la pestaña → selector de contexto (arriba de la consola) → `engine.html`.

Ajustes avanzados (umbral de género, tamaño mínimo de persona, fps de análisis, dilatación…) en
`common/settings.js → DEFAULTS`.

## 5. Limitaciones conocidas

- **DRM (Widevine/PlayReady):** Netflix, DAZN, ESPN+, Disney+, etc. entregan cuadros negros a
  `createImageBitmap` → no se pueden analizar. La extensión **oculta** el video y muestra un aviso
  (mejor no ver que ver sin filtrar). Lo mismo para videos de otro origen sin CORS.
- **Precisión de género:** ningún clasificador es perfecto; en planos abiertos las personas miden pocos
  píxeles. Por eso: umbral bajo, unión de máscaras y `minPersonFrac` (las personas de < 7 % de la altura
  no se filtran para que el partido no quede todo borroso; ponlo en 0 para máxima estrictez).
- **Piel por color:** puede fallar con iluminación extrema o ropa color piel (cubre de más, rara vez de menos).
- **Cortes comerciales:** la plantilla del marcador necesita ~15–20 s de juego para aprenderse; los
  programas de estudio del medio tiempo también se tratan como "pausa"; si la transmisión no tiene
  marcador fijo, solo funciona la señal del reproductor (`.ad-showing`, etc.).
- **Banners por persistencia:** con la cámara quieta no se pueden separar de la escena; pueden cubrir
  gráficos legítimos (estadísticas, cambios). Es un falso positivo aceptable.
- **Audio:** si la página ya conectó el `<video>` a su propio Web Audio, no podemos retrasar el audio:
  la imagen irá *D* s por detrás del sonido (el silenciado de anuncios sigue funcionando en vivo).
- **Pantalla completa del propio `<video>`:** se cancela (el canvas no se vería); usa el botón de pantalla
  completa del reproductor (que suele poner en pantalla completa el contenedor).
- **Shadow DOM cerrado / reproductores en `<canvas>`:** no se detectan los `<video>` dentro.
- **Memoria:** el búfer de 3 s a 720p ocupa ~300 MB de GPU; baja `displayMaxHeight` o el retraso si hace falta.
- **Rendimiento:** WebGPU en una laptop media: 15–30 fps de análisis con YOLO 384. Con WASM, 4–8 fps
  (sigue siendo seguro gracias al retraso y al desenfoque a prueba de fallos, pero los bordes son menos precisos).
- **Bloqueo de anuncios por red:** lista corta; anuncios servidos desde el mismo dominio (p. ej. YouTube)
  no se bloquean por red, pero sí se detectan y tapan como "Pausa comercial".

## 6. Siguientes pasos

- **Calidad:** afinar el clasificador con recortes reales de transmisiones; modelo de piel ONNX
  (p. ej. U-Net ligera entrenada en datasets de piel + recortes deportivos); seguimiento de personas
  (ByteTrack) para que la decisión de género sea estable por persona a lo largo del tiempo.
- **Cortes comerciales:** clasificador de audio ligero (YAMNet/PANNs en ONNX) "público de estadio vs. música/locución";
  detector de logotipos de cadena; marcador configurable por el usuario (dibujar su zona).
- **Firefox:** portar a MV3 de Firefox (mismas APIs salvo DNR, que ya soporta).
- **Móvil (Android/iOS):** app nativa con reproductor propio (ExoPlayer/AVPlayer) y
  MediaPipe/TFLite o Core ML en GPU/NPU; el mismo pipeline (retraso + máscaras) funciona mejor en nativo.
  Chrome Android no admite extensiones (Kiwi/Edge Canary sí, de forma limitada).
- **Smart TV:** app Android TV/Google TV con decodificación por hardware y NNAPI/GPU, o un
  dispositivo intermedio (mini-PC / Jetson) entre la fuente HDMI y la TV que aplique el filtro
  (OJO: HDCP impide capturar señales protegidas).
- **Familias:** sincronizar ajustes/PIN con `chrome.storage.sync` y política empresarial
  (`ExtensionInstallForcelist`) para que no se pueda desinstalar sin permiso.
