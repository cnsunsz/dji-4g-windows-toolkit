# DJI 4G Windows Toolkit

面向 **DJI 第一代 4G 模块（Cellular Gen1 / Baiwang QDC507，USB VID:PID `2CA3:4006`）** 的 Windows **Electron** 桌面工具箱：一键安装 Quectel USB 驱动（AT/DM/filter），并在**同一窗口内**通过 Quectel USB AT Port 以 **PDU 模式**收发短信、查看本机号码 / IMS 等状态。

仓库：<https://github.com/cnsunsz/dji-4g-windows-toolkit>

> 本项目与 DJI / Quectel **无任何隶属或背书关系**。驱动为第三方专有组件，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## 功能

1. **Electron 桌面应用**：左侧导航（概览 / 短信 / **通话(实验)** / 驱动 / 诊断）+ 浅色默认主题（可切换深色并持久化）
2. **捆绑 Quectel NDIS Windows USB Driver (Q) V2.6.0** 的 `windows10/` INF+SYS：默认一键安装 `qcser` / `qcmdm` / `qcfilter`；可选单独安装 **`qcwwan`** 作为上网（WWAN/NDIS）驱动（非大疆官方独立包，可能覆盖百旺/大疆已有 WWAN）
3. **短信（PDU）**：`AT+CMGF=0` + `AT+CNMI=2,1,0,0,0`；`AT+CMGL=4` 遍历 SM/ME/MT；自研 MIT 清洁实现的 SMS-DELIVER PDU 解码（发件人 / 时间戳 / GSM7·UCS2，基础长短信拼接）；PDU `CMGS` 发送（含 MR）；CMS 失败时可回退文本模式；监听 `+CMTI:` 刷新对应索引；支持单条 / 多选删除与确认后清空 SM。**默认不自动删除**短信
4. **本机号码（v0.5）**：`AT+CNUM` 若有则优先显示；否则按 **ICCID** 持久化用户填写的 MSISDN（`userData/msisdn-by-iccid.json`）。概览与短信页顶栏显示有效号码；支持 **USSD 查号**（预设如 `*208#`）与从近期短信扫描大陆手机号供选用。**不宣称 CNUM 在空返回时可用**
5. **通话（实验，v0.5）**：侧栏「通话」— `ATD{num};` / `ATA` / `ATH`，监听 `RING` / `+CLIP` / `CONNECT` / `NO CARRIER`；连接时 `AT+CLIP=1`。可选尝试 `usbcfg` UAC=1（需确认 + 可恢复旧值 + 重启）与 `AT+QPCMV=1,2`（QDC507 上常 ERROR → 提示电脑音频可能无声）
6. **概览状态板**：运营商、信号、网络、SIM/号码、IMS、端口、ICCID（缩短显示）、注册状态
7. **启用 IMS**：一键 `AT+QCFG="ims",1`，可选两步软重启 `AT+CFUN=1,1`

### 国内移动卡 / 本机号码

- 中国移动等 SIM 上 **`AT+CNUM` 经常为空**，属正常现象，不代表模块读不到卡
- 请用「保存本机号码」（按 ICCID 记住）或「USSD 查号」；也可从短信正文里检出的号码一键保存
- 换卡（ICCID 变化）后输入框会清空，需重新保存

### 语音（实验）说明

- 语音呼叫需要 **IMS 已注册**（目标 `IMS=1,1`）；未注册时 UI 会警告
- **通话控制**（拨打/接听/挂断）走标准 AT；**电脑扬声器/麦克风音频**依赖 USB UAC / `QPCMV`，QDC507 固件上经常不可用——此时仍可测信令，但可能无声
- 修改 `usbcfg` 有风险：仅通过明确按钮操作，并保存旧值可恢复

### 漫游物联网卡 / 收信说明

- 发短信请发到本机显示的**国际号码**（如 `+44…`）
- 英国等 IoT SIM 在中国漫游时，收信常依赖 **IMS 注册**；仅打开应用无法解决运营商侧未投递
- 诊断中常见：SM/ME/MT 均为 0 条、`IMS=1,0`（已启用未注册）——需要网络侧注册成功后才能稳定收信

---

## 下载 Release（推荐）

**不需要在本地电脑编译。** 发布流程走 GitHub Actions：

1. 维护者推送版本标签，例如：
   ```bash
   git tag v0.5.0
   git push origin v0.5.0
   ```
2. Actions 工作流 [`.github/workflows/release.yml`](.github/workflows/release.yml) 在 `windows-latest` 上用 **Node + electron-builder** 打出 Windows 安装包 / 便携版，并创建 GitHub Release
3. 用户到仓库 **Releases** 页下载，校验 SHA256 后运行

也可在 Actions 页手动 **workflow_dispatch**。

---

## 使用

