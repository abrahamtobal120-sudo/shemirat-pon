/**
 * settings.js — Ajustes compartidos (popup, content script y service worker).
 *
 * Se guardan en chrome.storage.local para que estén disponibles en todas las
 * pestañas. Expone `globalThis.ShomerSettings`.
 */
(function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,          // interruptor general
    level: 'normal',        // 'normal' = solo piel | 'strict' = persona completa
    cover: 'blur',          // 'blur' | 'solid'
    solidColor: '#3a3f47',  // color del bloque sólido
    adBlock: true,          // bloqueo de anuncios (red + cortes comerciales + banners)
    muteOnFilter: false,    // silenciar audio cuando haya contenido filtrado en pantalla
    delaySec: 2,            // retraso de seguridad (1–3 s)
    lang: null,             // null = detectar del navegador

    // --- Ajustes avanzados (no expuestos en el popup) ---
    analysisFps: 15,        // cuadros por segundo enviados al motor
    femaleThreshold: 0.35,  // prob. de "mujer" a partir de la cual se filtra (bajo = más estricto)
    personConf: 0.25,       // confianza mínima de detección de persona
    minPersonFrac: 0.07,    // personas más pequeñas que esta fracción de la altura no se filtran
                            // (en planos abiertos los jugadores miden pocos píxeles y no hay detalle;
                            //  pon 0 para filtrar a todas, aunque el partido se verá más borroso)
    maskDilatePx: 6,        // margen extra alrededor de la máscara (en píxeles de la máscara)
    displayMaxHeight: 720,  // resolución máxima del búfer de visualización (memoria)
    failSafeBlur: true      // si el motor se atrasa, desenfocar el cuadro completo
  });

  const PIN_KEY = 'pinHash';

  async function load() {
    const stored = await chrome.storage.local.get(null);
    const s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (k in stored) s[k] = stored[k];
    if (!s.lang) s.lang = globalThis.ShomerI18n ? ShomerI18n.detectLang() : 'es';
    s.delaySec = Math.min(3, Math.max(1, Number(s.delaySec) || DEFAULTS.delaySec));
    return s;
  }

  async function save(partial) {
    const clean = {};
    for (const [k, v] of Object.entries(partial)) if (k in DEFAULTS) clean[k] = v;
    await chrome.storage.local.set(clean);
  }

  /** Suscribe `cb(settings)` a cualquier cambio de ajustes. */
  function onChange(cb) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local') return;
      if (Object.keys(changes).some((k) => k in DEFAULTS)) cb(await load());
    });
  }

  // ---------------- PIN familiar ----------------
  // Se guarda solo un hash SHA-256 con sal; nunca el PIN en claro.

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function hasPin() {
    const r = await chrome.storage.local.get(PIN_KEY);
    return Boolean(r[PIN_KEY]);
  }

  async function setPin(pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = [...salt].map((b) => b.toString(16).padStart(2, '0')).join('');
    const hash = await sha256Hex(saltHex + ':' + pin);
    await chrome.storage.local.set({ [PIN_KEY]: { salt: saltHex, hash } });
  }

  // Tras MAX_FAILS intentos fallidos, el PIN no se acepta durante LOCKOUT_MS
  // (un PIN de 4 dígitos se adivinaría en minutos sin este freno).
  const FAILS_KEY = 'pinFails';
  const MAX_FAILS = 5;
  const LOCKOUT_MS = 30000;

  /** Segundos que faltan para poder volver a intentar el PIN (0 = ya se puede). */
  async function pinLockRemaining() {
    const f = (await chrome.storage.local.get(FAILS_KEY))[FAILS_KEY];
    const left = f && f.until ? f.until - Date.now() : 0;
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  async function checkPin(pin) {
    const r = await chrome.storage.local.get([PIN_KEY, FAILS_KEY]);
    const rec = r[PIN_KEY];
    if (!rec) return true;
    if (await pinLockRemaining()) return false;
    if ((await sha256Hex(rec.salt + ':' + pin)) === rec.hash) {
      await chrome.storage.local.remove(FAILS_KEY);
      return true;
    }
    const count = ((r[FAILS_KEY] && r[FAILS_KEY].count) || 0) + 1;
    await chrome.storage.local.set({
      [FAILS_KEY]: count >= MAX_FAILS ? { count: 0, until: Date.now() + LOCKOUT_MS } : { count, until: 0 }
    });
    return false;
  }

  async function removePin() {
    await chrome.storage.local.remove([PIN_KEY, FAILS_KEY]);
  }

  globalThis.ShomerSettings = { DEFAULTS, load, save, onChange, hasPin, setPin, checkPin, removePin, pinLockRemaining };
})();
