const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detect, guide } = require("./guide.js");

test("detecta iPhone Safari y navegador integrado sin confundirlos", () => {
  const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  assert.deepEqual(detect(safari, "iPhone", 5), { device: "iphone", browser: "safari" });
  assert.equal(detect(safari + " Instagram 300.0", "iPhone", 5).browser, "embedded");
  assert.equal(guide("iphone", "embedded", "install").link, "#guia-iphone");
  assert.match(guide("iphone", "embedded", "install").steps[0], /Safari/);
});

test("detecta Android y no ofrece instaladores móviles inexistentes", () => {
  const chrome = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
  assert.deepEqual(detect(chrome, "Linux", 5), { device: "android", browser: "chrome" });
  assert.equal(detect(chrome.replace("Chrome/120.0.0.0", "Firefox/120.0"), "Linux", 5).browser, "firefox");
  for (const browser of ["chrome", "firefox", "embedded"]) {
    const result = guide("android", browser, "install");
    assert.equal(result.link, "#guia-android");
    assert.match(result.note, /no podemos/i);
    assert.ok(result.steps.every(step => !step.includes("/downloads/")));
  }
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
