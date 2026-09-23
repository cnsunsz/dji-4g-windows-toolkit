"""Locate bundled Quectel drivers and launch elevated Install-Drivers.ps1."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


INSTALL_INFS = ("qcser.inf", "qcmdm.inf", "qcfilter.inf")
TEMP_DIR_NAME = "dji-4g-toolkit-drivers"


def project_root() -> Path:
    """Repo root when running from source; next-to-exe or _MEIPASS when frozen."""
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidate = Path(meipass)
            if (candidate / "drivers" / "windows10").is_dir():
                return candidate
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def drivers_windows10_dir() -> Path:
    return project_root() / "drivers" / "windows10"


def install_script_path() -> Path:
    return project_root() / "scripts" / "Install-Drivers.ps1"


def prepare_driver_tree() -> Path:
    """
    Ensure a writable copy of drivers/windows10 exists.
    When frozen, extract/copy from _MEIPASS into %TEMP%\\dji-4g-toolkit-drivers.
    """
    src = drivers_windows10_dir()
    if not src.is_dir():
        raise FileNotFoundError(f"Bundled drivers not found: {src}")

    for inf in INSTALL_INFS:
        if not (src / inf).is_file():
            raise FileNotFoundError(f"Missing required INF: {src / inf}")

    if not getattr(sys, "frozen", False):
        # Source tree is already on disk; install script can use it directly.
        return src

    dest = Path(tempfile.gettempdir()) / TEMP_DIR_NAME / "windows10"
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest)
    return dest


def copy_install_script(driver_parent: Path) -> Path:
    """
    Place Install-Drivers.ps1 next to the extracted windows10 folder so the
    elevated PowerShell process has a stable path (needed when frozen).
    """
    src_script = install_script_path()
    if not src_script.is_file():
        # Embedded fallback: write a minimal script beside drivers.
        dest = driver_parent.parent / "Install-Drivers.ps1"
        dest.write_text(_EMBEDDED_INSTALL_PS1, encoding="utf-8")
        return dest

    if getattr(sys, "frozen", False):
        dest = driver_parent.parent / "Install-Drivers.ps1"
        shutil.copy2(src_script, dest)
        return dest
    return src_script


_EMBEDDED_INSTALL_PS1 = r"""# Fallback Install-Drivers.ps1 (embedded)
param(
  [string]$DriverDir = ""
)
$ErrorActionPreference = "Continue"
$Log = Join-Path $env:TEMP "dji-4g-toolkit-driver-install.log"
function Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m
  Add-Content -Path $Log -Value $line
  Write-Output $line
}
if (-not $DriverDir) {
  $DriverDir = Join-Path $PSScriptRoot "windows10"
  if (-not (Test-Path $DriverDir)) {
    $DriverDir = Join-Path (Split-Path $PSScriptRoot -Parent) "drivers\windows10"
  }
}
Log "DriverDir=$DriverDir"
if (-not (Test-Path $DriverDir)) { Log "ERROR: driver dir missing"; exit 1 }
$infs = @("qcser.inf","qcmdm.inf","qcfilter.inf")
$failed = 0
foreach ($inf in $infs) {
  $p = Join-Path $DriverDir $inf
  if (-not (Test-Path $p)) { Log "MISSING $p"; $failed++; continue }
  Log "INSTALL $p"
  & pnputil /add-driver $p /install
  Log ("pnputil exit=" + $LASTEXITCODE)
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { $failed++ }
}
Log "SCAN devices"
& pnputil /scan-devices
Log ("scan exit=" + $LASTEXITCODE)
Start-Sleep -Seconds 2
Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {
  Log ("PORT $($_.Status) | $($_.FriendlyName)")
}
if ($failed -gt 0) { Log "DONE with failures=$failed"; exit 1 }
Log "DONE ok"; exit 0
"""


def launch_elevated_install(log_callback=None) -> tuple[bool, str]:
    """
    Start Install-Drivers.ps1 with UAC elevation (Start-Process -Verb RunAs).
    Returns (ok_started, message). The elevated process runs asynchronously from
    the caller's perspective after UAC consent.
    """
    if sys.platform != "win32":
        return False, "Driver install is Windows-only."

    try:
        driver_dir = prepare_driver_tree()
        script = copy_install_script(driver_dir)
    except FileNotFoundError as exc:
        return False, str(exc)

    log_path = Path(os.environ.get("TEMP", tempfile.gettempdir())) / "dji-4g-toolkit-driver-install.log"
    if log_callback:
        log_callback(f"Drivers: {driver_dir}")
        log_callback(f"Script: {script}")
        log_callback(f"Log file: {log_path}")

    # -Verb RunAs prompts UAC; Wait ensures we know if user cancelled.
    ps = (
        f"$p = Start-Process -FilePath 'powershell.exe' "
        f"-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"
        f"'{script}','-DriverDir','{driver_dir}') "
        f"-Verb RunAs -Wait -PassThru; "
        f"exit $p.ExitCode"
    )
    try:
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                ps,
            ],
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, "Driver install timed out (UAC or pnputil)."
    except OSError as exc:
        return False, f"Failed to start elevated installer: {exc}"

    code = completed.returncode
    detail = (completed.stdout or "") + (completed.stderr or "")
    if code == 0:
        return True, f"Driver install finished OK (exit 0). See {log_path}\n{detail}".strip()
    if code in (1223, 5):  # cancelled / access denied
        return False, f"UAC cancelled or access denied (exit {code})."
    return False, f"Driver install exited {code}. See {log_path}\n{detail}".strip()
