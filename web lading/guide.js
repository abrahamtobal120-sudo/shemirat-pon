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

  function guide(device, browser, goal) {
    const mobile = device === "android" || device === "iphone" || device === "ipad";
    const desktop = device === "windows" || device === "mac" || device === "linux";
    if (mobile) {
      const apple = device !== "android";
      const steps = [];
      if (browser === "embedded") steps.push("Si estás dentro de otra aplicación, abre esta página en " + (apple ? "Safari" : "Chrome") + " desde el menú de compartir.");
      steps.push("Consulta el estado de la versión " + (apple ? "para iPhone y iPad" : "para Android") + " en la guía de abajo.");
      steps.push("Espera al enlace oficial: todavía no hay una versión móvil firmada y probada para instalar.");
      return { title: "Versión móvil en preparación", note: "No podemos activar ni comprobar una protección móvil desde esta página.", steps, link: apple ? "#guia-iphone" : "#guia-android", linkText: apple ? "Ver guía de iPhone y iPad" : "Ver guía de Android" };
    }
    if (!desktop) return { title: "Elige tu dispositivo", note: "Selecciona tu dispositivo para ver la guía que corresponde.", steps: [] };
    const supported = browser === "chrome" || browser === "edge" || browser === "brave";
    if (!supported) return { title: "Usa un navegador compatible", note: "La descarga de esta página es para Chrome, Edge o Brave en computadora; no es una app de escritorio.", steps: ["Selecciona Chrome, Edge o Brave si ya lo usas.", "Si usas otro navegador, abre esta página en uno de ellos para seguir la guía."], link: "#ayuda", linkText: "Ver preguntas frecuentes" };
    const address = browser === "edge" ? "edge://extensions" : browser === "brave" ? "brave://extensions" : "chrome://extensions";
    if (goal === "activate") return { title: "Revisa la protección en tu navegador", note: "La página no puede comprobar el estado de la extensión por ti.", steps: ["Abre el menú de extensiones del navegador y selecciona Shomer Web.", "Revisa los ajustes y elige el nivel de filtro que prefieras.", "Prueba el resultado en una página conocida: la detección puede equivocarse.", "Para detenerla, abre " + address + " y desactiva Shomer Web."] };
    if (goal === "help") return { title: "Si Shomer Web no funciona", note: "Estos pasos corresponden a " + (browser === "edge" ? "Edge" : browser === "brave" ? "Brave" : "Chrome") + " en computadora.", steps: ["Abre " + address + " en la barra de direcciones.", "Comprueba que Shomer Web aparezca y esté activado.", "Si no aparece, vuelve a la opción «Instalar» y sigue los pasos.", "Si no filtra una página, revisa los ajustes de Shomer y vuelve a cargarla."], link: "#ayuda", linkText: "Ver más preguntas" };
    return { title: "Instala la extensión en tu computadora", note: "Necesitas Chrome, Edge o Brave y espacio para el archivo descargado. No existe una app nativa de escritorio.", steps: ["Descarga el archivo ZIP de Shomer Web desde el enlace de abajo.", "Abre Descargas y descomprime el archivo ZIP.", "Guarda la carpeta shomer-web en un lugar permanente de tu computadora.", "Escribe " + address + " en la barra de direcciones y abre esa página.", "Activa «Modo de desarrollador».", "Pulsa «Cargar descomprimida» y selecciona la carpeta shomer-web.", "Abre Shomer Web desde el menú de extensiones y revisa sus ajustes."], link: "/downloads/shomer-web.zip", linkText: "Descargar Shomer Web (ZIP)" };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { detect, guide };
  if (typeof document === "undefined") return;
  const device = document.getElementById("device");
  const browser = document.getElementById("browser");
  const goal = document.getElementById("goal");
  const found = detect(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  device.value = found.device;
  browser.value = found.browser;
  document.getElementById("detected").textContent = "Detección aproximada: " + device.options[device.selectedIndex].text + " · " + browser.options[browser.selectedIndex].text + ". La versión del sistema no se ha comprobado.";

  function render() {
    const result = guide(device.value, browser.value, goal.value);
    document.getElementById("guide-title").textContent = result.title;
    document.getElementById("guide-note").textContent = result.note;
    const list = document.getElementById("guide-steps");
    list.replaceChildren();
    result.steps.forEach(function (step) {
      const item = document.createElement("li");
      item.textContent = step;
      list.appendChild(item);
    });
    const link = document.getElementById("guide-link");
    link.replaceChildren();
    if (result.link) {
      const anchor = document.createElement("a");
      anchor.href = result.link;
      anchor.textContent = result.linkText;
      if (result.link.startsWith("/downloads/")) anchor.setAttribute("download", "");
      link.appendChild(anchor);
    }
  }
  [device, browser, goal].forEach(function (control) { control.addEventListener("change", render); });
  render();
})();
