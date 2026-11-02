# setup.ps1 — Versión para Windows de setup.sh. Prepara la extensión para cargarla en Chrome/Edge:
#   1) Descarga ONNX Runtime Web (JS + WASM) a lib\
#   2) Exporta YOLOv8n-seg a ONNX (models\yolov8n-seg.onnx)
#   3) Crea models\gender.onnx con CLIP zero-shot (sin dataset)
#   4) Genera los iconos
# Requisitos: Python 3.9+ (python.org, con "py launcher") y Node.js (para npm).
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1           (todo)
#       powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 ort       (solo ONNX Runtime)
#       ... yolo | gender | icons
param([ValidateSet('all', 'ort', 'yolo', 'gender', 'icons')][string]$What = 'all')
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$OrtVersion = if ($env:ORT_VERSION) { $env:ORT_VERSION } else { '1.31.1' }
$YoloModel = if ($env:YOLO_MODEL) { $env:YOLO_MODEL } else { 'yolov8n-seg' }   # también sirve yolo11n-seg
$YoloSize = if ($env:YOLO_SIZE) { $env:YOLO_SIZE } else { '384' }              # 320 = más rápido, 640 = más preciso
# Fuera de la extensión (Chrome cargaría todo el directorio)
$Venv = if ($env:VENV) { $env:VENV } else { Join-Path $env:LOCALAPPDATA 'shomer-sport-venv' }
$VenvPy = Join-Path $Venv 'Scripts\python.exe'

# Detiene el script si el último programa externo falló.
function Assert-Ok { if ($LASTEXITCODE -ne 0) { throw "El último comando falló (código $LASTEXITCODE)" } }

function New-Venv {
  if (Test-Path $VenvPy) { return }
  if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv $Venv }
  elseif (Get-Command python -ErrorAction SilentlyContinue) { & python -m venv $Venv }
  else { throw 'No se encontró Python 3. Instálalo desde https://www.python.org/downloads/ (marca "Add python.exe to PATH").' }
  Assert-Ok
}

function Ensure-Venv {
  New-Venv
  & $VenvPy -m pip install --quiet --upgrade pip; Assert-Ok
  # CPU basta para exportar; evita descargar CUDA.
  & $VenvPy -m pip install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cpu; Assert-Ok
}

function Step-Ort {
  Write-Host "==> Descargando onnxruntime-web@$OrtVersion"
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'No se encontró npm. Instala Node.js desde https://nodejs.org/' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Push-Location $tmp
    try {
      & npm pack "onnxruntime-web@$OrtVersion" --silent | Out-Null; Assert-Ok
      $tgz = (Get-ChildItem -Filter 'onnxruntime-web-*.tgz' | Select-Object -First 1).FullName
      & tar xzf $tgz; Assert-Ok
    } finally { Pop-Location }
    $lib = Join-Path $Root 'lib'
    New-Item -ItemType Directory -Force -Path $lib | Out-Null
    $dist = Join-Path $tmp 'package\dist'
    Copy-Item (Join-Path $dist 'ort.all.min.js') $lib -Force
    # Binarios WASM y sus cargadores .mjs (WebGPU/JSEP, WASM simple, asyncify…)
    Copy-Item (Join-Path $dist 'ort-wasm-simd-threaded*.wasm') $lib -Force
    Copy-Item (Join-Path $dist 'ort-wasm-simd-threaded*.mjs') $lib -Force
    $license = Join-Path $tmp 'package\LICENSE'
    if (Test-Path $license) { Copy-Item $license (Join-Path $lib 'LICENSE-onnxruntime.txt') -Force }
    Get-ChildItem $lib | Format-Table Name, Length
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Step-Yolo {
  Write-Host "==> Exportando $YoloModel a ONNX (imgsz=$YoloSize)"
  Ensure-Venv
  & $VenvPy -m pip install --quiet ultralytics onnx onnxslim; Assert-Ok
  & $VenvPy -I (Join-Path $Root 'scripts\export_yolo.py') $YoloModel $YoloSize (Join-Path $Root 'models'); Assert-Ok
}

function Step-Gender {
  Write-Host '==> Creando gender.onnx (CLIP zero-shot)'
  Ensure-Venv
  & $VenvPy -m pip install --quiet open_clip_torch timm onnx; Assert-Ok
  & $VenvPy -I (Join-Path $Root 'scripts\export_gender_clip.py') (Join-Path $Root 'models'); Assert-Ok
}

function Step-Icons {
  # Pillow se instala en el entorno virtual para no tocar el Python del sistema.
  New-Venv
  & $VenvPy -m pip install --quiet Pillow; Assert-Ok
  & $VenvPy -I (Join-Path $Root 'scripts\make_icons.py') (Join-Path $Root 'icons'); Assert-Ok
}

switch ($What) {
  'ort' { Step-Ort }
  'yolo' { Step-Yolo }
  'gender' { Step-Gender }
  'icons' { Step-Icons }
  'all' { Step-Ort; Step-Yolo; Step-Gender; Step-Icons }
}
Write-Host '==> Listo.'
