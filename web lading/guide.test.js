const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detect, systemVersion, isComputer, defaultDevice, panelFor, defaultBrowser, isSupported, extensionsAddress } = require("./guide.js");

test("detecta iPhone Safari y navegador integrado sin confundirlos", () => {
  const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  assert.deepEqual(detect(safari, "iPhone", 5), { device: "iphone", browser: "safari" });
  assert.equal(detect(safari + " Instagram 300.0", "iPhone", 5).browser, "embedded");
  assert.equal(systemVersion(safari, "iphone"), "17.0");
  assert.equal(panelFor("iphone"), "apple");
});

test("detecta Android y abre su guía", () => {
  const chrome = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
  assert.deepEqual(detect(chrome, "Linux", 5), { device: "android", browser: "chrome" });
  assert.equal(systemVersion(chrome, "android"), "14");
  assert.equal(systemVersion(chrome, "windows"), null);
  assert.equal(panelFor("android"), "android");
});

test("iPad con agente de Mac se reconoce como iPad", () => {
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
  assert.equal(detect(ipad, "MacIntel", 5).device, "ipad");
  assert.equal(detect(ipad, "MacIntel", 0).device, "mac");
  assert.equal(panelFor("ipad"), "apple");
});

test("Chromebook no se confunde con Linux", () => {
  const cros = "Mozilla/5.0 (X11; CrOS x86_64 15633.69.0) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36";
  assert.equal(detect(cros, "Linux x86_64", 0).device, "chromebook");
  assert.equal(detect("Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0", "Linux x86_64", 0).device, "linux");
});

test("las computadoras comparten la guía y un dispositivo desconocido abre Windows", () => {
  for (const device of ["windows", "mac", "linux", "chromebook"]) {
    assert.equal(isComputer(device), true);
    assert.equal(panelFor(device), "computer");
  }
  assert.equal(isComputer("android"), false);
  assert.equal(defaultDevice("unknown"), "windows");
  assert.equal(defaultDevice("mac"), "mac");
});

test("el navegador preseleccionado es el del visitante si esa computadora lo ofrece", () => {
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0";
  assert.equal(defaultBrowser(detect(edge, "Win32", 0).browser, "windows"), "edge");
  assert.equal(detect("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0", "Win32", 0, true).browser, "brave");
  assert.equal(defaultBrowser("safari", "mac"), "safari");
  assert.equal(defaultBrowser("safari", "windows"), "chrome");
  assert.equal(defaultBrowser("edge", "chromebook"), "chrome");
  assert.equal(defaultBrowser("embedded", "windows"), "chrome");
});

test("solo Chrome, Edge y Brave son compatibles", () => {
  for (const browser of ["chrome", "edge", "brave"]) assert.equal(isSupported(browser), true);
  for (const browser of ["firefox", "safari"]) assert.equal(isSupported(browser), false);
});

test("cada navegador usa su dirección de extensiones", () => {
  assert.equal(extensionsAddress("chrome"), "chrome://extensions");
  assert.equal(extensionsAddress("edge"), "edge://extensions");
  assert.equal(extensionsAddress("brave"), "brave://extensions");
});
