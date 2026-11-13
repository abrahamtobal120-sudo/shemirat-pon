# Shomer Android

## Filtro de todo el teléfono o solo navegadores

La app incluye un filtro DNS local (`FilterVpnService`, basado en `VpnService` de Android):

- **Todo el teléfono:** todas las apps (excepto Shomer) resuelven nombres a través de Shomer.
- **Solo navegadores:** el filtro se aplica únicamente a los navegadores instalados (Chrome, Firefox, Samsung Internet, Edge, Opera, Brave, DuckDuckGo…), detectados con `queryIntentActivities` más una lista de paquetes conocidos.

Los dominios de `app/src/main/assets/blocklist.txt` (publicidad de `shomer-web/rules/ad_rules.json` y sitios para adultos), sus subdominios y los nombres que contienen palabras clave como `porn` o `xxx` reciben NXDOMAIN. El resto se reenvía a **CleanBrowsing Family** (`185.228.168.168`, `185.228.169.168`), que también bloquea contenido para adultos y fuerza la búsqueda segura de Google, Bing y YouTube; si no responde se usa **Cloudflare for Families** (`1.1.1.3`, `1.0.0.3`). Solo pasan por la VPN las consultas DNS; el resto del tráfico va directo y no se guarda historial. La app muestra cuántas consultas revisó y bloqueó.

Para que no se pueda saltar fácilmente: Ajustes › Red › VPN › Shomer › **VPN siempre activa** y **Bloquear conexiones sin VPN** (botón «Hacerlo permanente» en la app). Límites conocidos: solo una VPN a la vez; un «DNS privado» con nombre de proveedor o apps con DNS cifrado propio (DoH) pueden saltarse el filtro; no analiza imágenes dentro de las apps (eso lo hace el filtro de imágenes descrito abajo).

La lógica de paquetes DNS está en `DnsFilter.java` y tiene pruebas JUnit (`gradle :app:testDebugUnitTest`).

## Firma del APK de distribución

`assembleRelease` firma el APK si existen estas variables de entorno: `SHOMER_KEYSTORE` (ruta del .jks), `SHOMER_KEYSTORE_PASSWORD`, `SHOMER_KEY_ALIAS` y `SHOMER_KEY_PASSWORD`. Para crear la clave una sola vez (guárdala en un lugar seguro; sin ella no se pueden publicar actualizaciones):

```sh
keytool -genkeypair -v -keystore shomer-release.jks -alias shomer -keyalg RSA -keysize 4096 -validity 10000
```

En GitHub Actions, el workflow firma automáticamente si el repositorio tiene los secretos `SHOMER_KEYSTORE_BASE64` (el .jks en base64), `SHOMER_KEYSTORE_PASSWORD`, `SHOMER_KEY_ALIAS` y `SHOMER_KEY_PASSWORD`. Sin ellos genera `app-release-unsigned.apk`.

## Filtro de imágenes en todo el teléfono (experimental)

`CaptureService` refleja la pantalla en una pantalla virtual privada y pequeña (lado largo de 960 px) mediante MediaProjection. Analiza como mucho un cuadro cada 250 ms, y solo cuando la pantalla cambia. Encima de cualquier app dibuja recuadros grises opacos sobre las personas que hay que tapar. Los cuadros solo existen en memoria: no se guardan ni se envían.

