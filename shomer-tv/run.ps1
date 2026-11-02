# run.ps1 — Versión para Windows de run.sh.
# Arranque rápido: servidor web + un canal en vivo que espera la señal de OBS.
#   run.bat                 → canal "canal-1" en rtmp://<servidor>:1935/live/canal-1
#   run.bat final           → canal "final"
param([string]$Name = 'canal-1')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Py = if ($env:PYTHON) { $env:PYTHON } else { Join-Path $env:LOCALAPPDATA 'shomer-sport-venv\Scripts\python.exe' }
if (-not (Test-Path $Py)) { throw "No existe $Py. Ejecuta primero instalar.bat" }
$Port = if ($env:PORT) { $env:PORT } else { '8080' }

$ip = '<IP-de-este-servidor>'
try {
  $found = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1
  if ($found) { $ip = $found.IPAddress }
} catch { }

$server = Start-Process -FilePath $Py -ArgumentList '-m', 'shomer_tv', 'serve', '--port', $Port `
  -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
try {
  Write-Host "Web:      http://localhost:$Port"
  Write-Host "Clientes: http://localhost:$Port/admin     (activar / renovar suscripciones)"
  Write-Host "Anuncios: http://localhost:$Port/control   (pausa comercial: tapar / volver al partido)"
  Write-Host "Señal:    rtmp://${ip}:1935/live/$Name   (en OBS: Servidor = rtmp://${ip}:1935/live, Clave = $Name)"
  & $Py -m shomer_tv channel --name $Name --input "rtmp://0.0.0.0:1935/live/$Name" --listen --retry
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
