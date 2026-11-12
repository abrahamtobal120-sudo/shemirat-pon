# Shomer iOS

Aplicación nativa que usa FamilyControls para solicitar autorización individual y mostrar el selector del sistema. La selección de apps, categorías y dominios se guarda localmente; los errores de lectura/escritura se muestran en la interfaz, y una selección ilegible no se sobrescribe automáticamente. ManagedSettings recibe o retira las restricciones cuando se pulsan los botones correspondientes. El estado de autorización se vuelve a leer al regresar a primer plano. Shomer no filtra imágenes dentro de otras aplicaciones.

## Generar y compilar

Se requiere macOS con Xcode instalado. Desde la raíz del repositorio:

```sh
brew install xcodegen  # omitir si XcodeGen ya está instalado
cd shomer-ios
xcodegen generate
xcodebuild -version
xcodebuild -project Shomer.xcodeproj -scheme Shomer \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

La compilación sin firma verifica el proyecto, pero no demuestra que FamilyControls esté autorizado ni que los bloqueos funcionen en un dispositivo.

## Firma y validación en dispositivo

1. Abre `Shomer.xcodeproj` en Xcode, selecciona el target **Shomer** y configura un Team de firma y un identificador de paquete único.
2. Confirma que el target incluye el entitlement `com.apple.developer.family-controls` (`Shomer.entitlements`). La disponibilidad del entitlement/perfil depende del equipo y del tipo de distribución; no supongas que una compilación de desarrollo autoriza distribución.
3. Selecciona un iPhone compatible, firma y ejecuta desde Xcode. En el dispositivo, prueba solicitar autorización, elegir elementos, salir y volver a abrir la app, aplicar el bloqueo, comprobar el efecto en los elementos elegidos y quitarlo. Prueba también denegar autorización y volver a primer plano después de cambiar su estado.

No se ha validado aquí una compilación, firma, entitlement de distribución ni ejecución física: este entorno no tiene macOS/Xcode. No hay IPA ni release verificados. La app reporta el estado de autorización real que expone FamilyControls y describe las restricciones como enviadas a ManagedSettings; no puede confirmar desde su interfaz que cada bloqueo sea efectivo en el dispositivo.