- **Modelos:** los mismos que Shomer Web, tomados directamente de `shomer-web/models` al compilar (no hay copias): `yolov8n-seg.onnx` para detectar personas y `gender.onnx` para estimar P(mujer). Se ejecutan con ONNX Runtime Android (`ScreenDetector`). Se usan los valores por defecto de `shomer-web/common/settings.js`: confianza de persona 0,25 y umbral de mujer 0,35 (si hay duda, se tapa). Se ignoran las personas de menos del 5 % de la altura. Si falta el modelo de género, se tapa a todas las personas.
- **Pantallas altas:** el cuadro se divide en dos mosaicos solapados (`YoloDecoder.tiles`) para que las personas pequeñas de los feeds no se pierdan con el letterbox.
- **Realimentación:** Shomer captura sus propios recuadros, así que en el cuadro siguiente ya no ve a la persona tapada. `CoverTracker` mantiene los recuadros mientras el resto de la pantalla no cambie. Para saberlo compara una rejilla de luminancia de 24×48 que ignora las celdas tapadas. Si cambia más del 22 % de lo visible (desplazamiento, otra app, otra foto), quita los recuadros y vuelve a analizar enseguida. Si una persona asoma por fuera de un recuadro, el recuadro crece.
- **Superposición:** cada recuadro es una ventana `TYPE_APPLICATION_OVERLAY` independiente (`CoverOverlay`), no una ventana a pantalla completa. Desde Android 12, una superposición opaca de otra app bloquea los toques, y a pantalla completa dejaría el teléfono sin respuesta. Así solo se pierden los toques sobre la zona tapada.
- **Permisos:** «Mostrar sobre otras apps» (`SYSTEM_ALERT_WINDOW`, la app abre el ajuste) y el consentimiento de captura en cada activación. En Android 14+ se pide la pantalla completa (`createConfigForDefaultDisplay`), porque la captura de una sola app descuadraría los recuadros.
- El modelo se copia una vez a almacenamiento privado (`noBackupFilesDir/models`). Los `.onnx` van sin comprimir en el APK, que crece unos 60 MB por los modelos más ONNX Runtime (ARM y x86_64).

Límites conocidos:

- Hay latencia: algo nuevo puede verse una fracción de segundo antes de taparse, y al desplazarte los recuadros se recalculan. No hay mediciones reales de latencia ni de batería.
- Se tapa la caja de la persona, no su silueta ni solo la piel como en la web (aún no hay modelo de piel).
- El contenido protegido (DRM, `FLAG_SECURE`) aparece en negro para Shomer y no se filtra. No se intenta eludir esa protección.
- Los recuadros usan coordenadas de pantalla completa. En algunos fabricantes, la barra de estado o los recortes pueden desplazarlos ligeramente.
- Al girar la pantalla se borran los recuadros y se vuelve a analizar.

La lógica pura (decodificación YOLO, NMS, letterbox, mosaicos y seguimiento de recuadros) tiene pruebas JUnit en `ScreenFilterTest.java`.

## Compilación

Con JDK 17, Gradle 8.9 y Android SDK 35 instalados, desde `shomer-android`:

```sh
gradle :app:testDebugUnitTest :app:assembleDebug
```

El resultado esperado es `app/build/outputs/apk/debug/app-debug.apk`, firmado solo con la clave de depuración local. No distribuirlo como producto terminado. El workflow **Android prototype APK** ejecuta las pruebas y genera el APK de depuración y uno release (firmado solo si existen los secretos), con sus SHA-256, como artefactos de GitHub Actions. Que esté disponible no demuestra que se haya probado en un teléfono.

## Validación física pendiente

Nada de lo siguiente se ha probado todavía en un teléfono real. En dispositivos con Android anterior a 14 y con Android 14 o superior, registra modelo, versión y resultados sin inventar métricas:

1. Conceder y denegar «Mostrar sobre otras apps» y la captura. Comprobar que sin permisos no arranca y que la app lo explica.
2. Abrir fotos y feeds (galería, Instagram, navegador) con hombres y mujeres. Comprobar que los recuadros caen sobre las personas, cuánto tardan y si se desalinean con la barra de estado o en horizontal.
3. Desplazarse despacio y rápido. Comprobar que los recuadros se recalculan y que no queda ninguno huérfano ni parpadea en bucle.
4. Tocar y desplazarse fuera y encima de los recuadros en Android 11 y en Android 12+.
5. Girar la pantalla, detener desde la notificación, revocar la captura desde el sistema y comprobar la limpieza (sin recuadros residuales).
6. Medir el consumo de batería y la temperatura durante 30 minutos de uso, y el tiempo de carga del modelo.
