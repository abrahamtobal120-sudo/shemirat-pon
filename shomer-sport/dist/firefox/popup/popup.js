/**
 * popup.js — Panel de configuración de Shomer Sport.
 *
 * Si hay un PIN familiar definido, los ajustes quedan bloqueados hasta que se
 * introduzca el PIN (el desbloqueo dura mientras el popup esté abierto).
 * Tras varios intentos fallidos el PIN se bloquea un tiempo (ver settings.js).
 * Cambiar el idioma no requiere PIN.
 */
'use strict';

const $ = (id) => document.getElementById(id);
let settings;
let unlocked = false;
let lastStatus = null;

// ------------------------------------------------------------------ Textos

function applyLanguage(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = ShomerI18n.t(lang, 'dir');
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = ShomerI18n.t(lang, el.dataset.i18n);
  }
  for (const id of ['unlockPin', 'newPin']) $(id).placeholder = ShomerI18n.t(lang, 'pinPlaceholder');
  $('langGroup').setAttribute('aria-label', ShomerI18n.t(lang, 'language'));
}

const T = (key) => ShomerI18n.t(settings.lang, key);

function showMsg(el, text, kind) {
  el.textContent = text;
  el.className = 'msg ' + (kind || '');
}

// --------------------------------------------------------------- Controles

function render() {
  applyLanguage(settings.lang);
  for (const r of document.querySelectorAll('input[name="lang"]')) r.checked = r.value === settings.lang;
  $('enabled').checked = settings.enabled;
  $('hero').classList.toggle('on', settings.enabled);
  $('heroTitle').textContent = T(settings.enabled ? 'heroOn' : 'heroOff');
  $('settingsBody').classList.toggle('disabled', !settings.enabled);
  $('adBlock').checked = settings.adBlock;
  $('muteOnFilter').checked = settings.muteOnFilter;
  $('delaySec').value = settings.delaySec;
  $('delayOut').textContent = settings.delaySec + ' ' + T('seconds');
  for (const r of document.querySelectorAll('input[name="level"]')) r.checked = r.value === settings.level;
  for (const r of document.querySelectorAll('input[name="cover"]')) r.checked = r.value === settings.cover;
  if (lastStatus) renderStatus(lastStatus);
}

async function renderPin() {
  const has = await ShomerSettings.hasPin();
  const locked = has && !unlocked;
  $('lockBox').hidden = !locked;
  $('controls').classList.toggle('locked', locked);
  $('controls').inert = locked;
  $('setPinBtn').textContent = T(has ? 'pinChange' : 'pinSet');
  $('removePinBtn').hidden = !has;
  $('lockNowBtn').hidden = !has;
  $('pinState').textContent = T(has ? 'pinOn' : 'pinOff');
  $('pinState').classList.toggle('on', has);
  if (locked) {
    await renderLockout();
    $('unlockPin').focus();
  }
}

/** Muestra la espera tras demasiados intentos fallidos y desactiva el botón. */
async function renderLockout() {
  clearTimeout(renderLockout.timer);
  const secs = await ShomerSettings.pinLockRemaining();
  $('unlockBtn').disabled = secs > 0;
  if (secs > 0) {
    showMsg($('unlockMsg'), T('pinTooMany').replace('{s}', secs), 'err');
    renderLockout.timer = setTimeout(renderLockout, 1000);
  } else if ($('unlockMsg').textContent && $('unlockBtn').dataset.wasLocked) {
    showMsg($('unlockMsg'), '');
  }
  $('unlockBtn').dataset.wasLocked = secs > 0 ? '1' : '';
}

async function update(partial) {
  Object.assign(settings, partial);
  await ShomerSettings.save(partial);
  render();
}

