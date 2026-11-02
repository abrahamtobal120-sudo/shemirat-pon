# instalar.ps1 — Prepara Shomer TV en Windows: crea el entorno de Python e instala las dependencias.
# El entorno es el mismo que usan los scripts de shomer-sport (%LOCALAPPDATA%\shomer-sport-venv).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Venv = if ($env:VENV) { $env:VENV } else { Join-Path $env:LOCALAPPDATA 'shomer-sport-venv' }
$VenvPy = Join-Path $Venv 'Scripts\python.exe'

function Assert-Ok { if ($LASTEXITCODE -ne 0) { throw "El último comando falló (código $LASTEXITCODE)" } }

if (-not (Test-Path $VenvPy)) {
  Write-Host "==> Creando entorno de Python en $Venv"
  if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv $Venv }
  elseif (Get-Command python -ErrorAction SilentlyContinue) { & python -m venv $Venv }
  else { throw 'No se encontró Python 3. Instálalo desde https://www.python.org/downloads/ (marca "Add python.exe to PATH").' }
  Assert-Ok
}
Write-Host '==> Instalando dependencias'
& $VenvPy -m pip install --quiet --upgrade pip; Assert-Ok
& $VenvPy -m pip install --quiet -r requirements.txt; Assert-Ok

foreach ($f in 'models.json', 'yolov8n-seg.onnx', 'gender.onnx') {
  $p = Join-Path $PSScriptRoot "..\shomer-sport\models\$f"
  if (-not (Test-Path $p)) { Write-Warning "Falta ..\shomer-sport\models\$f (ver shomer-sport\scripts\setup.ps1)" }
}
Write-Host '==> Listo. Arranca con run.bat (o: powershell -File run.ps1 <canal>)'
