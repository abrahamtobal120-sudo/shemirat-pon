# Prompt maestro para Claude — ejecución completa de Shomer

> **Para Claude Code / Claude en la computadora.** Esta es una orden de ejecución, no una solicitud de plan. Inspecciona el repositorio, modifica archivos, ejecuta comandos y pruebas, compila y publica lo que sea posible. No afirmes haber hecho algo que no hayas verificado. El propietario no es programador: el resultado debe poder usarse siguiendo instrucciones sencillas.

## Proyecto y objetivo

- Repositorio: `abrahamtobal120-sudo/shemirat-pon`
- Proyecto: Shomer.
- Tarea principal: issue #1 y todos sus comentarios.
- Objetivo: rehacer profundamente la página de Seguridad, crear un asistente de instalación personalizado por dispositivo/navegador, entregar instaladores móviles reales y guías para personas sin conocimientos técnicos.

**Trabaja directamente en el código.** No te limites a comentar en GitHub ni a devolver un plan. Usa subagentes en paralelo si tu entorno los ofrece: Web/UX, Android, iOS y QA. Si no, organiza las tareas para que el trabajo web no espere a que terminen las aplicaciones móviles.

## 1. Seguridad del repositorio y sincronización

1. Comprueba `git remote -v`, `git status`, `git branch --show-current`, ramas y commits.
2. Ejecuta `git fetch origin`.
3. Actualiza la rama correcta con `git pull --rebase` solo después de revisar el árbol de trabajo y preservar cambios locales.
4. Nunca ejecutes `git reset --hard`, `git clean -fd`, ni borres cambios de otros trabajos. No hagas force-push.
5. Si hay cambios sin guardar, consérvalos y crea una rama de trabajo segura.
6. Usa ramas separadas para Web/UX, Android, iOS y QA. No permitas que dos agentes editen simultáneamente los mismos archivos.
7. Haz commits pequeños y descriptivos y crea Pull Requests cuando sea posible.
8. No cierres la issue #1 hasta cumplir los criterios de aceptación.

## 2. Inspección obligatoria antes de programar

Inspecciona estructura, framework, rutas, componentes, estilos, scripts, lockfiles, configuración de Vercel y estado real de los proyectos. Revisa las carpetas/proyectos existentes, incluidos `web lading`, `shomer-web`, `shomer-tv`, `shomer-sport`, `shomer-android` y `shomer-ios`, usando los nombres reales que encuentres.

Identifica qué funciona, qué es prototipo y qué falta. No inventes funciones, compatibilidad, métricas, certificaciones, testimonios ni datos. No reemplaces funcionalidades existentes por demos. Conserva la independencia de los proyectos y sus despliegues.

## 3. Rediseño profundo de Seguridad

La página actual no alcanza el nivel esperado. No hagas un retoque superficial: replantea diseño, jerarquía, composición, tipografía, textos y experiencia.

**Dirección visual solicitada:**
- Azul suave / azul cielo profesional como color principal.
- Superficies translúcidas y efecto cristal muy sutil; transparencias elegantes, no excesivas.
- Fondos limpios, buen contraste, tipografía de calidad y espacios generosos.
- Estética premium de producto tecnológico serio, sobrio y confiable.
- Botones, estados, navegación, iconografía y componentes consistentes.
- Responsive de verdad en iPhone, Android, tablet y escritorio.
- Animaciones discretas y accesibilidad completa.
- Evitar aspecto de plantilla genérica o “hecha por IA”: nada infantil, textos vacíos, tarjetas repetitivas, degradados chillones ni adornos sin función.

**Contenido sugerido:** hero claro; qué hace Shomer; funciones reales; cómo funciona; demostración de bloqueo; diferencias Web/Android/iPhone; privacidad y permisos; compatibilidad probada; asistente de instalación; descargas; guías; preguntas frecuentes y CTA final. Copy natural en español, claro y sin exageraciones.

## 4. Captura auténtica: bloqueo de una azafata en un avión

En la sección de bloqueo se solicita una captura de pantalla auténtica del producto bloqueando contenido de prueba que muestre una azafata adulta, con uniforme profesional, dentro de un avión.

