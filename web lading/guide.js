(function () {
  "use strict";

  function detect(userAgent, platform, touchPoints) {
    const ua = userAgent || "";
    let device = "unknown";
    if (/iPad/i.test(ua) || (/Mac/i.test(platform || "") && touchPoints > 1)) device = "ipad";
    else if (/iPhone/i.test(ua)) device = "iphone";
    else if (/Android/i.test(ua)) device = "android";
    else if (/Windows/i.test(ua)) device = "windows";
    else if (/Macintosh|Mac OS X/i.test(ua)) device = "mac";
    else if (/Linux/i.test(ua)) device = "linux";

    let browser = "unknown";
    if (/FBAN|FBAV|Instagram|Line\/|; wv\)|\bwv\b/i.test(ua)) browser = "embedded";
    else if (/EdgA?\/|EdgiOS\//i.test(ua)) browser = "edge";
    else if (/Firefox\/|FxiOS\//i.test(ua)) browser = "firefox";
    else if (/Chrome\/|CriOS\//i.test(ua)) browser = "chrome";
    else if (/Safari\//i.test(ua)) browser = "safari";
    return { device, browser };
  }

  function systemVersion(userAgent, device) {
    const ua = userAgent || "";
    let match;
    if (device === "android") match = ua.match(/Android\s+([\d.]+)/i);
    else if (device === "iphone" || device === "ipad") match = ua.match(/(?:CPU (?:iPhone )?OS)\s+([\d_]+)/i);
    else if (device === "mac") match = ua.match(/Mac OS X\s+([\d_.]+)/i);
    return match ? match[1].replace(/_/g, ".") : null;
  }

  // Which tab of the install guide to open first.
  function defaultTab(device) {
    if (device === "android") return "android";
    if (device === "iphone" || device === "ipad") return "iphone";
    return "pc";
  }

  // Desktop browser shown first in the computer guide (Brave reports itself as Chrome).
  function defaultBrowser(browser) {
    return browser === "edge" ? "edge" : "chrome";
  }

  function extensionsAddress(browser) {
    return browser === "edge" ? "edge://extensions" : browser === "brave" ? "brave://extensions" : "chrome://extensions";
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { detect, systemVersion, defaultTab, defaultBrowser, extensionsAddress };
  if (typeof document === "undefined") return;

  const found = detect(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);

  // Tabs
  const tabs = Array.prototype.slice.call(document.querySelectorAll("[role=tab]"));
  function selectTab(name) {
    tabs.forEach(function (tab) {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      document.getElementById("panel-" + tab.dataset.tab).hidden = !on;
    });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { selectTab(tab.dataset.tab); });
    tab.addEventListener("keydown", function (event) {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      selectTab(next.dataset.tab);
      next.focus();
    });
  });
  document.querySelectorAll("[data-open-tab]").forEach(function (link) {
    link.addEventListener("click", function () { selectTab(link.dataset.openTab); });
  });
  selectTab(defaultTab(found.device));

  // Browser chooser inside the computer guide
  const chips = Array.prototype.slice.call(document.querySelectorAll("[data-browser]"));
  function selectBrowser(name) {
    chips.forEach(function (chip) { chip.setAttribute("aria-pressed", chip.dataset.browser === name ? "true" : "false"); });
    document.querySelectorAll(".addr").forEach(function (node) { node.textContent = extensionsAddress(name); });
  }
  chips.forEach(function (chip) { chip.addEventListener("click", function () { selectBrowser(chip.dataset.browser); }); });
  selectBrowser(defaultBrowser(found.browser));

  // Copy buttons
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      const target = document.getElementById(button.dataset.copy);
      if (!navigator.clipboard || !target) return;
      navigator.clipboard.writeText(target.textContent).then(function () {
        const label = button.textContent;
        button.textContent = "¡Copiado!";
        setTimeout(function () { button.textContent = label; }, 1600);
      });
    });
  });

  const note = document.getElementById("detected");
  if (note) {
    const names = { windows: "una computadora Windows", mac: "una Mac", linux: "una computadora Linux", android: "un teléfono Android", iphone: "un iPhone", ipad: "un iPad" };
    note.textContent = names[found.device] ? "Parece que estás en " + names[found.device] + ". Abrimos la guía que te corresponde; puedes cambiarla arriba." : "Elige tu dispositivo arriba.";
  }
})();
