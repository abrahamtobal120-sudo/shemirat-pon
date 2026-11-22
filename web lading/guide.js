(function () {
  "use strict";

  const DEVICES = ["iphone", "ipad", "android", "windows", "mac", "chromebook", "linux"];
  const COMPUTERS = ["windows", "mac", "chromebook", "linux"];
  const NAMES = { iphone: "iPhone", ipad: "iPad", android: "Android", windows: "Windows", mac: "Mac", chromebook: "Chromebook", linux: "Linux" };
  const BROWSER_NAMES = { chrome: "Chrome", edge: "Edge", brave: "Brave", firefox: "Firefox", safari: "Safari" };
  // Browsers offered in the chooser for each computer.
  const BROWSERS = {
    windows: ["chrome", "edge", "brave", "firefox"],
    mac: ["chrome", "edge", "brave", "firefox", "safari"],
    linux: ["chrome", "brave", "edge", "firefox"],
    chromebook: ["chrome"]
  };
  // Shomer Web only runs on Chromium browsers for now.
  const SUPPORTED = ["chrome", "edge", "brave"];

  function detect(userAgent, platform, touchPoints, isBrave) {
    const ua = userAgent || "";
    let device = "unknown";
    if (/iPad/i.test(ua) || (/Mac/i.test(platform || "") && touchPoints > 1)) device = "ipad";
    else if (/iPhone|iPod/i.test(ua)) device = "iphone";
    else if (/Android/i.test(ua)) device = "android";
    else if (/CrOS/i.test(ua)) device = "chromebook";
    else if (/Windows/i.test(ua)) device = "windows";
    else if (/Macintosh|Mac OS X/i.test(ua)) device = "mac";
    else if (/Linux/i.test(ua)) device = "linux";

    let browser = "unknown";
    if (/FBAN|FBAV|Instagram|Line\/|; wv\)|\bwv\b/i.test(ua)) browser = "embedded";
    else if (/EdgA?\/|EdgiOS\//i.test(ua)) browser = "edge";
    else if (/Firefox\/|FxiOS\//i.test(ua)) browser = "firefox";
    else if (isBrave) browser = "brave";
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

  function isComputer(device) {
    return COMPUTERS.indexOf(device) !== -1;
  }

  // Device whose guide opens first; unknown visitors get Windows, the most common computer.
  function defaultDevice(device) {
    return DEVICES.indexOf(device) !== -1 ? device : "windows";
  }

  // Panel that holds the guide for a device.
  function panelFor(device) {
    if (device === "android") return "android";
    if (device === "iphone" || device === "ipad") return "apple";
    return "computer";
  }

  // Browser preselected in the computer guide: the visitor's own browser when that computer offers it.
  function defaultBrowser(browser, device) {
    const offered = BROWSERS[device] || BROWSERS.windows;
    return offered.indexOf(browser) !== -1 ? browser : "chrome";
  }

  function isSupported(browser) {
    return SUPPORTED.indexOf(browser) !== -1;
  }

  // Top-level choice in the picker: every computer falls under "computer".
  function kindFor(device) {
    return isComputer(device) ? "computer" : device;
  }

  // One-line description of the guide being shown.
  function summary(device, browser) {
    if (device === "android") return "Android (teléfono o tablet)";
    if (device === "iphone" || device === "ipad") return NAMES[device] + " · filtro de Apple";
    if (device === "chromebook") return "Chromebook · Chrome";
    return "Computadora " + NAMES[device] + " · " + BROWSER_NAMES[browser];
  }

  function extensionsAddress(browser) {
    return browser === "edge" ? "edge://extensions" : browser === "brave" ? "brave://extensions" : "chrome://extensions";
  }

  const api = { detect, systemVersion, isComputer, defaultDevice, panelFor, defaultBrowser, isSupported, extensionsAddress, kindFor, summary, BROWSERS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  const found = detect(navigator.userAgent, navigator.platform, navigator.maxTouchPoints, !!navigator.brave);
  const state = { device: defaultDevice(found.device), browser: "chrome" };
  // Computer shown when the visitor taps "Computadora": theirs if they are on one, else the last one picked.
  let lastComputer = isComputer(found.device) ? found.device : "windows";

  function matches(list, value) {
    return (list || "").split(/\s+/).indexOf(value) !== -1;
  }

  function render() {
    const panel = panelFor(state.device);
    const supported = isSupported(state.browser);
    const kind = kindFor(state.device);
    document.querySelectorAll("[data-kind]").forEach(function (button) {
      button.setAttribute("aria-pressed", button.dataset.kind === kind ? "true" : "false");
    });
    document.querySelectorAll("[data-kind-only]").forEach(function (node) { node.hidden = node.dataset.kindOnly !== kind; });
    document.querySelectorAll("[data-device]").forEach(function (button) {
      button.setAttribute("aria-pressed", button.dataset.device === state.device ? "true" : "false");
    });
    const line = document.getElementById("summary");
    if (line) line.textContent = summary(state.device, state.browser);
    document.querySelectorAll("[data-browser]").forEach(function (chip) {
      chip.setAttribute("aria-pressed", chip.dataset.browser === state.browser ? "true" : "false");
    });
    document.querySelectorAll("[data-panel]").forEach(function (node) { node.hidden = node.dataset.panel !== panel; });
    document.querySelectorAll("[data-only]").forEach(function (node) { node.hidden = !matches(node.dataset.only, state.device); });
    document.querySelectorAll("[data-only-browser]").forEach(function (node) { node.hidden = !matches(node.dataset.onlyBrowser, state.browser); });
    document.querySelectorAll("[data-when-supported]").forEach(function (node) { node.hidden = !supported; });
    document.querySelectorAll("[data-when-unsupported]").forEach(function (node) { node.hidden = supported; });
    document.querySelectorAll("[data-device-name]").forEach(function (node) { node.textContent = NAMES[state.device]; });
    document.querySelectorAll("[data-browser-name]").forEach(function (node) { node.textContent = BROWSER_NAMES[state.browser]; });
    document.querySelectorAll(".addr").forEach(function (node) { node.textContent = extensionsAddress(state.browser); });
  }

  function selectDevice(device) {
    if (isComputer(device)) lastComputer = device;
    state.device = device;
    state.browser = defaultBrowser(state.browser, device);
    render();
  }

  document.querySelectorAll("[data-device]").forEach(function (button) {
    button.addEventListener("click", function () { selectDevice(button.dataset.device); });
  });
  document.querySelectorAll("[data-kind]").forEach(function (button) {
    button.addEventListener("click", function () {
      selectDevice(button.dataset.kind === "computer" ? lastComputer : button.dataset.kind);
    });
  });
  document.querySelectorAll("[data-browser]").forEach(function (chip) {
    chip.addEventListener("click", function () { state.browser = chip.dataset.browser; render(); });
  });
  // Links elsewhere on the page that jump to a device's guide ("computer" means the visitor's computer).
  document.querySelectorAll("[data-open-device]").forEach(function (link) {
    link.addEventListener("click", function () {
      const wanted = link.dataset.openDevice;
      if (wanted === "computer") selectDevice(lastComputer);
      else if (wanted === "apple") selectDevice(found.device === "ipad" ? "ipad" : "iphone");
      else selectDevice(wanted);
    });
  });

  state.browser = defaultBrowser(found.browser, state.device);
  render();

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
    note.textContent = DEVICES.indexOf(found.device) !== -1
      ? "Parece que estás en " + (found.device === "android" ? "un teléfono Android" : found.device === "chromebook" ? "un Chromebook" : found.device === "linux" ? "una computadora Linux" : found.device === "windows" ? "una computadora Windows" : "un " + NAMES[found.device]) + ", así que ya lo elegimos. Si no es así, cámbialo arriba."
      : "Elige tu dispositivo arriba para ver sus pasos.";
  }
})();