function bindControls() {
  for (const r of document.querySelectorAll('input[name="lang"]')) {
    r.addEventListener('change', async () => { await update({ lang: r.value }); renderPin(); refreshStatus(); });
  }
  $('enabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));
  $('adBlock').addEventListener('change', (e) => update({ adBlock: e.target.checked }));
  $('muteOnFilter').addEventListener('change', (e) => update({ muteOnFilter: e.target.checked }));
  $('delaySec').addEventListener('input', (e) => {
    $('delayOut').textContent = e.target.value + ' ' + T('seconds');
  });
  $('delaySec').addEventListener('change', (e) => update({ delaySec: Number(e.target.value) }));
  for (const r of document.querySelectorAll('input[name="level"]')) r.addEventListener('change', () => update({ level: r.value }));
  for (const r of document.querySelectorAll('input[name="cover"]')) r.addEventListener('change', () => update({ cover: r.value }));

  // --- PIN ---
  const tryUnlock = async () => {
    if ($('unlockBtn').disabled) return;
    const res = await ShomerSettings.checkPin($('unlockPin').value);
    $('unlockPin').value = '';
    if (res === true) {
      unlocked = true;
      showMsg($('unlockMsg'), '');
      renderPin();
    } else {
      showMsg($('unlockMsg'), T('pinWrong'), 'err');
      renderLockout();
    }
  };
  $('unlockBtn').addEventListener('click', tryUnlock);
  $('unlockPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

  const savePin = async () => {
    const pin = $('newPin').value.trim();
    if (!/^\d{4,8}$/.test(pin)) { showMsg($('pinMsg'), T('pinInvalid'), 'err'); return; }
    await ShomerSettings.setPin(pin);
    unlocked = true;
    $('newPin').value = '';
    showMsg($('pinMsg'), T('pinSaved'), 'ok');
    renderPin();
  };
  $('setPinBtn').addEventListener('click', savePin);
  $('newPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePin(); });
  $('removePinBtn').addEventListener('click', async () => {
    await ShomerSettings.removePin();
    showMsg($('pinMsg'), T('pinRemoved'), 'ok');
    renderPin();
  });
  $('lockNowBtn').addEventListener('click', () => {
    unlocked = false;
    showMsg($('pinMsg'), '');
    renderPin();
  });
}

// ---------------------------------------------------------- Buscar deporte

function openSport(text) {
  const url = ShomerSports.searchUrl(text);
  if (url) chrome.tabs.create({ url });
}

function bindSportSearch() {
  $('sportForm').addEventListener('submit', (e) => {
    e.preventDefault();
    openSport($('sportInput').value);
  });
  $('sportQuick').replaceChildren(...ShomerSports.QUICK.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.label;
    b.addEventListener('click', () => openSport(s.query));
    return b;
  }));
}

// ------------------------------------------------------------------ Estado

async function refreshStatus() {
  let st = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    st = tab ? await chrome.tabs.sendMessage(tab.id, { type: 'shomer-status' }).catch(() => null) : null;
  } catch { /* pestañas internas del navegador */ }
  lastStatus = st || { hasVideo: false };
  renderStatus(lastStatus);
}

function renderStatus(st) {
  const box = $('statusBox');
  const chips = [];
  const warnings = [];
  let state, text;

  if (!settings.enabled) {
    state = 'off'; text = T('statusOff');
  } else if (!st.hasVideo) {
    state = 'none'; text = T('statusNoVideo');
  } else if (st.taint) {
    state = 'error'; text = T('statusProtected');
    warnings.push({ text: T('drmWarning'), err: true });
  } else if (st.state === 'error') {
    state = 'error'; text = T('statusError');
    if (st.error) warnings.push({ text: st.error, err: true });
  } else if (st.state === 'ready') {
    state = st.adState === 'ad' ? 'ad' : 'ok';
    text = T(st.adState === 'ad' ? 'adBreak' : 'statusRunning');
    if (st.fps < 2) warnings.push({ text: T('warnSlow') });
  } else {
    state = 'loading'; text = T('statusLoading');
  }

  if (st.hasVideo && settings.enabled) {
    if (st.backend) chips.push(st.backend.toUpperCase());
    if (st.state === 'ready') chips.push(`${T('fps')} ${st.fps.toFixed(1)} fps`);
    if (st.videos > 1) chips.push(`${st.videos} ▶`);
    if (st.genderMissing) warnings.push({ text: T('warnGender') });
    if (st.state === 'ready' && st.audioRouted === false) warnings.push({ text: T('warnAudio') });
  }

  box.dataset.state = state;
  $('statusText').textContent = text;
  $('statusChips').replaceChildren(...chips.map((c) => {
    const el = document.createElement('span');
    el.className = 'chip';
    el.textContent = c;
    return el;
  }));
  $('statusWarnings').replaceChildren(...warnings.map((w) => {
    const li = document.createElement('li');
    if (w.err) li.className = 'err';
    li.textContent = w.text;
    return li;
  }));
}

// ------------------------------------------------------------------ Inicio

(async function init() {
  settings = await ShomerSettings.load();
  render();
  bindControls();
  bindSportSearch();
  await renderPin();
  refreshStatus();
  setInterval(refreshStatus, 1000);
})();
