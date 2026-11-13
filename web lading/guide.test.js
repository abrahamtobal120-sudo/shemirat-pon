const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detect, systemVersion, guide } = require("./guide.js");

test("detecta iPhone Safari y navegador integrado sin confundirlos", () => {
  const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  assert.deepEqual(detect(safari, "iPhone", 5), { device: "iphone", browser: "safari" });
  assert.equal(detect(safari + " Instagram 300.0", "iPhone", 5).browser, "embedded");
  assert.equal(systemVersion(safari, "iphone"), "17.0");
  assert.equal(guide("iphone", "embedded", "install").link, "#guia-iphone");
  assert.match(guide("iphone", "embedded", "install").steps[0], /Safari/);
});

test("detecta Android y no ofrece instaladores móviles inexistentes", () => {
  const chrome = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
  assert.deepEqual(detect(chrome, "Linux", 5), { device: "android", browser: "chrome" });
  assert.equal(systemVersion(chrome, "android"), "14");
  assert.equal(systemVersion(chrome, "windows"), null);
  assert.equal(detect(chrome.replace("Chrome/120.0.0.0", "Firefox/120.0"), "Linux", 5).browser, "firefox");
  for (const browser of ["chrome", "firefox", "embedded"]) {
    const result = guide("android", browser, "install");
    assert.equal(result.link, "#guia-android");
    assert.match(result.note, /no podemos/i);
    assert.ok(result.steps.every(step => !step.includes("/downloads/")));
  }
});

test("no inventa versión de iPad cuando el navegador la oculta", () => {
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
  assert.equal(detect(ipad, "MacIntel", 5).device, "ipad");
  assert.equal(systemVersion(ipad, "ipad"), null);
});

test("guías de escritorio usan direcciones del navegador correcto", () => {
  for (const [browser, address] of [["chrome", "chrome://extensions"], ["edge", "edge://extensions"], ["brave", "brave://extensions"]]) {
    const result = guide("windows", browser, "install");
    assert.equal(result.link, "/downloads/shomer-web.zip");
    assert.ok(result.steps.some(step => step.includes(address)));
    assert.ok(guide("mac", browser, "activate").steps.some(step => step.includes(address)));
  }
  assert.notEqual(guide("linux", "firefox", "install").link, "/downloads/shomer-web.zip");
  assert.equal(guide("unknown", "unknown", "install").steps.length, 0);
});

test("permite elegir todo el dispositivo o solo el navegador", () => {
  const phone = guide("android", "chrome", "install", "phone");
  const browser = guide("android", "chrome", "install", "browser");
  assert.match(phone.title, /todo el teléfono/i);
  assert.ok(phone.steps.some(step => step.includes("Todo el teléfono")));
  assert.match(browser.title, /solo el navegador/i);
  assert.ok(browser.steps.some(step => step.includes("Solo navegadores")));
  assert.ok(guide("iphone", "safari", "install", "browser").steps.some(step => step.includes("Solo navegador")));
  const desktopWhole = guide("windows", "chrome", "install", "phone");
  assert.ok(desktopWhole.steps.some(step => step.includes("185.228.168.168")));
  assert.equal(guide("windows", "chrome", "install", "browser").link, "/downloads/shomer-web.zip");
});
