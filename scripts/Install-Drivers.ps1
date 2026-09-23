#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install Quectel drivers for DJI 4G (QDC507).
.DESCRIPTION
  Default: qcser / qcmdm / qcfilter (serial AT/DM/filter).
  -IncludeWwan : also install qcwwan.inf (NDIS WWAN / internet).
  -WwanOnly    : install only qcwwan.inf (skip serial trio).
.NOTES
  qcwwan may replace an existing Baiwang/DJI WWAN stack — use only when needed.
  Exit 0 on success. Log: %TEMP%\dji-4g-toolkit-driver-install.log
#>
param(
    [string]$DriverDir = "",
    [switch]$IncludeWwan,
    [switch]$WwanOnly
)

$ErrorActionPreference = "Continue"
$Log = Join-Path $env:TEMP "dji-4g-toolkit-driver-install.log"

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
    Write-Output $line
}

Write-Log "=== DJI 4G Toolkit driver install start ==="
Write-Log ("IncludeWwan={0} WwanOnly={1}" -f [bool]$IncludeWwan, [bool]$WwanOnly)

if (-not $DriverDir) {
    $here = $PSScriptRoot
    $candidates = @(
        (Join-Path $here "windows10"),
        (Join-Path (Split-Path $here -Parent) "drivers\windows10"),
        (Join-Path $here "..\drivers\windows10")
    )
    foreach ($c in $candidates) {
        $full = [System.IO.Path]::GetFullPath($c)
        if (Test-Path -LiteralPath $full) {
            $DriverDir = $full
            break
        }
    }
}

Write-Log "DriverDir=$DriverDir"
if (-not $DriverDir -or -not (Test-Path -LiteralPath $DriverDir)) {
    Write-Log "ERROR: windows10 driver directory not found"
    exit 1
}

if ($WwanOnly) {
    $infs = @("qcwwan.inf")
} elseif ($IncludeWwan) {
    $infs = @("qcser.inf", "qcmdm.inf", "qcfilter.inf", "qcwwan.inf")
} else {
    # AT / DM / filter only — do not install qcwwan unless explicitly requested.
    $infs = @("qcser.inf", "qcmdm.inf", "qcfilter.inf")
}

$failed = 0

foreach ($inf in $infs) {
    $path = Join-Path $DriverDir $inf
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Log "MISSING $path"
        $failed++
        continue
    }
    Write-Log "INSTALL $path"
    & pnputil.exe /add-driver $path /install
    $code = $LASTEXITCODE
    Write-Log "pnputil exit=$code"
    # pnputil may return non-zero for "already installed" on some builds; treat hard failures only.
    if ($null -ne $code -and $code -ne 0 -and $code -ne 259 -and $code -ne 3010) {
        # 259 = ERROR_NO_MORE_ITEMS sometimes; 3010 = reboot required
        if ($code -gt 1) { $failed++ }
    }
}

Write-Log "pnputil /scan-devices"
& pnputil.exe /scan-devices
Write-Log "scan exit=$LASTEXITCODE"
Start-Sleep -Seconds 2

Write-Log "=== Present VID_2CA3/PID_4006 devices ==="
Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like '*VID_2CA3*PID_4006*' -or $_.InstanceId -like '*VID_2C7C*PID_0125*' } |
    ForEach-Object { Write-Log ("DEVICE $($_.Status) | $($_.Class) | $($_.FriendlyName)") }

Write-Log "=== Ports ==="
Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Log ("PORT $($_.Status) | $($_.FriendlyName)") }

if ($failed -gt 0) {
    Write-Log "DONE with failures=$failed"
    exit 1
}
Write-Log "DONE ok"
exit 0
