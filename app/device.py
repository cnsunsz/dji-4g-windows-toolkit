"""Detect DJI Cellular Gen1 / Baiwang QDC507 (USB VID:PID 2CA3:4006) and AT port."""

from __future__ import annotations

import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any

DJI_VID = 0x2CA3
DJI_PID = 0x4006
# Some community guides flash to Quectel identity; still usable for AT SMS.
QUECTEL_VID = 0x2C7C
QUECTEL_PID = 0x0125
SUPPORTED_USB_IDS = frozenset(
    {
        (DJI_VID, DJI_PID),
        (QUECTEL_VID, QUECTEL_PID),
    }
)
AT_PORT_HINT = "Quectel USB AT Port"


@dataclass
class PortInfo:
    device: str
    description: str = ""
    vid: int | None = None
    pid: int | None = None
    hwid: str = ""


@dataclass
class DeviceStatus:
    usb_present: bool = False
    vid_pid: str = ""
    at_port: str | None = None
    ports: list[PortInfo] = field(default_factory=list)
    ati: str | None = None
    error: str | None = None
    notes: list[str] = field(default_factory=list)

    def as_text(self) -> str:
        lines = [
            f"USB present: {self.usb_present}",
            f"VID:PID: {self.vid_pid or '(none)'}",
            f"AT port: {self.at_port or '(not found)'}",
        ]
        if self.ports:
            lines.append("COM / serial ports:")
            for p in self.ports:
                vidpid = ""
                if p.vid is not None and p.pid is not None:
                    vidpid = f" [{p.vid:04X}:{p.pid:04X}]"
                lines.append(f"  - {p.device}: {p.description}{vidpid}")
        if self.ati:
            lines.append("--- ATI ---")
            lines.append(self.ati.strip())
        for note in self.notes:
            lines.append(f"note: {note}")
        if self.error:
            lines.append(f"error: {self.error}")
        return "\n".join(lines)


def _list_serial_ports() -> list[PortInfo]:
    try:
        from serial.tools import list_ports
    except ImportError:
        return []

    result: list[PortInfo] = []
    for port in list_ports.comports():
        result.append(
            PortInfo(
                device=str(getattr(port, "device", "") or ""),
                description=str(getattr(port, "description", "") or ""),
                vid=getattr(port, "vid", None),
                pid=getattr(port, "pid", None),
                hwid=str(getattr(port, "hwid", "") or ""),
            )
        )
    return result


def find_at_port(ports: list[PortInfo] | None = None) -> PortInfo | None:
    """Prefer 'Quectel USB AT Port'; fall back to matching VID/PID serial ports."""
    ports = ports if ports is not None else _list_serial_ports()
    scored: list[tuple[int, PortInfo]] = []
    for port in ports:
        if not port.device:
            continue
        score = 0
        desc = port.description.casefold()
        if AT_PORT_HINT.casefold() in desc:
            score += 50
        if (
            isinstance(port.vid, int)
            and isinstance(port.pid, int)
            and (port.vid, port.pid) in SUPPORTED_USB_IDS
        ):
            score += 100
            if "at" in desc:
                score += 20
        if score > 0:
            scored.append((score, port))
    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def _usb_present_windows() -> tuple[bool, str]:
    """Check PnP for VID_2CA3&PID_4006 (or Quectel 2C7C:0125)."""
    if sys.platform != "win32":
        return False, ""
    ps = r"""
$ids = @('VID_2CA3*PID_4006*', 'VID_2C7C*PID_0125*')
$found = @()
foreach ($pat in $ids) {
  Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like $pat } |
    ForEach-Object { $found += "$($_.Status)|$($_.FriendlyName)|$($_.InstanceId)" }
}
if ($found.Count -eq 0) { Write-Output 'NONE' } else { $found | ForEach-Object { Write-Output $_ } }
"""
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
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"PnP query failed: {exc}"

    out = (completed.stdout or "").strip()
    if not out or out == "NONE":
        return False, ""
    vid_pid = ""
    if "VID_2CA3" in out.upper() and "PID_4006" in out.upper():
        vid_pid = "2CA3:4006"
    elif "VID_2C7C" in out.upper() and "PID_0125" in out.upper():
        vid_pid = "2C7C:0125"
    return True, vid_pid


def probe_ati(port: str, baud: int = 115200, timeout: float = 2.0) -> str:
    """Open AT port briefly and run AT / ATI. Raises on serial errors."""
    import serial

    lines: list[str] = []
    with serial.Serial(
        port=port,
        baudrate=baud,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=0.2,
        write_timeout=2,
    ) as ser:
        time.sleep(0.2)
        ser.reset_input_buffer()
        for cmd in ("AT", "ATI", "AT+GMM", "AT+CGMR"):
            ser.write((cmd + "\r").encode("ascii"))
            ser.flush()
            deadline = time.monotonic() + timeout
            buf = bytearray()
            while time.monotonic() < deadline:
                waiting = ser.in_waiting
                chunk = ser.read(waiting if waiting else 1)
                if chunk:
                    buf.extend(chunk)
                    text = buf.decode("utf-8", errors="replace")
                    if re.search(r"(?:^|\r?\n)(?:OK|ERROR)\r?\n?$", text):
                        break
                else:
                    time.sleep(0.05)
            text = buf.decode("utf-8", errors="replace")
            lines.append(f">>> {cmd}\n{text.strip()}\n")
    return "\n".join(lines)


def detect_status(*, probe: bool = True) -> DeviceStatus:
    status = DeviceStatus()
    if sys.platform == "win32":
        present, vid_pid = _usb_present_windows()
        status.usb_present = present
        status.vid_pid = vid_pid
    else:
        status.notes.append("PnP USB scan is Windows-only; listing serial ports only.")

    ports = _list_serial_ports()
    status.ports = ports
    match = find_at_port(ports)
    if match:
        status.at_port = match.device
        if not status.vid_pid and match.vid is not None and match.pid is not None:
            status.vid_pid = f"{match.vid:04X}:{match.pid:04X}"
            status.usb_present = True
        elif match.vid is not None and match.pid is not None:
            status.usb_present = True

    if probe and status.at_port:
        try:
            status.ati = probe_ati(status.at_port)
        except Exception as exc:  # noqa: BLE001 — surface to UI
            status.error = f"ATI probe failed on {status.at_port}: {exc}"
    elif not status.at_port:
        status.notes.append(
            f"Install Quectel AT/DM/filter drivers, then reconnect. Looking for '{AT_PORT_HINT}'."
        )
    return status


def list_ports_summary() -> list[dict[str, Any]]:
    return [
        {
            "device": p.device,
            "description": p.description,
            "vid": p.vid,
            "pid": p.pid,
        }
        for p in _list_serial_ports()
    ]
