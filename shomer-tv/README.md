# Shomer TV — plataforma de partidos filtrados

Recibe la señal de un partido, tapa la piel de las mujeres en el servidor (mismo
motor que la extensión `shomer-sport`) y la transmite a tus clientes por una
página web. El cliente no instala nada: funciona en PC, celular y Smart TV con
navegador.

```
 OBS / codificador / archivo                       clientes
          │ RTMP · SRT · HLS                           ▲
          ▼                                            │ HLS
   shomer_tv channel ──► YOLO + género + piel ──► hls/<canal>/ ──► shomer_tv serve (web)
```

> **Derechos:** solo transmite contenido que tengas derecho a retransmitir (ligas
> o clubes que te den licencia, tus propias grabaciones, etc.). Tomar la señal de
> DAZN, de la TV u otro servicio y retransmitirla sin licencia es piratería.

## Instalación

```bash
python3 -m venv venv && venv/bin/pip install -r requirements.txt
# Los modelos se toman de ../shomer-sport/models (yolov8n-seg.onnx, gender.onnx).
```

## Uso

```bash
# 1) Servidor web para los clientes (http://IP:8080)
python -m shomer_tv serve --port 8080 --admin-key CLAVE-OPERADOR   # añade --accounts para pedir cuenta

# 2a) Canal en vivo: espera la señal de OBS
python -m shomer_tv channel --name canal-1 --input rtmp://0.0.0.0:1935/live/canal-1 --listen --retry
#     En OBS → Ajustes → Emisión: Servidor rtmp://IP:1935/live · Clave canal-1

# 2b) Canal desde una señal HLS/SRT que te entregue quien tiene los derechos
python -m shomer_tv channel --name liga --input "https://proveedor/…/playlist.m3u8" --retry

# 2c) Partido grabado para ver bajo demanda
python -m shomer_tv channel --name final-2026 --input partido.mp4 --vod
```

O todo junto: `./run.sh canal-1`.

### Opciones del filtro

| Opción | Por defecto | Qué hace |
|---|---|---|
| `--level normal\|strict` | normal | `strict` tapa a la persona completa, no solo la piel |
| `--cover blur\|solid` | blur | desenfoque o bloque de color |
| `--female-threshold` | 0.35 | más bajo = más estricto (tapa también a algunos hombres) |
| `--min-person-frac` | 0.07 | personas más pequeñas que esta fracción de la altura no se tapan; `0` = todas |
| `--dilate` | 6 | margen extra alrededor de lo tapado |
| `--height` | 720 | resolución de salida |
| `--analysis-fps` | 5 | análisis por segundo como máximo |
| `--max-gap` | 1.0 | en vivo, segundos máximos entre dos análisis |

## Clientes y suscripciones

**Por defecto no se pide cuenta: cualquiera ve los canales.** Si arrancas `serve --accounts`, cada cliente necesita una cuenta con la suscripción activa.

1. El cliente entra a `http://IP:8080`, pulsa **Crear cuenta** (correo y contraseña) y ve
   el aviso "Tu suscripción no está activa".
2. Te paga como prefieras (transferencia, OXXO, enlace de pago de Mercado Pago o Stripe…)
   y te manda su correo.
3. Abres **`http://IP:8080/admin?admin=CLAVE-OPERADOR`**, lo buscas y pulsas **+30 días**
   o **+365**. Puedes anotar la referencia del pago. El cliente recarga y ya ve los partidos.

- Si la suscripción sigue activa, los días se suman al final. Al vencer, el video se corta solo.
- **Cancelar** corta el acceso al momento; **Borrar** elimina la cuenta.
- Cada cuenta puede tener como máximo **2 sesiones** abiertas: al entrar en un tercer
  dispositivo se cierra la más antigua (para que no compartan la cuenta).
- Seguridad: contraseñas con scrypt, sesión en cookie HttpOnly, máximo 10 intentos de
  contraseña fallidos por IP cada 10 minutos.
- Desde la terminal: `python -m shomer_tv users list`, `users extend correo 30`,
  `users extend correo 0` (cancelar), `users delete correo`.
- Las cuentas se guardan en `data/accounts.db` (SQLite). **Haz copia de seguridad** de ese archivo.
- Sin `--accounts` no se pide cuenta. La clave de acceso antigua
  (`--access-key`) sigue sirviendo como pase general.

> Detrás de nginx/HTTPS, define siempre `--admin-key`: sin ella las páginas del operador
> solo aceptan conexiones directas desde el propio servidor, no a través del proxy.
> Pon también `proxy_set_header X-Real-IP $remote_addr;` para que el límite de intentos
> y de cuentas nuevas cuente por cliente y no por el proxy.

## Anuncios (pausas comerciales)

Durante una pausa comercial el canal deja de mostrar la señal: los clientes ven una
pantalla fija de "Pausa comercial" y el audio va en silencio. El filtro de personas
vuelve a funcionar en cuanto termina la pausa.

- **Página del operador:** `http://IP:8080/control?admin=CLAVE` (la clave se fija con
  `serve --admin-key CLAVE` o `SHOMER_ADMIN_KEY`; sin clave solo se abre desde el propio
  servidor). Botones **Tapar anuncio**, **2 min**/**3 min** (se quita sola) y
  **Volver al partido**. Atajos de teclado: `A` tapa, `P` vuelve al partido.
- **Línea de comandos:** `python -m shomer_tv ad canal-1 on [--minutes 3]` / `... ad canal-1 off`
- **API:** `POST /api/ad?admin=CLAVE` con `{"channel": "canal-1", "on": true, "minutes": 3}`

Los cuadros que el canal tenía retenidos (hasta ~1 s) también se tapan al activar la
pausa, para cubrir la reacción del operador. Los anuncios que aparecen *dentro* del
partido (vallas del estadio, sobreimpresiones) no se quitan; si sale una mujer en ellos,
el filtro de personas la tapa como a cualquier otra.

## Cómo garantiza que nada se escape

- Se analizan algunos cuadros por segundo. Los intermedios se **retienen** hasta el
  siguiente análisis y se tapan con la **unión** de la máscara anterior y la
  siguiente: una jugadora que se mueve queda cubierta en todo el trayecto.
- Si el análisis falla, el cuadro sale **completamente tapado**.
- En vivo, si el servidor no da abasto, primero analiza menos seguido y luego
  baja los cuadros por segundo de salida; nunca deja salir un cuadro sin filtrar.
  `hls/<canal>/status.json` muestra el atraso (`lag_sec`), la velocidad y la
  última detección.

## Rendimiento

| Equipo | Análisis | Resultado |
|---|---|---|
| CPU de 4 núcleos (probado) | ~250–500 ms | 480p a 30 fps en tiempo real, ~2 análisis/s |
| GPU NVIDIA (p. ej. T4/L4) con `onnxruntime-gpu` | ~15–30 ms estimado | 720p/1080p, 5+ análisis/s, varios canales |

Para un servicio real usa un servidor con GPU (AWS g4dn/g6, Hetzner GPU, etc.) y
pon nginx o una CDN delante de `hls/` para atender a muchos clientes.

## Pendiente para lanzar como negocio

- Cuentas de cliente y cobro de suscripción (la `--access-key` es solo un candado de pruebas).
- HTTPS (nginx + Let's Encrypt) y CDN.
- Mejor modelo de género para planos abiertos (ver `shomer-sport/scripts/train_gender_classifier.py`).
- Revisión humana opcional: un operador puede vigilar el canal y forzar `strict` en vivo.
