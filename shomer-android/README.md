# Shomer Android

Prototipo de captura autorizada. Todavía no incorpora inferencia ni superposición de máscaras, y no debe distribuirse como filtro terminado.

Compilar con JDK 17, Gradle 8.9 y Android SDK 35 mediante `gradle :app:assembleDebug`. La compilación y la prueba física están pendientes.

La captura comienza tras el consentimiento del sistema, utiliza una notificación visible y puede detenerse desde la app o la notificación. Descarta cada cuadro. Al cambiar el tamaño de la captura, detiene la sesión.

Pendiente integrar los modelos ONNX de shomer-web, resolver la realimentación de máscaras, medir rendimiento y firmar el APK de distribución.
