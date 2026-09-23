"""Tkinter GUI entry: drivers / status / SMS for DJI 4G Windows Toolkit."""

from __future__ import annotations

import sys
import threading
import traceback
import webbrowser
from pathlib import Path

# Allow `python -m app.main` and frozen exe.
if __name__ == "__main__" and not getattr(sys, "frozen", False):
    root = Path(__file__).resolve().parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

import tkinter as tk
from tkinter import scrolledtext, ttk

from app import __version__
from app.device import detect_status
from app.driver_install import launch_elevated_install
from app.sms_server import sms_url, start_server_background


class ToolkitApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("DJI 4G Windows Toolkit")
        self.geometry("720x520")
        self.minsize(560, 400)

        hdr = ttk.Frame(self, padding=12)
        hdr.pack(fill=tk.X)
        ttk.Label(
            hdr,
            text=f"DJI 4G Windows Toolkit  v{__version__}",
            font=("Segoe UI", 14, "bold"),
        ).pack(anchor=tk.W)
        ttk.Label(
            hdr,
            text="DJI Cellular Gen1 / Baiwang QDC507 (USB 2CA3:4006) · Quectel AT/SMS",
            foreground="#555",
        ).pack(anchor=tk.W)

        btns = ttk.Frame(self, padding=(12, 0, 12, 8))
        btns.pack(fill=tk.X)
        self.btn_drivers = ttk.Button(btns, text="一键安装驱动", command=self.on_install_drivers)
        self.btn_drivers.pack(side=tk.LEFT, padx=(0, 8))
        self.btn_status = ttk.Button(btns, text="检测模块状态", command=self.on_detect)
        self.btn_status.pack(side=tk.LEFT, padx=(0, 8))
        self.btn_sms = ttk.Button(btns, text="启动短信服务", command=self.on_start_sms)
        self.btn_sms.pack(side=tk.LEFT, padx=(0, 8))
        self.btn_open = ttk.Button(btns, text="打开短信页面", command=self.on_open_sms)
        self.btn_open.pack(side=tk.LEFT)

        log_frame = ttk.LabelFrame(self, text="状态 / 日志", padding=8)
        log_frame.pack(fill=tk.BOTH, expand=True, padx=12, pady=(0, 12))
        self.log = scrolledtext.ScrolledText(log_frame, wrap=tk.WORD, height=20)
        self.log.pack(fill=tk.BOTH, expand=True)
        self.log.insert(tk.END, "就绪。建议顺序：安装驱动 → 检测状态 → 启动短信。\n")
        self.log.insert(
            tk.END,
            "说明：语音通话 v1 不在范围（IMS 通常关闭）。短信走 AT 口。\n\n",
        )

    def append(self, text: str) -> None:
        self.log.insert(tk.END, text.rstrip() + "\n")
        self.log.see(tk.END)

    def _busy(self, busy: bool) -> None:
        state = tk.DISABLED if busy else tk.NORMAL
        for b in (self.btn_drivers, self.btn_status, self.btn_sms, self.btn_open):
            b.configure(state=state)

    def on_install_drivers(self) -> None:
        self.append("=== 一键安装驱动（需要管理员 UAC）===")
        self._busy(True)

        def work() -> None:
            try:
                ok, msg = launch_elevated_install(log_callback=lambda m: self.after(0, self.append, m))
                self.after(0, self.append, msg)
                self.after(0, self.append, "成功" if ok else "失败或已取消")
            except Exception:  # noqa: BLE001
                self.after(0, self.append, traceback.format_exc())
            finally:
                self.after(0, self._busy, False)

        threading.Thread(target=work, daemon=True).start()

    def on_detect(self) -> None:
        self.append("=== 检测模块状态 ===")
        self._busy(True)

        def work() -> None:
            try:
                status = detect_status(probe=True)
                self.after(0, self.append, status.as_text())
            except Exception:  # noqa: BLE001
                self.after(0, self.append, traceback.format_exc())
            finally:
                self.after(0, self._busy, False)

        threading.Thread(target=work, daemon=True).start()

    def on_start_sms(self) -> None:
        self.append("=== 启动短信服务 ===")
        self._busy(True)

        def work() -> None:
            try:
                ok, msg = start_server_background()
                self.after(0, self.append, msg)
                if ok:
                    self.after(0, lambda: webbrowser.open(sms_url()))
            except Exception:  # noqa: BLE001
                self.after(0, self.append, traceback.format_exc())
            finally:
                self.after(0, self._busy, False)

        threading.Thread(target=work, daemon=True).start()

    def on_open_sms(self) -> None:
        url = sms_url()
        self.append(f"打开 {url}")
        webbrowser.open(url)


def main() -> None:
    app = ToolkitApp()
    app.mainloop()


if __name__ == "__main__":
    main()
