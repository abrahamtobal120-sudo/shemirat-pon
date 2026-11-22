// Real Chrome screenshots for the install guide (run in CI by the "Website screenshots" workflow).
// Usage: node capturas-chrome.mjs <carpeta de shomer-web> <carpeta de salida>
import { chromium } from 'playwright';
const [EXT, OUT] = process.argv.slice(2);
const wait = ms => new Promise(r => setTimeout(r, ms));
const launch = ext => chromium.launchPersistentContext('', {
  headless: false, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, locale: 'es-419',
  args: ['--lang=es-419', ...(ext ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : [])],
});
const step = async (name, fn) => { try { await fn(); console.log('ok', name); } catch (e) { console.log('FALLÓ', name, e.message.split('\n')[0]); } };

let c = await launch(false); let p = c.pages()[0] || await c.newPage();
await step('extensiones', async () => { await p.goto('chrome://extensions'); await wait(1500); await p.screenshot({ path: `${OUT}/chrome-1-extensiones.png` }); });
await step('modo desarrollador', async () => { await p.locator('#devMode').click(); await wait(1200); await p.screenshot({ path: `${OUT}/chrome-2-modo-desarrollador.png` }); });
await c.close();

c = await launch(true); p = c.pages()[0] || await c.newPage();
await step('shomer cargado', async () => { await p.goto('chrome://extensions'); await wait(2500); await p.screenshot({ path: `${OUT}/chrome-3-shomer-cargado.png` }); });
const sw = c.serviceWorkers()[0] || await c.waitForEvent('serviceworker', { timeout: 20000 });
const id = sw.url().split('/')[2];
await step('ventana de shomer', async () => {
  const pop = await c.newPage(); await pop.setViewportSize({ width: 380, height: 600 });
  await pop.goto(`chrome-extension://${id}/popup/popup.html`); await wait(1500);
  const h = await pop.evaluate(() => document.body.scrollHeight);
  await pop.setViewportSize({ width: 380, height: Math.min(h, 1000) }); await wait(500);
  await pop.screenshot({ path: `${OUT}/chrome-4-ventana-shomer.png` });
});
for (const [name, url] of [['wikipedia', 'https://es.wikipedia.org/wiki/Auxiliar_de_vuelo'], ['wikipedia2', 'https://es.wikipedia.org/wiki/Moda']]) {
  await step(name, async () => {
    const d = await c.newPage(); await d.goto(url, { waitUntil: 'load', timeout: 60000 }); await wait(15000);
    await d.screenshot({ path: `${OUT}/chrome-5-${name}.png` });
  });
}
await c.close();
