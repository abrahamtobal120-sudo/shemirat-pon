const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detect, systemVersion, defaultTab, defaultBrowser, extensionsAddress } = require("./guide.js");

test("detecta iPhone Safari y navegador integrado sin confundirlos", () => {
  const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  assert.deepEqual(detect(safari, "iPhone", 5), { device: "iphone", browser: "safari" });
  assert.equal(detect(safari + " Instagram 300.0", "iPhone", 5).browser, "embedded");
  assert.equal(systemVersion(safari, "iphone"), "17.0");
  assert.equal(defaultTab("iphone"), "iphone");
});

test("detecta Android y abre su pestaña", () => {
  const chrome = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
  assert.deepEqual(detect(chrome, "Linux", 5), { device: "android", browser: "chrome" });
  assert.equal(systemVersion(chrome, "android"), "14");
  assert.equal(systemVersion(chrome, "windows"), null);
  assert.equal(defaultTab("android"), "android");
});

test("iPad con agente de Mac se reconoce como iPad", () => {
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
  assert.equal(detect(ipad, "MacIntel", 5).device, "ipad");
  assert.equal(systemVersion(ipad, "ipad"), null);
  assert.equal(defaultTab("ipad"), "iphone");
});

test("computadoras y dispositivos desconocidos abren la guía de computadora", () => {
  for (const device of ["windows", "mac", "linux", "unknown"]) assert.equal(defaultTab(device), "pc");
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0";
  assert.equal(defaultBrowser(detect(edge, "Win32", 0).browser), "edge");
  assert.equal(defaultBrowser("firefox"), "chrome");
});

test("cada navegador usa su dirección de extensiones", () => {
  assert.equal(extensionsAddress("chrome"), "chrome://extensions");
  assert.equal(extensionsAddress("edge"), "edge://extensions");
  assert.equal(extensionsAddress("brave"), "brave://extensions");
});
