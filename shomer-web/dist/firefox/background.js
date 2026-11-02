/**
 * background.js — Service worker (Manifest V3).
 *
 * Responsabilidad única: activar/desactivar las reglas de red de bloqueo de
 * anuncios (declarativeNetRequest) según los ajustes. Todo el análisis de
 * video ocurre en la pestaña (content script + iframe del motor).
 */
// En Chrome es un service worker; en Firefox una página de fondo que ya carga
// estos archivos desde manifest.json (background.scripts).
if (typeof importScripts === 'function') importScripts('common/i18n.js', 'common/settings.js');

async function syncAdRules() {
  const s = await ShomerSettings.load();
  const on = s.enabled && s.adBlock;
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    on ? { enableRulesetIds: ['ads'] } : { disableRulesetIds: ['ads'] }
  );
}

chrome.runtime.onInstalled.addListener(syncAdRules);
chrome.runtime.onStartup.addListener(syncAdRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('adBlock' in changes || 'enabled' in changes)) syncAdRules();
});
