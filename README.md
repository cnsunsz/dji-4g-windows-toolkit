# DJI 4G Windows Toolkit

面向 **DJI 第一代 4G 模块（Cellular Gen1 / Baiwang QDC507，USB VID:PID `2CA3:4006`）** 的 Windows **Electron** 桌面工具箱：一键安装 Quectel USB 驱动（AT/DM/filter），并在**同一窗口内**通过 Quectel USB AT Port 以 **PDU 模式**收发短信、查看本机号码 / IMS 等状态；v0.6 起提供**手机式短信会话**、**来电弹窗 / 系统通知**与**托盘后台**；**v0.7** 起对齐更接近 macOS 连接工具的体验（透明图标、跟随系统主题、短信验证码芯片、AT 控制台）。

仓库：<https://github.com/cnsunsz/dji-4g-windows-toolkit>

> 本项目与 DJI / Quectel **无任何隶属或背书关系**。驱动为第三方专有组件，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## 功能

1. **Electron 桌面应用**：左侧导航（概览 / 短信 / 通话(实验) / 驱动 / 诊断 / **设置**）+ **浅色 / 深色 / 跟随系统** 主题（持久化）· macOS Settings 风格侧栏
2. **捆绑 Quectel NDIS Windows USB Driver (Q) V2.6.0** 的 `windows10/` INF+SYS：默认一键安装 `qcser` / `qcmdm` / `qcfilter`；可选单独安装 **`qcwwan`** 作为上网（WWAN/NDIS）驱动（非大疆官方独立包，可能覆盖百旺/大疆已有 WWAN）
3. **短信会话（PDU，v0.6）**：按对端号码聚合线程（规范化 `+86` / 首位 `0`）；左侧会话列表 + 右侧聊天气泡（收到靠左灰、发出靠右蓝，接近 iMessage）；成功发送后把**出站短信**持久化到 `userData`（按 ICCID）；与模组 PDU 收件箱合并；未读角标（`+CMTI` / 轮询）；会话内删除 / 清空会话；仍支持清空 SM。**默认不自动删除**短信。**v0.7**：自动识别短信中的 4–8 位验证码，气泡内显示可一键复制的芯片
4. **本机号码（v0.5）**：`AT+CNUM` 若有则优先显示；否则按 **ICCID** 持久化用户填写的 MSISDN（`userData/msisdn-by-iccid.json`）。概览与短信页顶栏显示有效号码；支持 **USSD 查号** 与从近期短信扫描大陆手机号。**不宣称 CNUM 在空返回时可用**
5. **通话（实验）**：侧栏拨号盘 + 历史日志；`ATD` / `ATA` / `ATH` + `RING` / `+CLIP`。**v0.8**：来电改为屏幕右下角 Mac 风格常置顶角标（接听 / 拒接），**不再**使用系统 Toast；自研风格铃声（苹果风/小米风/三星风/静音）+ 可选本机自定义铃声路径；托盘菜单仍可接听/挂断
6. **托盘与后台（v0.6）**：系统托盘；默认关闭窗口时最小化到托盘（模组保持连接）；托盘菜单：显示主窗口 / 接听 / 挂断 / 退出
7. **设置页（v0.8）**：开机启动、关闭到托盘、来电角标、来电铃声（自研风格示意 / 本机自定义路径）、短信角标与提示音、启动自动连接、托盘闪烁（`userData/settings.json`）。系统 Toast 已移除
8. **概览状态板**（含 USB/适配器提示）+ **启用 IMS**（可选软重启）
9. **诊断 · AT 控制台（v0.7）**：网页式单行 AT 调试（预设 CSQ/COPS/IMS/QCCID 等）；eSIM 仅占位「即将支持」

### 短信会话 / 托盘怎么用

| 场景 | 操作 |
|------|------|
| 看对话 | **短信** → 左侧选号码 → 右侧气泡（左=收到，右=已发送） |
| 发短信 | 右侧底部填号码与内容 → **发送**（成功后本地会记住出站记录） |
| 未读 | 会话列表角标 / 侧栏红点；点开会话即标记已读 |
| 关窗不退出 | **设置** 打开「关闭窗口时最小化到托盘」→ 关窗后托盘图标仍在，模组不断开 |
| 开机启动 | **设置** → 「开机启动」 |
| 来电 | 右下角常置顶角标（最小化/托盘时也能用）+ 自研铃声；托盘右键也可接听/挂断 |

### 国内移动卡 / 本机号码

- 中国移动等 SIM 上 **`AT+CNUM` 经常为空**，属正常现象
- 请用「保存本机号码」（按 ICCID 记住）或「USSD 查号」
- 换卡（ICCID 变化）后输入框会清空，需重新保存；短信出站记录也按 ICCID 分桶

### 语音（实验）说明

- 语音呼叫需要 **IMS 已注册**（目标 `IMS=1,1`）
- **通话控制**走标准 AT；**电脑音频**依赖 USB UAC / `QPCMV`，QDC507 上经常不可用
- 修改 `usbcfg` 有风险：仅通过明确按钮操作，并保存旧值可恢复

### 漫游物联网卡 / 收信说明

