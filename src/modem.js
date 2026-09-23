'use strict';

const { SerialPort } = require('serialport');
const { AT_PORT_HINT, findAtPort, listSerialPorts } = require('./device');

const SMS_SUBMIT_TIMEOUT_MS = 60000;
const BAUD = 115200;

const GSM_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
  )
);
const GSM_EXT = new Set(Array.from('^{}\\[~]|€'));

function isGsmText(text) {
  for (const ch of text) {
    if (!GSM_BASIC.has(ch) && !GSM_EXT.has(ch)) return false;
  }
  return true;
}

function decodeUcs2Hex(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact && compact.length % 4 === 0 && /^[0-9A-Fa-f]+$/.test(compact)) {
    try {
      // Modem UCS2 is big-endian; Node utf16le needs byte-swapped buffer.
      return Buffer.from(compact, 'hex').swap16().toString('utf16le');
    } catch {
      return body;
    }
  }
  return body;
}

function parseCsvFields(value) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes) {
      if (ch === '"' && value[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseCmgl(response) {
  const messages = [];
  const lines = response.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const m = line.match(/^\+CMGL:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const fields = parseCsvFields(m[1]);
    const index = fields[0] ? parseInt(fields[0], 10) : null;
    const status = fields[1] || '';
    const sender = fields[2] || '';
    const timestamp = fields[4] || '';
    const bodyLines = [];
    i++;
    while (i < lines.length) {
      const nxt = lines[i];
      const t = nxt.trim();
      if (t.startsWith('+CMGL:') || t === 'OK' || t === 'ERROR') break;
      bodyLines.push(nxt);
      i++;
    }
    let body = bodyLines.join('\n').replace(/^\n+|\n+$/g, '');
    body = decodeUcs2Hex(body);
    messages.push({
      index: Number.isFinite(index) ? index : null,
      status: String(status).replace(/^"|"$/g, ''),
      sender: String(sender).replace(/^"|"$/g, ''),
      timestamp: String(timestamp).replace(/^"|"$/g, ''),
      body,
    });
  }
  return messages;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class AtModem {
  constructor() {
    this._port = null;
    this._serial = null;
    this._error = null;
    this._signal = null;
    this._operator = null;
    this._messages = [];
    this._busy = Promise.resolve();
    this._stopped = false;
  }

  _enqueue(fn) {
    const run = this._busy.then(() => fn());
    this._busy = run.catch(() => {});
    return run;
  }

  status() {
    return {
      connected: !!(this._serial && this._serial.isOpen),
      port: this._port,
      signal: this._signal,
      operator: this._operator,
      error: this._error,
      atHint: AT_PORT_HINT,
    };
  }

  messages() {
    return this._messages.slice();
  }

  async stop() {
    this._stopped = true;
    await this._disconnect();
  }

  async _disconnect() {
    if (this._serial) {
      try {
        if (this._serial.isOpen) {
          await new Promise((r) => this._serial.close(() => r()));
        }
      } catch {
        /* ignore */
      }
    }
    this._serial = null;
  }

  async _readResponse(timeoutMs, { expectPrompt = false } = {}) {
    if (!this._serial || !this._serial.isOpen) {
      throw new Error('串口未连接');
    }
    const deadline = Date.now() + timeoutMs;
    let buf = Buffer.alloc(0);
    while (Date.now() < deadline && !this._stopped) {
      const chunk = this._serial.read();
      if (chunk && chunk.length) {
        buf = Buffer.concat([buf, chunk]);
        const text = buf.toString('utf8');
        if (expectPrompt && /(?:^|\r?\n)>\s*$/.test(text)) return text;
        if (/(?:^|\r?\n)(?:OK|ERROR|\+CMS ERROR:.*|\+CME ERROR:.*)\r?\n?$/.test(text)) {
          return text;
        }
      } else {
        await sleep(30);
      }
    }
    const text = buf.toString('utf8');
    throw new Error(`AT timeout: ${text.slice(0, 200)}`);
  }

  async _command(command, { timeout = 5000, expectPrompt = false } = {}) {
    if (!this._serial || !this._serial.isOpen) {
      throw new Error('串口未连接');
    }
    this._serial.write(`${command}\r`);
    await new Promise((resolve, reject) => {
      this._serial.drain((err) => (err ? reject(err) : resolve()));
    });
    const response = await this._readResponse(timeout, { expectPrompt });
    if (/(?:^|\r?\n)(?:ERROR|\+CMS ERROR:|\+CME ERROR:)/.test(response)) {
      throw new Error(response.trim().slice(0, 300));
    }
    return response;
  }

  connect() {
    return this._enqueue(() => this._connectLocked());
  }

  async _connectLocked() {
    await this._disconnect();
    const ports = await listSerialPorts();
    const match = findAtPort(ports);
    if (!match) {
      this._port = null;
      this._error = `未检测到 ${AT_PORT_HINT}`;
      return this.status();
    }
    this._port = match.device;
    this._error = `正在初始化 ${this._port}`;
    try {
      this._serial = new SerialPort({
        path: this._port,
        baudRate: BAUD,
        autoOpen: false,
      });
      await new Promise((resolve, reject) => {
        this._serial.open((err) => (err ? reject(err) : resolve()));
      });
      await sleep(250);
      try {
        this._serial.flush();
      } catch {
        /* ignore */
      }
      const cmds = [
        'ATE0',
        'AT+CMGF=1',
        'AT+CSCS="GSM"',
        'AT+CSDH=1',
        'AT+CPMS="SM","SM","SM"',
        'AT+CNMI=2,1,0,0,0',
      ];
      for (const cmd of cmds) {
        try {
          await this._command(cmd);
        } catch (exc) {
          if (cmd.includes('CPMS')) {
            try {
              await this._command('AT+CPMS="ME","ME","ME"');
            } catch {
              /* keep going */
            }
          } else {
            throw exc;
          }
        }
      }
      await this._refreshLocked();
      this._error = null;
    } catch (err) {
      this._error = String(err.message || err);
      await this._disconnect();
    }
    return this.status();
  }

  async _refreshLocked() {
    try {
      const csq = await this._command('AT+CSQ');
      const m = csq.match(/\+CSQ:\s*(\d+),\d+/);
      this._signal = m ? m[1] : null;
    } catch {
      this._signal = null;
    }
    try {
      const cops = await this._command('AT+COPS?');
      const m = cops.match(/\+COPS:.*?,"([^"]+)"/);
      this._operator = m ? m[1] : null;
    } catch {
      this._operator = null;
    }
    try {
      const raw = await this._command('AT+CMGL="ALL"', { timeout: 15000 });
      this._messages = parseCmgl(raw);
    } catch (err) {
      this._error = `读取短信失败: ${err.message || err}`;
    }
  }

  refresh() {
    return this._enqueue(async () => {
      if (!this._serial || !this._serial.isOpen) {
        return this._connectLocked().then(() => ({
          status: this.status(),
          messages: this.messages(),
        }));
      }
      try {
        await this._refreshLocked();
        if (this._error && !String(this._error).includes('读取短信')) {
          this._error = null;
        }
      } catch (err) {
        this._error = String(err.message || err);
      }
      return { status: this.status(), messages: this.messages() };
    });
  }

  send(recipient, text) {
    return this._enqueue(() => this._sendLocked(recipient, text));
  }

  async _sendLocked(recipient, text) {
    recipient = String(recipient || '').trim();
    text = String(text || '');
    if (!recipient || !text) throw new Error('号码和内容不能为空');
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');

    const useUcs2 = !isGsmText(text);
    let switched = false;
    try {
      let encTo;
      let payload;
      if (useUcs2) {
        await this._command('AT+CSCS="UCS2"');
        await this._command('AT+CSMP=17,167,0,8');
        switched = true;
        encTo = Buffer.from(recipient, 'utf16le').swap16().toString('hex').toUpperCase();
        payload = Buffer.from(
          Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase(),
          'ascii'
        );
      } else {
        encTo = recipient;
        payload = Buffer.from(text, 'ascii');
      }
      await this._command(`AT+CMGS="${encTo}"`, { timeout: 5000, expectPrompt: true });
      this._serial.write(Buffer.concat([payload, Buffer.from([0x1a])]));
      await new Promise((resolve, reject) => {
        this._serial.drain((err) => (err ? reject(err) : resolve()));
      });
      const response = await this._readResponse(SMS_SUBMIT_TIMEOUT_MS);
      if (/(?:^|\r?\n)(?:ERROR|\+CMS ERROR:|\+CME ERROR:)/.test(response)) {
        throw new Error(response.trim().slice(0, 300));
      }
      if (!/\+CMGS:\s*\d+/.test(response)) {
        throw new Error('未收到 +CMGS 确认');
      }
      return { ok: true };
    } finally {
      if (switched && this._serial && this._serial.isOpen) {
        try {
          await this._command('AT+CSCS="GSM"');
          await this._command('AT+CSMP=17,167,0,0');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

module.exports = {
  AtModem,
  parseCmgl,
  isGsmText,
  decodeUcs2Hex,
};
