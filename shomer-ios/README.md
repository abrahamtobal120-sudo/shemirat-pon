# Shomer iOS

Primera implementación nativa con FamilyControls y ManagedSettings. Permite solicitar autorización individual, elegir apps y aplicar o retirar los bloqueos del sistema. No modifica imágenes dentro de otras aplicaciones.

Genera el proyecto en una Mac con XcodeGen ejecutando `xcodegen generate`. Abre Shomer.xcodeproj, selecciona tu equipo de firma y habilita Family Controls para el identificador de la app. Compila e instala en un dispositivo físico autorizado.

Pendientes la compilación con Xcode, pruebas físicas, persistencia de la selección, diseño final, autorización de distribución de Family Controls y firma/TestFlight. No existe aún un IPA de distribución.
