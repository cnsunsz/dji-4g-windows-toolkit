# DJI 4G Windows Toolkit

面向 **DJI 第一代 4G 模块（Cellular Gen1 / Baiwang QDC507，USB VID:PID `2CA3:4006`）** 的 Windows **Electron** 桌面工具箱：一键安装 Quectel USB 驱动（AT/DM/filter），并在**同一窗口内**通过 Quectel USB AT Port 收发短信。

仓库：<https://github.com/cnsunsz/dji-4g-windows-toolkit>

> 本项目与 DJI / Quectel **无任何隶属或背书关系**。驱动为第三方专有组件，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## 功能

1. **Electron 桌面应用**：驱动安装 / 模块检测 / 短信收发全部在一个窗口内完成（不再打开外部浏览器或本地网页）
2. **捆绑 Quectel NDIS Windows USB Driver (Q) V2.6.0** 的 `windows10/` INF+SYS，管理员一键 `pnputil` 安装 `qcser` / `qcmdm` / `qcfilter`（默认**不**安装 `qcwwan`，以免覆盖已可用的百网 WWAN）
3. **短信**：串口 AT（115200），文本模式 CMGF/CMGL/CMGS，中文 UCS2；连接时**不会**自动删除 SIM 短信
4. **语音/通话不在范围**（IMS 通常关闭）— 仅短信与驱动

已在 QDC507 + Quectel USB AT Port 场景验证 AT 可用。

---

## 下载 Release（推荐）

**不需要在本地电脑编译。** 发布流程走 GitHub Actions：

1. 维护者推送版本标签，例如：
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
2. Actions 工作流 [`.github/workflows/release.yml`](.github/workflows/release.yml) 在 `windows-latest` 上用 **Node + electron-builder** 打出 Windows 安装包 / 便携版（内含 `drivers/windows10` 与 `Install-Drivers.ps1`），并创建 GitHub Release，上传例如：
   - `DJI-4G-Windows-Toolkit-*-portable.exe`（便携）
   - `DJI-4G-Windows-Toolkit-*-Setup.exe` / NSIS 安装包
   - 对应 `.sha256`
3. 用户到仓库 **Releases** 页下载，校验 SHA256 后运行。

也可在 Actions 页手动 **workflow_dispatch**（可填 tag 直接发 Release，或不填 tag 只留 artifact）。

---

## 使用

1. 插入 DJI 第一代 4G 模块（或对应 USB 网卡）
2. 运行 `DJI-4G-Windows-Toolkit`（便携 EXE 或安装后的快捷方式）
3. **驱动** → **一键安装驱动** → 同意 UAC → 等待 pnputil 完成（日志：`%TEMP%\dji-4g-toolkit-driver-install.log`）
4. **模块** → **检测模块**，确认出现 `Quectel USB AT Port` 及 ATI
5. **短信** 区查看连接状态、刷新收件箱、发送短信（连接成功后约每 15 秒自动刷新）

**注意**

- 安装驱动需要管理员权限
- 短信可用；语音通常不可用（IMS off）
- 连接时**不会**自动删除 SIM 内短信

---

## 从源码运行（开发）

需要 Node.js LTS（Windows 上调试串口/驱动；Linux 仅可检查结构）。

```powershell
cd dji-4g-windows-toolkit
npm install
npm start
```

打包（请在 Windows 上执行，或依赖 GitHub Actions）：

```powershell
npm run build
```

产物在 `dist/`。

---

## 驱动说明

- 来源：Quectel NDIS Windows USB Driver (Q) **V2.6.0** 社区镜像  
  `https://raw.githubusercontent.com/4IceG/RM520N-GL/main/Toolz/Quectel_Windows_USB_Driver(Q)_NDIS_V2.6.0.zip`
- 仓库内路径：`drivers/windows10/`（含 `qcser.inf` 等）
- 安装脚本：`scripts/Install-Drivers.ps1`（管理员；只装 qcser/qcmdm/qcfilter）
- **不包含** EG25 完整固件或 QFlash

---

## 架构（摘要）

```
electron/main.js      BrowserWindow + IPC
electron/preload.js   contextBridge API
src/index.html        单页 UI（驱动 / 模块 / 短信）
src/device.js         端口 / PnP / ATI
src/modem.js          AT 串口短信（CMGF/CMGL/CMGS + UCS2）
src/driver.js         捆绑驱动路径 + 提权安装
scripts/Install-Drivers.ps1
drivers/windows10/
```

---

## 许可

- 本仓库自有代码：**MIT**，Copyright 2026 cnsunsz（见 [`LICENSE`](LICENSE)）
- Quectel 驱动二进制：专有，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- 短信 AT 流程参考了 MIT 项目 [ctexcel-sms-dji](https://github.com/ywang3129-cell/ctexcel-sms-dji) 的思路；本仓库为精简重写并致谢

---

## English

**DJI 4G Windows Toolkit** — Electron desktop helper for the DJI Cellular Gen1 / Baiwang **QDC507** module (`USB VID:PID 2CA3:4006`).

- One-click Quectel USB driver install (AT/DM/filter; WWAN skipped by default)
- In-window SMS UI via Quectel USB AT Port (UCS2 for Chinese) — no external browser
- Voice/calls out of scope (IMS usually off)

**Get the EXE:** push a `v*` tag → GitHub Actions builds on `windows-latest` with electron-builder → Release assets appear.

Repo: <https://github.com/cnsunsz/dji-4g-windows-toolkit>

See `THIRD_PARTY_NOTICES.md` for Quectel driver redistribution notes. Not affiliated with DJI or Quectel.
