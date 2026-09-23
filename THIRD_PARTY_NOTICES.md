# Third-Party Notices / 第三方声明

本项目自有源码采用 **MIT License**（见 `LICENSE`，Copyright 2026 cnsunsz）。
下列内容**不**因此改用 MIT，也不表示本项目与相关厂商存在隶属或背书关系。

This project's own source code is MIT-licensed (see `LICENSE`, Copyright 2026 cnsunsz).
The materials below remain under their original terms. This project is **not affiliated
with, endorsed by, or sponsored by DJI or Quectel**.

## Quectel Windows USB Drivers (bundled)

- **What:** Quectel NDIS Windows USB Driver (Q) **V2.6.0** `windows10/` tree
  (`qcser.inf`, `qcmdm.inf`, `qcfilter.inf`, and related `.sys` / `.cat` binaries;
  `qcwwan.inf` may be present in the tree but is **not** installed by default).
- **Source (community mirror used for convenience):**
  `https://raw.githubusercontent.com/4IceG/RM520N-GL/main/Toolz/Quectel_Windows_USB_Driver(Q)_NDIS_V2.6.0.zip`
- **Rights:** Proprietary to **Quectel Wireless Solutions Co., Ltd.** (and/or its
  licensors). Bundled here solely for **end-user convenience** so the toolkit can
  one-click install AT/DM/NMEA/Modem/filter interfaces on Windows.
- **Redistribution:** If you redistribute this repository or Release builds that
  include `drivers/windows10/`, you must keep this notice and comply with Quectel's
  applicable terms. Prefer obtaining drivers from Quectel's official channels when
  available.
- **Not included:** Full EG25 firmware packages, QFlash, or other flashing tools.

## SMS design inspiration

Earlier text-mode CMGF/CMGL/CMGS and UCS2 handling ideas were informed by the
MIT-licensed project [ctexcel-sms-dji](https://github.com/ywang3129-cell/ctexcel-sms-dji)
(Copyright 2026 ywang3129-cell). This toolkit ships a **slim** Electron + serialport
implementation and does **not** copy that project's full application, Telegram bot,
or installer.

PDU-mode receive/send, status (CNUM/ICCID/IMS), and IMS enable flows in v0.3+ follow
**common public AT/modem practice** (3GPP TS 27.005 / 23.040 style commands). macOS
DJI 4G tools such as DJOneHub / DJ4Hub / DJIC are acknowledged as **prior art
inspiration only**. Their PolyForm Noncommercial (or other non-MIT) source was
**not** copied; PDU codecs and modem control here are original MIT code.

## Electron / Node dependencies

- Electron — see Electron / Chromium / Node license notices shipped by Electron
- serialport — MIT
- electron-builder (dev / Windows build) — MIT

Exact versions: see `package.json` / `package-lock.json` after `npm install`.

## Trademarks

DJI, Quectel, Baiwang, Windows, and other names are trademarks of their respective
owners. Use of those names is descriptive only.
