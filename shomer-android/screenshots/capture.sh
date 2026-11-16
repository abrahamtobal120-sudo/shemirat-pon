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
demo() {
  adb shell am broadcast -a com.android.systemui.demo -e command enter >/dev/null
  adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941 >/dev/null
  adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null
  adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e mobile show -e datatype none -e level 4 >/dev/null
  adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null
}
app() {  # back to Shomer without restarting it (that would stop the filter)
  for i in 1 2 3 4 5; do
    adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | grep -q "$PKG/.MainActivity" && break
    adb shell input keyevent KEYCODE_BACK; sleep 1.5
  done
  adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | grep -q "$PKG/.MainActivity" || adb shell am start -n $PKG/.MainActivity >/dev/null
  sleep 1.5
}
top() { adb shell 'input swipe 540 600 540 2000 200; input swipe 540 600 540 2000 200'; }

adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
# Wait until shared storage is mounted (adb push to Download fails right after boot).
for i in $(seq 1 30); do adb shell touch /sdcard/Download/.ok 2>/dev/null && break; sleep 3; done
# Spanish UI: set the locale as root and restart the framework, then wait for it again.
adb root >/dev/null; sleep 3; adb wait-for-device
adb shell setprop persist.sys.locale es-MX
adb shell setprop ctl.restart zygote
sleep 10; adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && adb shell pm path android >/dev/null 2>&1; do sleep 2; done
sleep 15
for i in $(seq 1 30); do adb shell touch /sdcard/Download/.ok 2>/dev/null && break; sleep 3; done
adb shell settings put global sysui_demo_allowed 1
sleep 15; demo
adb shell settings put secure show_ime_with_hard_keyboard 0
adb shell input keyevent KEYCODE_WAKEUP; adb shell wm dismiss-keyguard

# Instalación como lo hace una persona: descargar el APK con Chrome y abrirlo.
URL=${APK_URL:-https://github.com/abrahamtobal120-sudo/shemirat-pon/releases/download/android-v1.0.0/shomer-android-1.0.0.apk}
CHROME=com.android.chrome
adb shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run --disable-signin-promo" > /data/local/tmp/chrome-command-line'
adb shell am set-debug-app --persistent $CHROME
adb shell pm grant $CHROME android.permission.POST_NOTIFICATIONS 2>/dev/null || true
chrome() { adb shell am start -a android.intent.action.VIEW -d "$1" -p $CHROME >/dev/null; sleep 5
  for i in 1 2 3; do ui tap '^(Usar sin una cuenta|Continuar sin cuenta|No, gracias|Aceptar y continuar|Entendido|Aceptar)$' 0 >/dev/null || break; sleep 2; done; }
chrome "$URL"
ui tap '(Descargar de todos modos|Descargar de todas formas|^Descargar$)' 0 && shot c1-descargar 2
for i in $(seq 1 60); do  # wait for the 112 MB download
  size=$(adb shell stat -c %s /sdcard/Download/shomer-android-1.0.0.apk 2>/dev/null | tr -d '
')
  [ "${size:-0}" -gt 110000000 ] && break; sleep 3
done
shot c2-descargado 3
ui tap '^Abrir$' 0 && shot c3-fuentes-desconocidas 4
ui tap '^(Configuración|Ajustes)$' 0 && shot c4-permitir-fuente 3
ui tap '(Permitir de esta fuente|Confiar en esta fuente)' 0 && shot c4-permitir-fuente 2
adb shell input keyevent KEYCODE_BACK; shot c5-instalar 4
ui tap '^Instalar$' 0 && sleep 15 && shot c6-instalada 2
# Make sure the APK under test is the one installed (same signing key, so this is an update).
adb install -r "$APK"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb shell am start -W -n $PKG/.MainActivity
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
demo; shot 01-inicio 4

# Filtro de sitios: permiso de VPN, filtro activo
ui tap '^Activar filtro$' && shot 02-permiso-vpn 3
ui tap '^(Aceptar|OK|Permitir)$' && shot 03-filtro-activo 4
# Hold the filter for a bit so the query counters move, then capture again.
chrome https://es.wikipedia.org/wiki/Shomer; sleep 3
app; top; shot 03-filtro-activo 3

# Hacerlo permanente. Check what each switch does to the connection with Chrome.
chrome https://es.wikipedia.org/wiki/Moda; sleep 6; shot v1-chrome-filtro-sin-bloqueo 1
app; top
ui tap 'Hacerlo permanente' && shot 04-ajustes-vpn 3
ui tap '(Configuración|Ajustes|Settings)' 0
ui tap 'VPN siempre activ' 0 && sleep 2 && shot 05-vpn-siempre-activa 2
chrome https://es.wikipedia.org/wiki/Alta_costura; sleep 6; shot v2-chrome-siempre-activa 1
adb shell am start -a android.settings.VPN_SETTINGS >/dev/null; sleep 2
ui tap '(Configuración|Ajustes|Settings)' 0
ui tap 'Bloquear conexiones' 0 && sleep 1 && { ui tap '^(Activar|Aceptar|OK)$' 0 || true; } && shot 05b-vpn-bloquear 2
chrome https://es.wikipedia.org/wiki/Vestido; sleep 8; shot v3-chrome-con-bloqueo 1
# Turn lockdown off again so the rest (and the image filter demo) has internet.
adb shell am start -a android.settings.VPN_SETTINGS >/dev/null; sleep 2
ui tap '(Configuración|Ajustes|Settings)' 0
ui tap 'Bloquear conexiones' 0 && sleep 1 && shot 05c-vpn-sin-bloquear 1
for i in 1 2 3; do adb shell input keyevent KEYCODE_BACK; sleep 1; done
app

# Filtro de imágenes: permiso de superposición y de compartir pantalla
ui tap 'Mostrar sobre otras apps' && shot 06-mostrar-sobre-apps 3
ui tap 'Shomer' 0 >/dev/null 2>&1; ui tap '(Permitir|Allow)' 0 && shot 06-mostrar-sobre-apps 2
app
ui tap 'Activar filtro de imágenes' && shot 07-compartir-pantalla 3
ui tap '^(Iniciar|Empezar|Start|Comenzar|Compartir|Share screen)' 0 && shot 08-imagenes-activo 5
app; top; shot 09-app-ambos-filtros 3

# El filtro de imágenes funcionando sobre otra app (Chrome con un artículo con fotos de personas).
chrome https://es.wikipedia.org/wiki/Moda; sleep 4
adb shell input swipe 540 1600 540 900 600; sleep 12
shot 10-imagen-tapada 1
adb shell input swipe 540 1600 540 1000 600; sleep 12
shot 11-imagen-tapada 1
ls -la "$OUT"
