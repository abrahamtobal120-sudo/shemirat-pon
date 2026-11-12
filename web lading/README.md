# Página de Shomer

Desde esta carpeta ejecuta `python3 build.py`. El resultado está en `public/`; incluye la página, el asistente y el ZIP generado desde `../shomer-web`. Para revisarlo localmente, ejecuta `python3 -m http.server 8000 --directory public` y abre `http://localhost:8000/`. Las pruebas del asistente se ejecutan con `node --test guide.test.js`.

Vercel utiliza `vercel.json`: el directorio raíz del proyecto debe ser `web lading`, el comando de compilación `python3 build.py` y el directorio de salida `public`. Confirma la identidad y dominio del proyecto antes de desplegar; no hay una vinculación de Vercel guardada en este repositorio.

Las versiones móviles no tienen enlaces de instalación hasta contar con binarios firmados, distribución autorizada y pruebas físicas. No se han comprobado todavía combinaciones de dispositivos reales ni existe una captura auténtica del filtro para la página.
