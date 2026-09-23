"""Local SMS web UI on 127.0.0.1:7598 via Quectel USB AT Port.

Inspired by MIT-licensed ctexcel-sms-dji (AT CMGF/CMGL/CMGS + UCS2 ideas);
this is a slim reimplementation. Does NOT delete SIM messages on connect
unless the user explicitly opts in.
"""

from __future__ import annotations

import csv
import re
import threading
import time
from typing import Any

from flask import Flask, jsonify, request

from .device import AT_PORT_HINT, find_at_port, list_ports_summary
from .device import _list_serial_ports

HOST = "127.0.0.1"
PORT = 7598
SMS_SUBMIT_TIMEOUT = 60.0

# Minimal GSM 7-bit set for deciding UCS2 vs GSM (common chars only).
_GSM_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
_GSM_EXT = set("^{}\\[~]|€")


def _is_gsm_text(text: str) -> bool:
    return all(ch in _GSM_BASIC or ch in _GSM_EXT for ch in text)


def _encode_gsm(text: str) -> bytes:
    # Escape map for extension table (sufficient for toolkit v1).
    ext = {"^": 0x14, "{": 0x28, "}": 0x29, "\\": 0x2F, "[": 0x3C, "~": 0x3D, "]": 0x3E, "|": 0x40, "€": 0x65}
    out = bytearray()
    for ch in text:
        if ch in _GSM_BASIC:
            # Map via latin-1 ordinals for the overlapping printable range; others rare.
            out.append(ord(ch) & 0x7F if ch.isascii() else 0x3F)
        elif ch in ext:
            out.extend((0x1B, ext[ch]))
        else:
            out.append(0x3F)
    # Prefer sending ASCII payload for pure GSM printable when possible.
    try:
        return text.encode("ascii")
    except UnicodeEncodeError:
        return bytes(out)


def _decode_ucs2_hex(body: str) -> str:
    compact = "".join(body.split())
    if compact and len(compact) % 4 == 0 and re.fullmatch(r"[0-9A-Fa-f]+", compact):
        try:
            return bytes.fromhex(compact).decode("utf-16-be")
        except (ValueError, UnicodeDecodeError):
            pass
    return body


def _parse_csv_fields(value: str) -> list[str]:
    try:
        return next(csv.reader([value], skipinitialspace=True))
    except (csv.Error, StopIteration):
        return []


