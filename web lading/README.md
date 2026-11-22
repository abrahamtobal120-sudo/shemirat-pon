# Página de Shomer

Desde esta carpeta ejecuta `python3 build.py`. El resultado está en `public/`; incluye la página, el asistente y el ZIP generado desde `../shomer-web`. Para revisarlo localmente, ejecuta `python3 -m http.server 8000 --directory public` y abre `http://localhost:8000/`. Las pruebas del asistente se ejecutan con `node --test guide.test.js`.

Vercel utiliza `vercel.json`: el directorio raíz del proyecto debe ser `web lading`, el comando de compilación `python3 build.py` y el directorio de salida `public`. Confirma la identidad y dominio del proyecto antes de desplegar; no hay una vinculación de Vercel guardada en este repositorio.

Android: la página enlaza al APK firmado del release `android-vX.Y.Z` de GitHub (lo genera el workflow «Android APK» con la clave de los secretos `SHOMER_*`). Para una versión nueva, sube `versionName`, publica el release y cambia el enlace en `index.html`. iPhone aún no tiene enlace de instalación.

Capturas: todas las imágenes de `img/` son capturas reales. Las de Android salen del workflow «Android screenshots» (`shomer-android/screenshots/capture.sh`), que instala el APK publicado en un emulador con Android 14 y recorre la instalación y la app. Las de Chrome salen del workflow «Website screenshots» (`tools/capturas-chrome.mjs`). Las de Edge se tomaron con el Edge de Windows. Las de iPhone no existen todavía: no hay un Mac para tomarlas. Tras una versión nueva, vuelve a lanzar los workflows, descarga los artefactos y reemplaza los `.webp` (Android en 540×1200).

