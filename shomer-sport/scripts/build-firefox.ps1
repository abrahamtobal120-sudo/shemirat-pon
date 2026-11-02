# build-firefox.ps1 — Versión para Windows de build-firefox.sh.
# Genera dist\<extensión>-firefox.xpi a partir de la extensión de Chrome.
# Único cambio: Firefox usa background.scripts en lugar de service_worker
# y necesita un ID de extensión (browser_specific_settings.gecko.id).
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Name = Split-Path -Leaf $Root          # shomer-sport | shomer-web
$Out = Join-Path $Root 'dist\firefox'
$Xpi = Join-Path $Root "dist\$Name-firefox.xpi"

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
if (Test-Path $Xpi) { Remove-Item -Force $Xpi }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
foreach ($item in 'background.js', 'common', 'content', 'engine', 'icons', 'lib', '_locales', 'models', 'popup', 'rules') {
  Copy-Item -Recurse -Force (Join-Path $Root $item) $Out
}

$m = Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'manifest.json') | ConvertFrom-Json
$m.PSObject.Properties.Remove('minimum_chrome_version')
$m.background = [ordered]@{ scripts = @('common/i18n.js', 'common/settings.js', 'background.js') }
$gecko = [ordered]@{
  id                          = "$Name@local"
  strict_min_version          = '128.0'
  data_collection_permissions = [ordered]@{ required = @('none') }
}
$m | Add-Member -Force -NotePropertyName browser_specific_settings -NotePropertyValue ([ordered]@{ gecko = $gecko })
# UTF-8 sin BOM: Firefox rechaza manifest.json con BOM.
[IO.File]::WriteAllText((Join-Path $Out 'manifest.json'), (ConvertTo-Json -InputObject $m -Depth 100), (New-Object Text.UTF8Encoding $false))

# Compress-Archive de PowerShell 5 guarda las rutas con "\" y Firefox no las acepta: se arma el zip a mano con "/".
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($Xpi, 'Create')
try {
  Get-ChildItem -LiteralPath $Out -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Out.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $zip.Dispose() }
Write-Host "Listo: $Xpi"