- 发短信请发到本机显示的**国际号码**（如 `+44…`）
- 英国等 IoT SIM 在中国漫游时，收信常依赖 **IMS 注册**

---

## 下载 Release（推荐）

**不需要在本地电脑编译。** 发布流程走 GitHub Actions：

1. 维护者推送版本标签，例如：
   ```bash
   git tag v0.8.0
   git push origin v0.8.0
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
5. **概览** 查看 / 保存本机号码；**短信** 按会话收发；**设置** 按需打开托盘 / 开机启动 / 来电通知
6. **通话（实验）** 在 IMS 已注册时拨打；来电时用弹窗或托盘接听/挂断
7. 若需要上网且当前无 WWAN：**驱动** → **安装上网驱动 (qcwwan)**（已能上网则跳过）

**注意**

- 安装驱动需要管理员权限
- 连接时**不会**自动删除 SIM / 模组内短信
- 默认关窗进托盘；要从托盘菜单选「退出」才真正退出

---

## 从源码运行（开发）

需要 Node.js LTS（Windows 上调试串口/驱动；Linux 仅可检查结构 / PDU / 会话单元逻辑）。

```powershell
cd dji-4g-windows-toolkit
npm install
npm start
npm run check:pdu
npm run check:threads
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
electron/main.js         BrowserWindow + Tray + Toast + IPC
electron/preload.js      contextBridge API
src/index.html           控制台壳（侧栏 + 多视图 + 来电弹层）
src/styles.css           自研浅/深色主题 + 会话气泡
src/renderer.js          视图 / 会话 UI / 来电弹窗 / 设置
src/device.js            端口 / PnP / ATI
src/modem.js             AT 串口（PDU、CMTI、IMS、USSD、语音）
src/msisdn-store.js      按 ICCID 持久化本机号码
src/sms-thread-store.js  按 ICCID 持久化出站短信 + 线程合并
src/settings-store.js    应用设置持久化
src/phone-normalize.js   对端号码规范化（+86 / 首位 0）
src/pdu.js               MIT 自研 SMS PDU 编解码
src/driver.js            捆绑驱动路径 + 提权安装
scripts/Install-Drivers.ps1
drivers/windows10/
build/icon.png + icon.ico 透明圆角方形应用图标（无白边）
scripts/generate-icon.py 图标生成（Pillow）
```

---

## 许可与致谢 / Prior art

- 本仓库自有代码：**MIT**，Copyright 2026 cnsunsz（见 [`LICENSE`](LICENSE)）
- Quectel 驱动二进制：专有，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- 早期文本模式短信思路参考 MIT 项目 [ctexcel-sms-dji](https://github.com/ywang3129-cell/ctexcel-sms-dji)
- **v0.3–v0.5** PDU / 状态 / IMS / 本机号码 / 实验语音：受 macOS 侧同类工具常见 AT 用法启发；实现为对照 **3GPP / Quectel 公开 AT** 的清洁重写，**未复制** PolyForm 源码
- **v0.4 UI**：侧栏控制台视觉受 VoHive / DJOneHub 启发；HTML/CSS/JS 为**原创 MIT**
- **v0.6**：手机式会话气泡 / 来电弹窗 / 托盘通知为原创 MIT 实现（手机/桌面通话 UX 灵感，无第三方源码复制）
- **v0.7**：更接近 macOS 设置/信息的 UI、验证码芯片、跟随系统主题、AT 控制台、透明图标 — 功能灵感来自同类 Mac 连接工具，**HTML/CSS/JS/图标均为原创 MIT**，未复制 PolyForm 源码

所用技术（`CMGF=0`、`CMGL=4`、`CNMI`、`QCFG="ims"`、CNUM/CCID、`ATD`/`ATA`/`ATH`、`CUSD` 等）均为公开调制解调器 AT 实践。

---

## English

**DJI 4G Windows Toolkit** — Electron helper for DJI Cellular Gen1 / Baiwang **QDC507** (`USB 2CA3:4006`).

- Quectel USB driver install (AT/DM/filter; WWAN optional)
- In-window **PDU** SMS with **threaded chat UI** (v0.6): normalize +86 / leading 0, outbound persisted by ICCID, unread badges
- Overview tiles + MSISDN helper (CNUM / ICCID-saved / USSD / SMS scan)
- Experimental voice: AT dial/answer/hangup; **incoming call popup + Windows toast + tray** (v0.6)
- Settings: launch at login, close-to-tray, notify/popup, auto-connect
- IMS enable; light / dark / **follow system** theme
- v0.7: OTP chips, AT console, transparent Mac-style app icon

**Release:** push `v*` tag → Actions builds on `windows-latest` → Release assets.

Not affiliated with DJI or Quectel. MIT for first-party code; no PolyForm Noncommercial source copied.


## 铃声与短信角标（v0.8）

- 内置「苹果风 / 小米风 / 三星风」为**自研合成**短循环示意音，**不是**各品牌官方原版铃声。
- 「自定义文件」只把本机绝对路径写入设置；文件留在您的电脑上，不会打进安装包或上传。
- 来电与新短信均使用屏幕右下角常置顶小窗，**不**走 Windows 通知中心 Toast。