1. Prepara una página o imagen de prueba neutral y apta para todo público con esa escena.
2. Ejecuta la prueba en un dispositivo compatible con la versión real de Shomer.
3. Activa la protección y verifica que Shomer bloquea el contenido conforme a las reglas realmente implementadas.
4. Captura la pantalla real con el estado de bloqueo y el mensaje auténtico de Shomer.
5. Optimiza la captura para la web, añade texto alternativo y explica qué demuestra.
6. No fabriques una captura y la presentes como real. No montes una pantalla falsa en un editor.
7. Si aún no existe esa capacidad, no falsifiques evidencia: implementa primero lo técnicamente posible o usa un mockup claramente rotulado como “demostración conceptual”.
8. Documenta dispositivo, sistema, versión y pasos de prueba.

No prometas bloqueo universal. Describe con precisión las limitaciones de Android y de iOS. En iOS explica las restricciones de Family Controls/Screen Time APIs; no afirmes que se pueden poner máscaras visuales encima de cualquier app.

## 5. Asistente personalizado: “Instala Shomer en tu dispositivo”

Detecta localmente, sin enviar datos a servidores:
- Dispositivo: iPhone, iPad, Android, Windows, Mac, Linux u otro.
- Sistema operativo y versión cuando el navegador lo permita.
- Navegador: Safari, Chrome, Firefox, Edge u otro.
- Navegador integrado dentro de WhatsApp, Instagram u otra aplicación, si puede identificarse.
- Tipo de pantalla: móvil, tablet o escritorio.

Mostrar, por ejemplo: “Tu dispositivo: iPhone / Tu navegador: Safari / Tu sistema: iOS”. No inventar versiones. Si un dato no puede obtenerse, mostrar “No se pudo detectar” y ofrecer selección manual.

Permitir cambiar dispositivo, sistema, navegador y objetivo (instalar, activar protección o solucionar un problema). La guía debe actualizarse inmediatamente. La detección es aproximada y debe poder corregirse.

**Las instrucciones deben ser personalizadas y muy claras.** Cada paso debe indicar una sola acción: qué botón tocar, dónde está, qué texto buscar, qué aviso puede aparecer, qué opción elegir y cómo comprobar que funcionó. Mostrar solo los pasos correspondientes al entorno detectado. Incluir ayuda para abrir enlaces desde navegadores integrados en Safari o Chrome.

La detección ocurre en el cliente; no enviar user-agent, sistema, dispositivo ni selecciones a analytics o terceros. No guardar la selección más allá de la sesión salvo necesidad demostrada.

## 6. Android: APK real, firmado y probado

No basta el código fuente o un prototipo.

1. Completa el proyecto Android existente.
2. Corrige dependencias y errores de compilación.
3. Implementa permisos y servicios necesarios con consentimiento explícito y explicación clara.
4. Prueba inicio, pausa, reanudación, parada, rotación, cambio de app, revocación de permisos y errores.
5. Protege privacidad: no guardar ni enviar capturas sin una función explícita, necesaria e informada.
6. No prometas overlay/filtro universal si el sistema no lo permite.
7. Compila un APK release, fírmalo con clave segura y no subas secretos ni claves privadas al repositorio.
8. Verifica firma, package ID, versión, tamaño y SHA-256.
9. Instálalo desde cero en un Android físico compatible, sin herramientas de desarrollo.
10. Prueba el archivo final y publica ese mismo APK en una URL estable.
11. Prueba la descarga desde un teléfono externo al entorno de desarrollo.

En la web muestra versión, fecha, tamaño y requisitos reales. Si no hay APK probado, muestra “En preparación”; no pongas botón falso.

## 7. iPhone: compilación y distribución real