1. 插入 DJI 第一代 4G 模块（或对应 USB 网卡）
2. 运行 `DJI-4G-Windows-Toolkit`
3. **驱动** → **一键安装驱动** → 同意 UAC
4. **诊断** → **检测模块**，确认出现 `Quectel USB AT Port`
5. **概览** 查看 / 保存本机号码（CNUM 或按 ICCID 手动 / USSD）；**短信** 收发与多选删除；需要时在「诊断」启用 IMS 或软重启
6. **通话（实验）** 在 IMS 已注册时拨打 / 接听 / 挂断；音频路径为实验项
7. 若需要上网且当前无 WWAN：**驱动** → **安装上网驱动 (qcwwan)**（已能上网则跳过）

**注意**

- 安装驱动需要管理员权限
- 连接时**不会**自动删除 SIM / 模组内短信
- 收信失败时优先核对：国际号码、IMS 注册、运营商投递，而不仅是本工具 UI

---

## 从源码运行（开发）

需要 Node.js LTS（Windows 上调试串口/驱动；Linux 仅可检查结构 / PDU 单元逻辑）。

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
- 仓库内路径：`drivers/windows10/`
- 安装脚本：`scripts/Install-Drivers.ps1`（管理员；默认 qcser/qcmdm/qcfilter；`-IncludeWwan` 追加 qcwwan；`-WwanOnly` 仅上网驱动）

---

## 架构（摘要）

```
electron/main.js      BrowserWindow + IPC
electron/preload.js   contextBridge API
src/index.html        控制台壳（侧栏 + 多视图）
src/styles.css        自研浅/深色主题
src/renderer.js       视图切换 / 状态板 / SMS / 本机号码 / 通话 UI
src/device.js         端口 / PnP / ATI
src/modem.js          AT 串口（PDU、CMTI、IMS、USSD、语音 ATD/ATA/ATH、usbcfg/QPCMV）
src/msisdn-store.js   按 ICCID 持久化本机号码 + 号码提取
src/pdu.js            MIT 自研 SMS PDU 编解码
src/driver.js         捆绑驱动路径 + 提权安装
scripts/Install-Drivers.ps1
drivers/windows10/
```

---

## 许可与致谢 / Prior art

- 本仓库自有代码：**MIT**，Copyright 2026 cnsunsz（见 [`LICENSE`](LICENSE)）
- Quectel 驱动二进制：专有，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- 早期文本模式短信思路参考 MIT 项目 [ctexcel-sms-dji](https://github.com/ywang3129-cell/ctexcel-sms-dji)
- **v0.3 PDU / 状态 / IMS 流程**受 macOS 侧 DJI 4G 工具（如 **DJOneHub / DJ4Hub / DJIC**）常见 AT 用法启发；实现为对照 **3GPP AT/PDU 惯例**的清洁重写。**未复制** DJOneHub 的 PolyForm Noncommercial 源码
- **v0.4 UI**：侧栏控制台 / 状态磁贴 / 浅深色主题在视觉上受 **VoHive**（`6mb/vohive` 等）与 **DJOneHub** mac 控制台启发；本仓库 `src/` 下 HTML/CSS/JS 为**原创 MIT 实现**，**不包含** PolyForm Noncommercial 源码。详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- **v0.5**：本机号码持久化 / USSD / 实验语音 AT 流程受 macOS 侧同类工具常见 AT 用法启发（`ATD…;`、`ATA`、`ATH`、`CLIP`、`CUSD`、`QCFG="usbcfg"`、`QPCMV`）；实现为对照 **3GPP / Quectel 公开 AT** 的清洁重写，**未复制** PolyForm 源码

所用技术（`CMGF=0`、`CMGL=4`、`CNMI`、`QCFG="ims"`、CNUM/CCID、`ATD`/`ATA`/`ATH`、`CUSD` 等）均为公开调制解调器 AT 实践。

---

## English

**DJI 4G Windows Toolkit** — Electron helper for DJI Cellular Gen1 / Baiwang **QDC507** (`USB 2CA3:4006`).

- Quectel USB driver install (AT/DM/filter; WWAN skipped by default)
- In-window **PDU** SMS (list SM/ME/MT, decode Deliver, PDU submit, `+CMTI` listen; no auto-delete)
- Overview status tiles: operator, signal, network, SIM/MSISDN, IMS, port, ICCID, registration
- Local MSISDN helper (v0.5): CNUM if present, else ICCID-keyed saved number / USSD / SMS scan — CNUM often empty on CMCC
- Experimental voice (v0.5): AT dial/answer/hangup + CLIP URCs; USB audio / QPCMV optional and often unavailable on QDC507
- IMS enable (+ optional soft reboot); light/dark theme with sidebar navigation (v0.4+)
- Voice needs IMS registered; roaming IoT SIMs often need IMS before inbound SMS works

**Release:** push `v*` tag → Actions builds on `windows-latest` → Release assets.

UI *look-and-feel* inspired by VoHive / DJOneHub dashboards (**inspiration only**; **no PolyForm code copied**). Modem flows inspired by common AT practice and prior art such as DJOneHub/DJIC (techniques only). Not affiliated with DJI or Quectel.
