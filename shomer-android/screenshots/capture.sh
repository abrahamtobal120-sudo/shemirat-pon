#!/usr/bin/env bash
# Runs inside the Android emulator job: installs the published APK, walks through the app
# and saves real screenshots to $OUT. Every step is best effort so one missing dialog
# does not lose the rest of the screenshots.
set -u
OUT=${OUT:-shots}
APK=${APK:?ruta del APK}
PKG=dev.shomer.android
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
ui() { python3 "$HERE/ui.py" "$@"; }
shot() { sleep "${2:-2}"; adb exec-out screencap -p > "$OUT/$1.png"; echo "captura $1"; }
top() { adb shell 'input swipe 540 600 540 2000 200; input swipe 540 600 540 2000 200'; }

adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
# Spanish UI, clean status bar (9:41, full battery and signal, no notifications).
adb shell settings put system system_locales es-MX || true
adb shell cmd locale set-system-locales es-MX 2>/dev/null || true
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e mobile show -e datatype none -e level 4
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
adb shell settings put secure show_ime_with_hard_keyboard 0
adb shell input keyevent KEYCODE_WAKEUP; adb shell wm dismiss-keyguard

# Instalación como lo hace una persona: abrir el APK desde Archivos › Descargas.
adb push "$APK" /sdcard/Download/shomer-android-1.0.0.apk
adb shell am start -a android.intent.action.VIEW_DOWNLOADS >/dev/null 2>&1 ||   adb shell am start -n com.google.android.documentsui/com.android.documentsui.files.FilesActivity
shot i1-descargas 4
ui tap 'shomer-android' 2 && shot i2-fuentes-desconocidas 4
ui tap '^(Configuración|Ajustes|Settings)$' 0 && shot i3-permitir-fuente 3
ui tap '(Permitir de esta fuente|Allow from this source)' 0 && shot i3-permitir-fuente 2
adb shell input keyevent KEYCODE_BACK; shot i4-instalar 3
ui tap '^(Instalar|Install)$' 0 && shot i5-instalando 6
adb shell pm list packages | grep -q $PKG || adb install -r "$APK"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb shell am start -W -n $PKG/.MainActivity
shot 01-inicio 4

# Filtro de sitios: permiso de VPN, filtro activo
ui tap '^Activar filtro$' && shot 02-permiso-vpn 3
ui tap '^(Aceptar|OK|Permitir)$' && shot 03-filtro-activo 4
# Hold the filter for a bit so the query counters move, then capture again.
adb shell am start -a android.intent.action.VIEW -d https://example.com >/dev/null 2>&1; sleep 6
adb shell am start -n $PKG/.MainActivity >/dev/null; top; shot 03-filtro-activo 3

# Hacerlo permanente: ajustes de VPN y la pantalla de Shomer con los interruptores
ui tap 'Hacerlo permanente' && shot 04-ajustes-vpn 3
ui tap '(Configuración|Ajustes|Settings)' 0 && shot 05-vpn-siempre-activa 3 || true
ui tap 'VPN siempre activa|Always-on VPN' 0 && sleep 2 && ui tap 'Bloquear conexiones|Block connections' 0 && sleep 1 && \
  { ui tap '^(Activar|Aceptar|OK)$' 0 || true; } && shot 05-vpn-siempre-activa 2
adb shell am start -n $PKG/.MainActivity >/dev/null; sleep 2

# Filtro de imágenes: permiso de superposición y de compartir pantalla
ui tap 'Mostrar sobre otras apps' && shot 06-mostrar-sobre-apps 3
ui tap 'Shomer' 0 >/dev/null 2>&1; ui tap '(Permitir|Allow)' 0 && shot 06-mostrar-sobre-apps 2
adb shell am start -n $PKG/.MainActivity >/dev/null; sleep 2
ui tap 'Activar filtro de imágenes' && shot 07-compartir-pantalla 3
ui tap '^(Iniciar|Empezar|Start|Comenzar|Compartir|Share screen)' 0 && shot 08-imagenes-activo 4
adb shell am start -n $PKG/.MainActivity >/dev/null; top; shot 08-app-ambos-filtros 3
ls -la "$OUT"
