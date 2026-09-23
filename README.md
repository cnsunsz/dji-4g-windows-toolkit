# DJI 4G Windows Toolkit

面向 **DJI 第一代 4G 模块（Cellular Gen1 / Baiwang QDC507，USB VID:PID `2CA3:4006`）** 的 Windows 工具箱：一键安装 Quectel USB 驱动（AT/DM/NMEA/Modem/filter），并通过 Quectel USB AT Port 收发短信。

仓库：<https://github.com/cnsunsz/dji-4g-windows-toolkit>

> 本项目与 DJI / Quectel **无任何隶属或背书关系**。驱动为第三方专有组件，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## 功能

1. **Windows EXE**（Tkinter GUI）：一键装驱动 / 检测模块 / 启动短信网页
2. **捆绑 Quectel NDIS Windows USB Driver (Q) V2.6.0** 的 `windows10/` INF+SYS，管理员一键 `pnputil` 安装 `qcser` / `qcmdm` / `qcfilter`（默认**不**安装 `qcwwan`，以免覆盖已可用的百网 WWAN）
3. **短信**：本地网页 `http://127.0.0.1:7598/`（避开 ctexcel 常用的 7597），自动寻找 `Quectel USB AT Port`，文本模式 CMGF/CMGL/CMGS，中文 UCS2
4. **语音/通话不在 v1 范围**（IMS 通常关闭）— 仅短信与驱动

已在 QDC507 + COM3（Quectel USB AT Port）场景验证 AT 可用。

---

## 下载 Release EXE（推荐）

**不需要在本地电脑编译。** 发布流程走 GitHub Actions：

1. 维护者推送版本标签，例如：
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
2. Actions 工作流 [`.github/workflows/release.yml`](.github/workflows/release.yml) 在 `windows-latest` 上安装 Python、PyInstaller，打出 onefile GUI EXE（内含 `drivers/windows10`），并创建 GitHub Release，上传：
   - `DJI-4G-Windows-Toolkit.exe`
   - `DJI-4G-Windows-Toolkit.exe.sha256`
3. 用户到仓库 **Releases** 页下载 EXE，校验 SHA256 后运行。

也可在 Actions 页手动 **workflow_dispatch**（可填 tag 直接发 Release，或不填 tag 只留 artifact）。

---

## 使用 EXE

1. 插入 DJI 第一代 4G 模块（或对应 USB 网卡）
2. 运行 `DJI-4G-Windows-Toolkit.exe`
3. 点击 **一键安装驱动** → 同意 UAC → 等待 pnputil 完成（日志：`%TEMP%\dji-4g-toolkit-driver-install.log`）
4. 点击 **检测模块状态**，确认出现 `Quectel USB AT Port`（如 COM3）及 ATI
5. 点击 **启动短信服务**，浏览器打开 `http://127.0.0.1:7598/` 收发短信
6. 之后可用 **打开短信页面** 再次打开

**注意**

- 安装驱动需要管理员权限
- 短信可用；语音通常不可用（IMS off）
- 连接时**不会**自动删除 SIM 内短信（比部分上游默认行为更保守）

---

## 从源码运行（开发）

```powershell
cd dji-4g-windows-toolkit
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m app.main
```

单独启动短信服务：

```powershell
python -m app.sms_server
```

---

## 本地编译 EXE（可选备用）

主路径是 **GitHub Actions**。若需在本机 Windows（Python 3.11+）试编译：

```powershell
.\scripts\build_windows.ps1
```

产物：`dist\DJI-4G-Windows-Toolkit.exe`。

---

## 驱动说明

- 来源：Quectel NDIS Windows USB Driver (Q) **V2.6.0** 社区镜像  
  `https://raw.githubusercontent.com/4IceG/RM520N-GL/main/Toolz/Quectel_Windows_USB_Driver(Q)_NDIS_V2.6.0.zip`
- 仓库内路径：`drivers/windows10/`（含 `qcser.inf` 等）
- 安装脚本：`scripts/Install-Drivers.ps1`（管理员；只装 qcser/qcmdm/qcfilter）
- **不包含** EG25 完整固件或 QFlash

---

## 许可

- 本仓库自有代码：**MIT**，Copyright 2026 cnsunsz（见 [`LICENSE`](LICENSE)）
- Quectel 驱动二进制：专有，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- 短信 AT 流程参考了 MIT 项目 [ctexcel-sms-dji](https://github.com/ywang3129-cell/ctexcel-sms-dji) 的思路；本仓库为精简重写并致谢

---

## English

**DJI 4G Windows Toolkit** — Windows helper for the DJI Cellular Gen1 / Baiwang **QDC507** module (`USB VID:PID 2CA3:4006`).

- One-click Quectel USB driver install (AT/DM/filter; WWAN skipped by default)
- Local SMS UI on `127.0.0.1:7598` via Quectel USB AT Port (UCS2 for Chinese)
- Voice/calls out of scope for v1 (IMS usually off)

**Get the EXE:** push a `v*` tag → GitHub Actions builds on `windows-latest` → Release assets appear. No local Windows build required for end users or for maintainers who prefer CI.

Repo: <https://github.com/cnsunsz/dji-4g-windows-toolkit>

See `THIRD_PARTY_NOTICES.md` for Quectel driver redistribution notes. Not affiliated with DJI or Quectel.
