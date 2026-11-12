# Shomer para Safari en iPhone y iPad

Proyecto experimental separado de `shomer-ios` (bloqueo de apps) y de `shomer-web` (extensión para computadora). Su objetivo es adaptar el filtro existente a Safari, **solo dentro de Safari**. No hay una extensión instalada, probada ni disponible para descarga.

## Preparar el proyecto

Se necesita una Mac con Xcode completo, sus herramientas de línea de comandos y Python 3. Desde la raíz del repositorio:

```sh
python3 shomer-safari/prepare.py
```

El script copia los archivos necesarios de `shomer-web` a `shomer-safari/dist/extension` y ejecuta el convertidor de Apple para generar un proyecto iOS en `shomer-safari/dist`. No modifica la extensión de computadora ni sobrescribe una generación anterior. Si el directorio ya existe, muévelo manualmente antes de volver a ejecutar. El identificador `dev.shomer.safari` es un marcador para desarrollo: hay que sustituirlo por identificadores únicos autorizados para la app y la extensión en Xcode.

Las pruebas locales de preparación (no ejecutan el convertidor) se pueden correr con `python3 -m unittest discover -s shomer-safari -p 'test_*.py'`.

Abre el proyecto generado en Xcode, configura el equipo y la firma de ambos targets, compila e instala en un iPhone de prueba. En Safari, activa la extensión y concede los permisos que solicite. La distribución pública requiere la cuenta, certificados, perfiles y revisión correspondientes de Apple.

## Limitaciones y pruebas pendientes

La conversión generó un proyecto con Xcode 26.6 en GitHub Actions; eso no garantiza compatibilidad ni instalación. Hay que comprobar las APIs de fondo y de reglas de red, el iframe y los mensajes del motor, Web Workers, WebAssembly/ONNX, memoria, acceso a recursos y permisos de Safari. Deben probarse imágenes, videos, activación/desactivación, errores y comportamiento tras cerrar y reabrir Safari en iPhone real. No se ha medido rendimiento ni se ha producido un IPA o un enlace de TestFlight/App Store.