1. Completa el proyecto iOS.
2. Compila en Xcode y configura Bundle ID, certificados, perfiles, capabilities y entitlements.
3. Verifica Family Controls y APIs de Screen Time con las autorizaciones requeridas.
4. Prueba selección, autorización, bloqueo, persistencia, reinicio, revocación y recuperación de errores en iPhone físico.
5. Distribuye mediante TestFlight o App Store. No ofrezcas IPA como descarga directa universal.
6. Enlaza la invitación/ficha auténtica y pruébala desde otro iPhone.
7. Explica los límites reales de iOS y que no se puede superponer una máscara sobre cualquier aplicación.

Si hace falta Apple Developer Program, aprobación de entitlement, certificado, perfil o intervención del titular, prepara todo lo demás e identifica exactamente el bloqueo. No simules una publicación.

## 8. Guías para usuarios sin conocimientos técnicos

Crear una guía independiente para Android y otra para iPhone. No deben requerir terminal, Git, Xcode ni conocimientos informáticos.

Cada guía explica:
- Qué se necesita antes de empezar.
- Cómo reconocer el enlace oficial.
- Pasos numerados, una acción por paso.
- Qué botón tocar y dónde aparece.
- Qué mensaje puede aparecer y qué significa.
- Qué permiso se solicita y por qué.
- Cómo terminar la instalación y abrir Shomer.
- Cómo activar, pausar y detener la protección.
- Cómo comprobar que funciona.
- Cómo retirar permisos y desinstalar.
- Solución de errores: enlace que no abre, descarga bloqueada, archivo que no aparece, instalación denegada, TestFlight no disponible, permiso rechazado o dispositivo incompatible.
- Preguntas frecuentes en español sencillo.

Usa capturas auténticas del sistema y versiones probadas. Nunca inventes pantallas del sistema. Añade texto alternativo y una explicación escrita para cada imagen.

## 9. Calidad, pruebas y privacidad

Detecta el gestor real y usa el lockfile. Ejecuta lint, tests, build de producción web, pruebas de rutas y enlaces, responsive y accesibilidad. Prueba las apps en dispositivos físicos cuando estén disponibles. No desactives tests para conseguir un build exitoso. No filtres secretos. No rompas páginas, proyectos ni despliegues independientes de Vercel.

## 10. Publicación y entrega

- Despliega la página en el proyecto/dominio Vercel correcto, sin alterar proyectos no relacionados.
- Verifica la URL de producción después del despliegue.
- Crea commits y Pull Requests por área.
- Actualiza README con comandos técnicos reproducibles.
- Mantén las guías de usuario separadas de la documentación de desarrolladores.
- Adjunta capturas reales, resultados de pruebas, versiones, hashes y enlaces de los artefactos.

## 11. Criterios de aceptación — no declarar terminado antes de cumplirlos

- [ ] Página de Seguridad rediseñada, premium, azul suave/translúcida y responsive.
- [ ] Textos naturales, claros y precisos.
- [ ] Detección de dispositivo/navegador con corrección manual.
- [ ] Instrucciones dinámicas según dispositivo, sistema y navegador.
- [ ] Captura auténtica del bloqueo o mockup claramente identificado como conceptual.
- [ ] APK real, firmado, descargable e instalado con éxito en Android físico.
- [ ] Distribución iOS real probada en iPhone, o bloqueo externo documentado honestamente.
- [ ] Guías simples para instalar y activar Shomer sin conocimientos técnicos.
- [ ] Enlaces probados desde teléfonos reales.
- [ ] Build web y pruebas aplicables correctos.
- [ ] Cambios guardados en commits y PRs revisables.
- [ ] Ningún proyecto o despliegue existente dañado.

## 12. Informe final obligatorio

Entrega un informe verificable con:
1. Archivos y páginas modificados.
2. Cambios visuales realizados.
3. URL de producción y estado del despliegue.
4. URL del APK, versión, tamaño y SHA-256.
5. URL de TestFlight/App Store o requisito externo pendiente.
6. Dispositivos y sistemas probados.
7. Pruebas ejecutadas y resultados.
8. Commits y Pull Requests.
9. Bloqueos reales y acción exacta que requiere el propietario.

**Empieza ahora: inspecciona, implementa, compila, prueba y publica lo que sea posible. No te limites a planear ni a escribir comentarios. No marques como terminado nada que no hayas verificado.**
