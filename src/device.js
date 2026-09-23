'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { SerialPort } = require('serialport');

const execFileAsync = promisify(execFile);

const DJI_VID = 0x2ca3;
const DJI_PID = 0x4006;
const QUECTEL_VID = 0x2c7c;
const QUECTEL_PID = 0x0125;
const SUPPORTED_USB_IDS = new Set([
  `${DJI_VID.toString(16)}:${DJI_PID.toString(16)}`,
  `${QUECTEL_VID.toString(16)}:${QUECTEL_PID.toString(16)}`,
]);
const AT_PORT_HINT = 'Quectel USB AT Port';

function normalizeVidPid(vid, pid) {
  if (vid == null || pid == null) return null;
  const v = typeof vid === 'number' ? vid : parseInt(String(vid), 16);
  const p = typeof pid === 'number' ? pid : parseInt(String(pid), 16);
  if (Number.isNaN(v) || Number.isNaN(p)) return null;
  return `${v.toString(16).toUpperCase().padStart(4, '0')}:${p
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')}`;
}

function isSupportedVidPid(vid, pid) {
  const key = normalizeVidPid(vid, pid);
  if (!key) return false;
  return SUPPORTED_USB_IDS.has(key.toLowerCase());
}

async function listSerialPorts() {
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    device: p.path || '',
    description: p.friendlyName || p.manufacturer || p.path || '',
    vid: p.vendorId ? parseInt(p.vendorId, 16) : null,
    pid: p.productId ? parseInt(p.productId, 16) : null,
    hwid: p.pnpId || '',
  }));
}

function findAtPort(ports) {
  const scored = [];
  for (const port of ports || []) {
    if (!port.device) continue;
    let score = 0;
    const desc = String(port.description || '').toLowerCase();
    if (desc.includes(AT_PORT_HINT.toLowerCase())) score += 50;
    if (isSupportedVidPid(port.vid, port.pid)) {
      score += 100;
      if (desc.includes('at')) score += 20;
    }
    if (score > 0) scored.push({ score, port });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].port;
}

async function usbPresentWindows() {
  if (process.platform !== 'win32') {
    return { present: false, vidPid: '', raw: '' };
  }
  const ps = `
$ids = @('VID_2CA3*PID_4006*', 'VID_2C7C*PID_0125*')
$found = @()
foreach ($pat in $ids) {
  Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like $pat } |
    ForEach-Object { $found += "$($_.Status)|$($_.FriendlyName)|$($_.InstanceId)" }
}
if ($found.Count -eq 0) { Write-Output 'NONE' } else { $found | ForEach-Object { Write-Output $_ } }
`.trim();

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' }
    );
    const out = (stdout || '').trim();
    if (!out || out === 'NONE') return { present: false, vidPid: '', raw: out };
    let vidPid = '';
    const upper = out.toUpperCase();
    if (upper.includes('VID_2CA3') && upper.includes('PID_4006')) vidPid = '2CA3:4006';
    else if (upper.includes('VID_2C7C') && upper.includes('PID_0125')) vidPid = '2C7C:0125';
    return { present: true, vidPid, raw: out };
  } catch (err) {
    return { present: false, vidPid: '', raw: '', error: String(err.message || err) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readUntilOk(port, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let buf = Buffer.alloc(0);
  while (Date.now() < deadline) {
    const chunk = port.read();
    if (chunk && chunk.length) {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('utf8');
      if (/(?:^|\r?\n)(?:OK|ERROR)\r?\n?$/.test(text)) return text;
    } else {
      await sleep(40);
    }
  }
  return buf.toString('utf8');
}

async function probeAti(devicePath, baud = 115200, timeoutMs = 2000) {
  const port = new SerialPort({
    path: devicePath,
    baudRate: baud,
    autoOpen: false,
  });
  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });
  try {
    await sleep(200);
    port.flush();
    const lines = [];
    for (const cmd of ['AT', 'ATI', 'AT+GMM', 'AT+CGMR']) {
      port.write(`${cmd}\r`);
      await new Promise((resolve, reject) => {
        port.drain((err) => (err ? reject(err) : resolve()));
      });
      const text = await readUntilOk(port, timeoutMs);
      lines.push(`>>> ${cmd}\n${text.trim()}\n`);
    }
    return lines.join('\n');
  } finally {
    if (port.isOpen) await new Promise((r) => port.close(() => r()));
  }
}

function statusAsText(status) {
  const lines = [
    `USB present: ${status.usbPresent}`,
    `VID:PID: ${status.vidPid || '(none)'}`,
    `AT port: ${status.atPort || '(not found)'}`,
  ];
  if (status.ports && status.ports.length) {
    lines.push('COM / serial ports:');
    for (const p of status.ports) {
      const vp =
        p.vid != null && p.pid != null
          ? ` [${p.vid.toString(16).toUpperCase().padStart(4, '0')}:${p.pid
              .toString(16)
              .toUpperCase()
              .padStart(4, '0')}]`
          : '';
      lines.push(`  - ${p.device}: ${p.description}${vp}`);
    }
  }
  if (status.ati) {
    lines.push('--- ATI ---');
    lines.push(String(status.ati).trim());
  }
  for (const note of status.notes || []) lines.push(`note: ${note}`);
  if (status.error) lines.push(`error: ${status.error}`);
  return lines.join('\n');
}

async function detectStatus({ probe = true } = {}) {
  const status = {
    usbPresent: false,
    vidPid: '',
    atPort: null,
    ports: [],
    ati: null,
    error: null,
    notes: [],
    text: '',
  };

  if (process.platform === 'win32') {
    const usb = await usbPresentWindows();
    status.usbPresent = usb.present;
    status.vidPid = usb.vidPid || '';
    if (usb.error) status.notes.push(`PnP query: ${usb.error}`);
  } else {
    status.notes.push('PnP USB scan is Windows-only; listing serial ports only.');
  }

  const ports = await listSerialPorts();
  status.ports = ports;
  const match = findAtPort(ports);
  if (match) {
    status.atPort = match.device;
    if (!status.vidPid && match.vid != null && match.pid != null) {
      status.vidPid = normalizeVidPid(match.vid, match.pid);
      status.usbPresent = true;
    } else if (match.vid != null && match.pid != null) {
      status.usbPresent = true;
    }
  }

  if (probe && status.atPort) {
    try {
      status.ati = await probeAti(status.atPort);
    } catch (err) {
      status.error = `ATI probe failed on ${status.atPort}: ${err.message || err}`;
    }
  } else if (!status.atPort) {
    status.notes.push(
      `Install Quectel AT/DM/filter drivers, then reconnect. Looking for '${AT_PORT_HINT}'.`
    );
  }

  status.text = statusAsText(status);
  return status;
}

module.exports = {
  AT_PORT_HINT,
  DJI_VID,
  DJI_PID,
  QUECTEL_VID,
  QUECTEL_PID,
  listSerialPorts,
  findAtPort,
  detectStatus,
  probeAti,
  statusAsText,
};