def _parse_cmgl(response: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    lines = response.replace("\r", "").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        m = re.match(r"^\+CMGL:\s*(.*)$", line)
        if not m:
            i += 1
            continue
        fields = _parse_csv_fields(m.group(1))
        index = int(fields[0]) if fields else None
        status = fields[1] if len(fields) > 1 else ""
        sender = fields[2] if len(fields) > 2 else ""
        timestamp = fields[4] if len(fields) > 4 else ""
        dcs = None
        if len(fields) > 7:
            try:
                dcs = int(fields[7], 0)
            except ValueError:
                dcs = None
        body_lines: list[str] = []
        i += 1
        while i < len(lines):
            nxt = lines[i]
            if nxt.strip().startswith("+CMGL:") or nxt.strip() in {"OK", "ERROR"}:
                break
            body_lines.append(nxt)
            i += 1
        body = "\n".join(body_lines).strip("\n")
        body = _decode_ucs2_hex(body)
        messages.append(
            {
                "index": index,
                "status": status.strip('"'),
                "sender": sender.strip('"'),
                "timestamp": timestamp.strip('"'),
                "body": body,
            }
        )
    return messages


INDEX_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DJI 4G SMS Toolkit</title>
  <style>
    :root { --bg:#0f1419; --card:#1a2332; --text:#e7ecf3; --muted:#8b9bb4; --accent:#3d8bfd; --ok:#3dd68c; --bad:#ff6b6b; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: "Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); }
    main { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
    h1 { font-size: 1.35rem; margin: 0 0 4px; }
    .sub { color: var(--muted); margin-bottom: 20px; font-size: .92rem; }
    .card { background: var(--card); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    label { color: var(--muted); font-size: .85rem; }
    input, textarea { width:100%; background:#0c1118; border:1px solid #2a3648; color:var(--text); border-radius:8px; padding:10px 12px; }
    textarea { min-height: 90px; resize: vertical; }
    button { background: var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 16px; cursor:pointer; font-weight:600; }
    button.secondary { background:#2a3648; }
    button.danger { background:#8b2e2e; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    #status { font-size:.9rem; color:var(--muted); white-space:pre-wrap; }
    #status.ok { color: var(--ok); }
    #status.bad { color: var(--bad); }
    .msg { border-top:1px solid #2a3648; padding:12px 0; }
    .msg:first-child { border-top:0; }
    .meta { color:var(--muted); font-size:.8rem; margin-bottom:4px; }
    .body { white-space:pre-wrap; word-break:break-word; }
  </style>
</head>
<body>
<main>
  <h1>DJI 4G 短信工具</h1>
  <p class="sub">本地 127.0.0.1:7598 · Quectel USB AT Port · 不会在连接时自动删除 SIM 短信</p>

  <div class="card">
    <div class="row" style="margin-bottom:10px">
      <button type="button" id="btnRefresh">刷新状态 / 短信</button>
      <button type="button" class="secondary" id="btnReconnect">重新连接</button>
      <label><input type="checkbox" id="optDelete"> 删除已读（仅手动刷新后可选操作）</label>
    </div>
    <div id="status">加载中…</div>
  </div>

  <div class="card">
    <h2 style="margin:0 0 12px;font-size:1.05rem">发送短信</h2>
    <label>号码</label>
    <input id="to" placeholder="+86138...." style="margin:6px 0 12px">
    <label>内容（中文自动 UCS2）</label>
    <textarea id="text" placeholder="短信内容" style="margin:6px 0 12px"></textarea>
    <button type="button" id="btnSend">发送</button>
  </div>

  <div class="card">
    <h2 style="margin:0 0 8px;font-size:1.05rem">收件箱</h2>
    <div id="list"></div>
  </div>
</main>
<script>
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function setStatus(text, ok) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = ok === true ? 'ok' : ok === false ? 'bad' : '';
}
function renderMessages(msgs) {
  const box = document.getElementById('list');
  if (!msgs || !msgs.length) { box.innerHTML = '<div class="meta">暂无短信</div>'; return; }
  box.innerHTML = msgs.map(m => `
    <div class="msg">
      <div class="meta">#${m.index ?? '?'} · ${m.sender || ''} · ${m.timestamp || ''} · ${m.status || ''}</div>
      <div class="body"></div>
    </div>`).join('');
  [...box.querySelectorAll('.msg')].forEach((el, i) => {
    el.querySelector('.body').textContent = msgs[i].body || '';
  });
}
async function refresh() {
  try {
    const s = await api('/api/status');
    const lines = [
      `连接: ${s.connected ? '是' : '否'}`,
      `端口: ${s.port || '(无)'}`,
      s.signal != null ? `信号 CSQ: ${s.signal}` : null,
      s.operator ? `运营商: ${s.operator}` : null,
      s.error ? `错误: ${s.error}` : null,
    ].filter(Boolean);
    setStatus(lines.join('\n'), s.connected && !s.error);
    const m = await api('/api/messages');
    renderMessages(m.messages || []);
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}
document.getElementById('btnRefresh').onclick = refresh;
document.getElementById('btnReconnect').onclick = async () => {
  try {
    await api('/api/reconnect', { method: 'POST' });
    await refresh();
  } catch (e) { setStatus(String(e.message || e), false); }
};
document.getElementById('btnSend').onclick = async () => {
  const to = document.getElementById('to').value.trim();
  const text = document.getElementById('text').value;
  if (!to || !text) { setStatus('请填写号码和内容', false); return; }
  try {
    setStatus('发送中…');
    await api('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, text }),
    });
    document.getElementById('text').value = '';
    setStatus('发送成功', true);
    await refresh();
  } catch (e) { setStatus('发送失败: ' + (e.message || e), false); }
};
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>
"""


class AtModem:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._serial = None
        self._port: str | None = None
        self._error: str | None = None
        self._signal: str | None = None
        self._operator: str | None = None
        self._messages: list[dict[str, Any]] = []
        self._stop = threading.Event()

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "connected": self._serial is not None and self._serial.is_open,
                "port": self._port,
                "signal": self._signal,
                "operator": self._operator,
                "error": self._error,
                "at_hint": AT_PORT_HINT,
            }

    def messages(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._messages)

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            self._disconnect()

    def _disconnect(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:  # noqa: BLE001
                pass
        self._serial = None

    def _read_response(self, timeout: float, expect_prompt: bool = False) -> str:
        import serial

        if self._serial is None:
            raise serial.SerialException("串口未连接")
        deadline = time.monotonic() + timeout
        received = bytearray()
        while time.monotonic() < deadline and not self._stop.is_set():
            waiting = self._serial.in_waiting
            chunk = self._serial.read(waiting if waiting else 1)
            if not chunk:
                continue
            received.extend(chunk)
            text = received.decode("utf-8", errors="replace")
            if expect_prompt and re.search(r"(?:^|\r?\n)>\s*$", text):
                return text
            if re.search(
                r"(?:^|\r?\n)(?:OK|ERROR|\+CMS ERROR:.*|\+CME ERROR:.*)\r?\n?$",
                text,
            ):
                return text
        text = received.decode("utf-8", errors="replace")
        raise TimeoutError(f"AT timeout: {text[:200]}")

    def _command(self, command: str, *, timeout: float = 5.0, expect_prompt: bool = False) -> str:
        if self._serial is None:
            raise RuntimeError("串口未连接")
        self._serial.write(command.encode("ascii") + b"\r")
        self._serial.flush()
        response = self._read_response(timeout, expect_prompt=expect_prompt)
        if re.search(r"(?:^|\r?\n)(?:ERROR|\+CMS ERROR:|\+CME ERROR:)", response):
            raise RuntimeError(response.strip()[:300])
        return response

    def connect(self) -> None:
        import serial

        with self._lock:
            self._disconnect()
            match = find_at_port(_list_serial_ports())
            if match is None:
                self._port = None
                self._error = f"未检测到 {AT_PORT_HINT}"
                return
            self._port = match.device
            self._error = f"正在初始化 {self._port}"
            try:
                self._serial = serial.Serial(
                    port=self._port,
                    baudrate=115200,
                    timeout=0.15,
                    write_timeout=5,
                )
                time.sleep(0.25)
                self._serial.reset_input_buffer()
                for cmd in (
                    "ATE0",
                    "AT+CMGF=1",
                    'AT+CSCS="GSM"',
                    "AT+CSDH=1",
                    'AT+CPMS="SM","SM","SM"',
                    "AT+CNMI=2,1,0,0,0",
                ):
                    try:
                        self._command(cmd)
                    except Exception as exc:  # noqa: BLE001
                        # CPMS storage name may differ; keep going.
                        if "CPMS" in cmd:
                            try:
                                self._command('AT+CPMS="ME","ME","ME"')
                            except Exception:  # noqa: BLE001
                                pass
                        else:
                            raise exc
                self._refresh_locked()
                self._error = None
            except Exception as exc:  # noqa: BLE001
                self._error = str(exc)
                self._disconnect()

    def _refresh_locked(self) -> None:
        try:
            csq = self._command("AT+CSQ")
            m = re.search(r"\+CSQ:\s*(\d+),\d+", csq)
            self._signal = m.group(1) if m else None
        except Exception:  # noqa: BLE001
            self._signal = None
        try:
            cops = self._command("AT+COPS?")
            m = re.search(r'\+COPS:.*?,"([^"]+)"', cops)
            self._operator = m.group(1) if m else None
        except Exception:  # noqa: BLE001
            self._operator = None
        try:
            raw = self._command('AT+CMGL="ALL"', timeout=15.0)
            self._messages = _parse_cmgl(raw)
        except Exception as exc:  # noqa: BLE001
            self._error = f"读取短信失败: {exc}"

    def refresh(self) -> None:
        with self._lock:
            if self._serial is None:
                self.connect()
                return
            try:
                self._refresh_locked()
                if self._error and "读取短信" not in self._error:
                    self._error = None
            except Exception as exc:  # noqa: BLE001
                self._error = str(exc)

    def send(self, recipient: str, text: str) -> None:
        recipient = recipient.strip()
        if not recipient or not text:
            raise ValueError("号码和内容不能为空")
        with self._lock:
            if self._serial is None:
                raise RuntimeError("设备未连接")
            use_ucs2 = not _is_gsm_text(text)
            switched = False
            try:
                if use_ucs2:
                    self._command('AT+CSCS="UCS2"')
                    self._command("AT+CSMP=17,167,0,8")
                    switched = True
                    enc_to = recipient.encode("utf-16-be").hex().upper()
                    payload = text.encode("utf-16-be").hex().upper().encode("ascii")
                else:
                    enc_to = recipient
                    payload = text.encode("ascii", errors="replace")
                self._command(f'AT+CMGS="{enc_to}"', timeout=5.0, expect_prompt=True)
                self._serial.write(payload + b"\x1a")
                self._serial.flush()
                response = self._read_response(SMS_SUBMIT_TIMEOUT)
                if re.search(r"(?:^|\r?\n)(?:ERROR|\+CMS ERROR:|\+CME ERROR:)", response):
                    raise RuntimeError(response.strip()[:300])
                if not re.search(r"\+CMGS:\s*\d+", response):
                    raise RuntimeError("未收到 +CMGS 确认")
            finally:
                if switched and self._serial is not None:
                    try:
                        self._command('AT+CSCS="GSM"')
                        self._command("AT+CSMP=17,167,0,0")
                    except Exception:  # noqa: BLE001
                        pass


_modem = AtModem()
_app: Flask | None = None
_server_thread: threading.Thread | None = None


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/")
    def index():
        return INDEX_HTML

    @app.get("/api/status")
    def api_status():
        return jsonify(_modem.status())

    @app.get("/api/messages")
    def api_messages():
        return jsonify({"messages": _modem.messages()})

    @app.post("/api/reconnect")
    def api_reconnect():
        _modem.connect()
        return jsonify(_modem.status())

    @app.post("/api/refresh")
    def api_refresh():
        _modem.refresh()
        return jsonify({"status": _modem.status(), "messages": _modem.messages()})

    @app.post("/api/send")
    def api_send():
        data = request.get_json(silent=True) or {}
        try:
            _modem.send(str(data.get("to") or ""), str(data.get("text") or ""))
        except Exception as exc:  # noqa: BLE001
            return jsonify({"error": str(exc)}), 400
        return jsonify({"ok": True})

    return app


def start_server_background() -> tuple[bool, str]:
    """Start Flask on 127.0.0.1:7598 in a daemon thread. Idempotent."""
    global _app, _server_thread
    if _server_thread is not None and _server_thread.is_alive():
        return True, f"SMS server already running at http://{HOST}:{PORT}/"

    _app = create_app()

    def run() -> None:
        _modem.connect()
        # threaded=True so refresh/send don't block each other too hard
        _app.run(host=HOST, port=PORT, threaded=True, use_reloader=False)

    _server_thread = threading.Thread(target=run, name="sms-server", daemon=True)
    _server_thread.start()
    time.sleep(0.6)
    return True, f"SMS server started at http://{HOST}:{PORT}/"


def sms_url() -> str:
    return f"http://{HOST}:{PORT}/"


if __name__ == "__main__":
    app = create_app()
    _modem.connect()
    app.run(host=HOST, port=PORT, threaded=True)
