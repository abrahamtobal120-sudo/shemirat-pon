# Shomer iOS

App nativa con FamilyControls y ManagedSettings. Tiene dos modos (se recuerdan entre sesiones):

- **Solo navegador:** activa el filtro de sitios para adultos de Apple (`store.webContent.blockedByFilter = .auto()`), que funciona en Safari, en los demás navegadores (todos usan WebKit en iOS) y en las páginas web que se abren dentro de otras apps. También bloquea los dominios que elijas.
- **Todo el teléfono:** lo anterior, más el bloqueo de las apps y categorías elegidas (`shield`), el contenido explícito de música, podcasts y libros de Apple (`media.denyExplicitContent`) y, si se activa, impide borrar apps para proteger Shomer (`application.denyAppRemoval`).

La selección se guarda localmente; los errores de lectura/escritura se muestran en la interfaz. Shomer no analiza ni cubre imágenes dentro de otras apps: iOS no lo permite.

## Lista para firmar

- `project.yml` ya incluye versión (0.2.0 / build 2), icono 1024×1024 (`Sources/Assets.xcassets`, regenerable con `python3 scripts/make_app_icon.py`), firma automática, `ITSAppUsesNonExemptEncryption = NO` y el entitlement `com.apple.developer.family-controls`.
- Solo falta escribir tu **Team ID** en `DEVELOPMENT_TEAM` (o pasarlo a xcodebuild) y, si `dev.shomer.ios` no está disponible, cambiar `PRODUCT_BUNDLE_IDENTIFIER`.
- **Requisito de Apple:** para TestFlight/App Store hay que pedir el entitlement *Family Controls (Distribution)* en https://developer.apple.com/contact/request/family-controls-distribution. En desarrollo funciona sin esa aprobación.
- Archivar y subir a TestFlight desde una Mac:

```sh
cd shomer-ios && xcodegen generate
xcodebuild -project Shomer.xcodeproj -scheme Shomer -configuration Release   -destination 'generic/platform=iOS' -archivePath build/Shomer.xcarchive   DEVELOPMENT_TEAM=TU_TEAM_ID -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath build/Shomer.xcarchive   -exportOptionsPlist ExportOptions.plist -exportPath build/export -allowProvisioningUpdates
```

El workflow **iOS app (Family Controls)** compila la app sin firma en macOS en cada cambio y publica `shomer-ios-sin-firmar.ipa` como artefacto (no se instala sin firmar).

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
