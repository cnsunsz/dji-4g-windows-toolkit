# Changelog

## v0.7.0 — 2026-09-23

### 图标
- 重做应用图标：透明背景 PNG（1024²）+ 多尺寸 ICO（256/128/64/48/32/16）
- 蓝色渐变 squircle 贴近画布边缘，软抗锯齿 alpha，**无白色画布/白边**
- 图形仍为信号柱 + 短信气泡（原创绘制，`scripts/generate-icon.py`）

### UI（更接近 macOS）
- 字体栈优先 `-apple-system` / SF Pro / PingFang
- 更大圆角、更柔和背景与阴影；侧栏胶囊选中态 + 原创 SVG 图标
- 主题：**浅色 / 深色 / 跟随系统**（`prefers-color-scheme`，可持久化）
- 概览中文优先、弱化英文 kicker；短信气泡更接近 iMessage；来电弹层毛玻璃加强

### 功能
- **短信验证码提取**：识别 4–8 位 OTP，气泡内可复制芯片
- **概览**：补充 USB/适配器提示（VID:PID / 端口描述启发）
- **AT 控制台**：诊断页单行发送 + 原始响应 + 常用预设
- eSIM：仅「即将支持」占位（不伪造可用功能）
- 驱动页提示更清晰

### 许可
- 继续 MIT；未从 DJOneHub / VoHive（PolyForm Noncommercial）复制任何源码

## v0.6.0

- 手机式短信会话、来电弹窗 / Toast、托盘后台、设置页
- 专用应用图标（后续 v0.7 修复白边）
