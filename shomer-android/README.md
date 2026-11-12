# Shomer Android

**Prototipo de captura, no filtro visual ni aplicación lista para distribución.** La app solicita consentimiento de MediaProjection, inicia un servicio en primer plano y descarta los cuadros sin guardarlos ni enviarlos. No integra ONNX, no detecta personas y no dibuja máscaras. No hay protección visual ni garantía de cubrir contenido antes de que aparezca. No se ha compilado un APK ni validado en un dispositivo físico en este entorno.

## Compilación

Con JDK 17, Gradle 8.9 y Android SDK 35 instalados, desde `shomer-android`:

```sh
gradle :app:assembleDebug
```

El resultado esperado es `app/build/outputs/apk/debug/app-debug.apk`, firmado solo con la clave de depuración local. No distribuirlo como producto terminado. Se necesita un SDK/Gradle funcional y una prueba física antes de afirmar que existe un APK verificado.

El workflow **Android prototype APK** también intenta construir este APK de depuración y adjuntarlo, con su SHA-256, como artefacto del resultado de GitHub Actions. Acceder al artefacto requiere los permisos de GitHub correspondientes. Es una compilación experimental firmada con una clave de depuración generada en el runner: no es una versión release, no tiene identidad de firma estable y no puede actualizar de forma fiable instalaciones de otras compilaciones. Su disponibilidad no demuestra que se haya instalado o probado en un teléfono. El prototipo no contiene filtro visual.

## Estado y límites

- La interfaz muestra inicio, espera del primer cuadro, recepción, parada y errores; no demuestra que el contenido capturado sea visible o no esté protegido. El estado vive en el proceso, no es un registro persistente.
- La captura requiere una nueva autorización después de detenerse o ser revocada. Se detiene desde la app o la acción de la notificación. En Android 13+ se puede solicitar el permiso de notificaciones; si está denegado o el canal bloqueado, la acción puede no aparecer en el panel. El servicio sigue siendo de primer plano y debe ser visible en los controles del sistema correspondientes.
- En Android 14+ se utiliza el cambio de tamaño notificado por MediaProjection para redimensionar la misma pantalla virtual y reemplazar su superficie, sin reutilizar el consentimiento para crear otra pantalla virtual. En versiones anteriores se observa la pantalla principal para cambios de tamaño/orientación. El comportamiento de captura de una sola app, rotación y revocación aún necesita pruebas reales en cada versión.
- Android puede bloquear o ennegrecer contenido protegido; no se intenta eludir esa protección. No se puede deducir protección a partir de un cuadro negro.
- No existe superposición: permisos, coordenadas, sincronización y realimentación de una futura máscara sobre la captura siguen sin resolver. No hay mediciones de latencia ni de rendimiento.

## Integración pendiente con la web

`shomer-web/engine/yolo-seg.js` usa `yolov8n-seg.onnx` con entrada RGB CHW, letterbox gris, detección de personas, NMS y prototipos de máscara. El worker combina esa máscara con clasificación de género y segmentación/regla de piel; el modelo de piel no está incluido actualmente en `shomer-web/models`. Falta portar y verificar ese procesamiento con ONNX Runtime Android, gestionar formatos/stride de ImageReader y contrastar las salidas con la web. No se han copiado modelos ni añadido dependencias de inferencia al prototipo.

## Validación física pendiente

En dispositivos con al menos una versión anterior a Android 14 y otra Android 14 o superior, registrar modelo, versión, tipo de captura y resultados sin inventar métricas:

1. Denegar/cancelar consentimiento y confirmar que no comienza la captura; autorizar y verificar notificación y recepción de cuadros.
2. Detener desde la app y desde la notificación; reiniciar y confirmar que se solicita consentimiento nuevo.
3. Rotar en ambos sentidos, cambiar de app y, en Android 14+, probar captura de una sola app y su cambio de tamaño. Comprobar que la captura continúa o que la app informa un error, sin asumir que una máscara cubre nada.
4. Revocar/detener la proyección desde el sistema y comprobar limpieza, estado y nueva autorización. Repetir con notificaciones denegadas y con el canal bloqueado.
5. Probar contenido protegido sin intentar eludir la protección y confirmar que no se guardan ni transmiten cuadros. Tras integrar la inferencia y la superposición, verificar además alineación y realimentación, y medir latencias reales por dispositivo.

Ninguna de estas pruebas físicas se ha ejecutado. Pausa/reanudación no están implementadas; detener y reiniciar crea una sesión nueva.
