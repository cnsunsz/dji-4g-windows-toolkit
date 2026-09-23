<#
.SYNOPSIS
  Optional local Windows PyInstaller build (onefile GUI).
.NOTES
  Primary release path is GitHub Actions (.github/workflows/release.yml).
  Use this script only as a fallback on a Windows PC with Python 3.11+.
#>
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

Write-Host "Project root: $Root"
python -m pip install -U pip
python -m pip install -r requirements.txt
python -m pip install pyinstaller

$dist = Join-Path $Root "dist"
$work = Join-Path $Root "build"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# Bundle drivers + Install-Drivers.ps1 into the onefile archive (_MEIPASS).
python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --windowed `
  --name "DJI-4G-Windows-Toolkit" `
  --paths "." `
  --add-data "drivers/windows10;drivers/windows10" `
  --add-data "scripts/Install-Drivers.ps1;scripts" `
  --hidden-import "app" `
  --hidden-import "app.device" `
  --hidden-import "app.driver_install" `
  --hidden-import "app.sms_server" `
  --hidden-import "serial" `
  --hidden-import "serial.tools.list_ports" `
  --hidden-import "flask" `
  --collect-all flask `
  "app/main.py"

$exe = Join-Path $dist "DJI-4G-Windows-Toolkit.exe"
if (-not (Test-Path $exe)) { throw "EXE not produced: $exe" }
Get-FileHash -Algorithm SHA256 $exe | Format-List
Write-Host "OK: $exe"
