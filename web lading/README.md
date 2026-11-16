# Página de Shomer

Desde esta carpeta ejecuta `python3 build.py`. El resultado está en `public/`; incluye la página, el asistente y el ZIP generado desde `../shomer-web`. Para revisarlo localmente, ejecuta `python3 -m http.server 8000 --directory public` y abre `http://localhost:8000/`. Las pruebas del asistente se ejecutan con `node --test guide.test.js`.

Vercel utiliza `vercel.json`: el directorio raíz del proyecto debe ser `web lading`, el comando de compilación `python3 build.py` y el directorio de salida `public`. Confirma la identidad y dominio del proyecto antes de desplegar; no hay una vinculación de Vercel guardada en este repositorio.

Android: la página enlaza al APK firmado del release `android-vX.Y.Z` de GitHub (lo genera el workflow «Android APK» con la clave de los secretos `SHOMER_*`). Para una versión nueva, sube `versionName`, publica el release y cambia el enlace en `index.html`. iPhone aún no tiene enlace de instalación.
