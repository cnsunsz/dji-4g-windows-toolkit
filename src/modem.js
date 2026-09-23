'use strict';

const { SerialPort } = require('serialport');
const { AT_PORT_HINT, findAtPort, listSerialPorts } = require('./device');
const {
  encodeSubmitPdu,
  parseCmglPdu,
  parseCmgrPdu,
  reassembleConcat,
} = require('./pdu');

const SMS_SUBMIT_TIMEOUT_MS = 60000;
const BAUD = 115200;
const STORAGES = ['SM', 'ME', 'MT'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

function firstMatch(text, re) {
  const m = String(text || '').match(re);
  return m ? m[1] : null;
}

class AtModem {
  constructor() {
    this._port = null;
    this._serial = null;
    this._error = null;
    this._signal = null;
    this._operator = null;
    this._ownNumber = null;
    this._iccid = null;
    this._imsi = null;
    this._csca = null;
    this._creg = null;
    this._cereg = null;
    this._imsEnable = null;
    this._imsRegistered = null;
    this._messages = [];
    this._busy = Promise.resolve();
    this._stopped = false;
    this._rxBuf = '';
    this._awaitingResponse = false;
    this._cmtiQueue = [];
    this._onUrc = null;
    this._dataHandler = null;
  }

  setUrcHandler(fn) {
    this._onUrc = typeof fn === 'function' ? fn : null;
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
      ownNumber: this._ownNumber,
      iccid: this._iccid,
      imsi: this._imsi,
      csca: this._csca,
      creg: this._creg,
      cereg: this._cereg,
      imsEnable: this._imsEnable,
      imsRegistered: this._imsRegistered,
      error: this._error,
      atHint: AT_PORT_HINT,
      mode: 'PDU',
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
        if (this._dataHandler) {
          this._serial.off('data', this._dataHandler);
          this._dataHandler = null;
        }
        if (this._serial.isOpen) {
          await new Promise((r) => this._serial.close(() => r()));
        }
      } catch {
        /* ignore */
      }
    }
    this._serial = null;
    this._rxBuf = '';
    this._awaitingResponse = false;
  }

  _attachDataListener() {
    if (!this._serial) return;
    if (this._dataHandler) {
      this._serial.off('data', this._dataHandler);
    }
    this._dataHandler = (chunk) => {
      this._rxBuf += chunk.toString('utf8');
      if (!this._awaitingResponse) {
        this._drainUrcs();
      }
    };
    this._serial.on('data', this._dataHandler);
  }

  _drainUrcs() {
    // Pull +CMTI: lines out of the idle buffer.
    const re = /\+CMTI:\s*"([^"]+)"\s*,\s*(\d+)/g;
    let m;
    const kept = this._rxBuf;
    const found = [];
    while ((m = re.exec(kept)) !== null) {
      found.push({ storage: m[1], index: parseInt(m[2], 10) });
    }
    if (found.length) {
      this._rxBuf = this._rxBuf.replace(/\+CMTI:\s*"[^"]+"\s*,\s*\d+\r?\n?/g, '');
      for (const item of found) {
        this._cmtiQueue.push(item);
        if (this._onUrc) {
          try {
            this._onUrc({ type: 'CMTI', ...item });
          } catch {
            /* ignore */
          }
        }
      }
      // Schedule read without blocking current callers.
      this._enqueue(() => this._handleCmtiQueue());
    }
  }

  async _handleCmtiQueue() {
    while (this._cmtiQueue.length && this._serial && this._serial.isOpen) {
      const item = this._cmtiQueue.shift();
      try {
        await this._command(`AT+CPMS="${item.storage}","${item.storage}","${item.storage}"`);
        const raw = await this._command(`AT+CMGR=${item.index}`, { timeout: 10000 });
        const msg = parseCmgrPdu(raw);
        if (msg) {
          const entry = {
            ...msg,
            index: item.index,
            storage: item.storage,
          };
          // Replace same storage+index or append
          const idx = this._messages.findIndex(
            (m) => m.storage === entry.storage && m.index === entry.index
          );
          if (idx >= 0) this._messages[idx] = entry;
          else this._messages.unshift(entry);
          this._messages = reassembleConcat(this._messages);
        }
      } catch (err) {
        this._error = `CMTI 读取失败: ${err.message || err}`;
      }
    }
  }

  async _readResponse(timeoutMs, { expectPrompt = false } = {}) {
    if (!this._serial || !this._serial.isOpen) {
      throw new Error('串口未连接');
    }
    const deadline = Date.now() + timeoutMs;
    this._awaitingResponse = true;
    try {
      while (Date.now() < deadline && !this._stopped) {
        const text = this._rxBuf;
        if (expectPrompt && /(?:^|\r?\n)>\s*$/.test(text)) {
          const out = this._rxBuf;
          this._rxBuf = '';
          return out;
        }
        // Complete final result line present
        if (
          /(?:^|\r?\n)(?:OK|ERROR|\+CMS ERROR:[^\r\n]*|\+CME ERROR:[^\r\n]*)\r?\n/.test(text) ||
          /(?:^|\r?\n)(?:OK|ERROR|\+CMS ERROR:[^\r\n]*|\+CME ERROR:[^\r\n]*)$/.test(text.trimEnd())
        ) {
          const out = this._rxBuf;
          this._rxBuf = '';
          return out;
        }
        await sleep(30);
      }
      const text = this._rxBuf;
      this._rxBuf = '';
      throw new Error(`AT timeout: ${text.slice(0, 200)}`);
    } finally {
      this._awaitingResponse = false;
      // URCs may have arrived mixed; drain leftover CMTI after response
      this._drainUrcs();
    }
  }

  async _command(command, { timeout = 5000, expectPrompt = false } = {}) {
    if (!this._serial || !this._serial.isOpen) {
      throw new Error('串口未连接');
    }
    this._rxBuf = '';
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
      this._rxBuf = '';
      this._attachDataListener();

      // PDU mode like common AT/modem SMS tools (CMGF=0 + CNMI).
      const cmds = ['ATE0', 'AT+CMGF=0', 'AT+CNMI=2,1,0,0,0'];
      for (const cmd of cmds) {
        await this._command(cmd);
      }
      // Prefer SM as primary read/write storage; fall back to ME.
      try {
        await this._command('AT+CPMS="SM","SM","SM"');
      } catch {
        try {
          await this._command('AT+CPMS="ME","ME","ME"');
        } catch {
          /* keep going */
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

  async _safeQuery(cmd, parseFn, timeout = 5000) {
    try {
      const raw = await this._command(cmd, { timeout });
      return parseFn(raw);
    } catch {
      return null;
    }
  }

  async _readIdentityLocked() {
    this._ownNumber = await this._safeQuery('AT+CNUM', (raw) => {
      // +CNUM: "", "+4474...", type
      const m = raw.match(/\+CNUM:\s*(?:"[^"]*"\s*,\s*)?"([^"]+)"/);
      return m ? m[1] : null;
    });

    this._iccid = await this._safeQuery('AT+QCCID', (raw) => {
      return firstMatch(raw, /\+QCCID:\s*([0-9A-Fa-f]+)/) || firstMatch(raw, /\b(89\d{15,20})\b/);
    });
    if (!this._iccid) {
      this._iccid = await this._safeQuery('AT+CCID', (raw) => {
        return (
          firstMatch(raw, /\+CCID:\s*"?([0-9A-Fa-f]+)"?/) ||
          firstMatch(raw, /\b(89\d{15,20})\b/)
        );
      });
    }

    this._imsi = await this._safeQuery('AT+CIMI', (raw) => {
      const m = raw.match(/(?:^|\n)\s*(\d{14,16})\s*(?:\n|$)/);
      return m ? m[1] : null;
    });

    this._csca = await this._safeQuery('AT+CSCA?', (raw) => {
      const m = raw.match(/\+CSCA:\s*"([^"]+)"/);
      return m ? m[1] : null;
    });

    this._creg = await this._safeQuery('AT+CREG?', (raw) => {
      const m = raw.match(/\+CREG:\s*(\d+)\s*,\s*(\d+)/);
      return m ? `${m[1]},${m[2]}` : firstMatch(raw, /\+CREG:\s*([^\r\n]+)/);
    });

    this._cereg = await this._safeQuery('AT+CEREG?', (raw) => {
      const m = raw.match(/\+CEREG:\s*(\d+)\s*,\s*(\d+)/);
      return m ? `${m[1]},${m[2]}` : firstMatch(raw, /\+CEREG:\s*([^\r\n]+)/);
    });

    await this._readImsLocked();
  }

  async _readImsLocked() {
    const ims = await this._safeQuery('AT+QCFG="ims"', (raw) => {
      // +QCFG: "ims",<enable>,<registered>
      const m = raw.match(/\+QCFG:\s*"ims"\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (m) return { enable: parseInt(m[1], 10), registered: parseInt(m[2], 10) };
      const m2 = raw.match(/\+QCFG:\s*"ims"\s*,\s*(\d+)/i);
      if (m2) return { enable: parseInt(m2[1], 10), registered: null };
      return null;
    });
    if (ims) {
      this._imsEnable = ims.enable;
      this._imsRegistered = ims.registered;
    } else {
      this._imsEnable = null;
      this._imsRegistered = null;
    }
  }

  async _listPduStorage(storage) {
    await this._command(`AT+CPMS="${storage}","${storage}","${storage}"`);
    const raw = await this._command('AT+CMGL=4', { timeout: 20000 });
    const msgs = parseCmglPdu(raw);
    for (const m of msgs) m.storage = storage;
    return msgs;
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

    await this._readIdentityLocked();

    const all = [];
    const seen = new Set();
    for (const storage of STORAGES) {
      try {
        const msgs = await this._listPduStorage(storage);
        for (const msg of msgs) {
          const key = `${msg.storage}:${msg.index}:${msg.pdu || msg.body}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(msg);
        }
      } catch {
        // storage may be unsupported — skip
      }
    }
    this._messages = reassembleConcat(all);
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
        if (this._error && !String(this._error).includes('读取')) {
          this._error = null;
        }
      } catch (err) {
        this._error = String(err.message || err);
      }
      return { status: this.status(), messages: this.messages() };
    });
  }

  enableIms({ reboot = false } = {}) {
    return this._enqueue(() => this._enableImsLocked(reboot));
  }

  async _enableImsLocked(reboot) {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    await this._command('AT+QCFG="ims",1');
    await this._readImsLocked();
    let rebooting = false;
    if (reboot) {
      rebooting = true;
      try {
        // Soft reboot; port will drop.
        this._serial.write('AT+CFUN=1,1\r');
        await new Promise((resolve, reject) => {
          this._serial.drain((err) => (err ? reject(err) : resolve()));
        });
      } catch {
        /* ignore */
      }
      await sleep(500);
      await this._disconnect();
      this._error = '已发送软重启 (AT+CFUN=1,1)，请等待模组重新枚举后点「重新连接」';
    }
    return {
      status: this.status(),
      messages: this.messages(),
      rebooting,
    };
  }

  send(recipient, text) {
    return this._enqueue(() => this._sendLocked(recipient, text));
  }

  async _sendLocked(recipient, text) {
    recipient = String(recipient || '').trim();
    text = String(text || '');
    if (!recipient || !text) throw new Error('号码和内容不能为空');
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');

    // Prefer PDU submit (parity with macOS AT tools); clean 3GPP encoding.
    const { pduHex, tpduLen } = encodeSubmitPdu(recipient, text);
    await this._command('AT+CMGF=0');
    await this._command(`AT+CMGS=${tpduLen}`, { timeout: 5000, expectPrompt: true });
    this._serial.write(Buffer.from(`${pduHex}\x1a`, 'ascii'));
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
  }
}

module.exports = {
  AtModem,
  parseCsvFields,
};
