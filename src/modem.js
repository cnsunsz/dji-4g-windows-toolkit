'use strict';

const { SerialPort } = require('serialport');
const { AT_PORT_HINT, findAtPort, listSerialPorts, normalizeVidPid } = require('./device');
const {
  encodeSubmitPdu,
  parseCmglPdu,
  parseCmgrPdu,
  reassembleConcat,
  canEncodeGsm7,
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
    this._vidPid = null;
    this._adapterHint = null;
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
    // Voice / call (experimental)
    this._callState = 'idle'; // idle | dialing | ringing | active | ending
    this._callNumber = null;
    this._callClip = null;
    this._callLog = [];
    this._usbcfgRaw = null;
    this._usbcfgUac = null;
    this._usbcfgPrev = null;
    this._qpcmvOk = null;
    this._qpcmvError = null;
    this._lastUssd = null;
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
      vidPid: this._vidPid,
      adapterHint: this._adapterHint,
      signal: this._signal,
      operator: this._operator,
      ownNumber: this._ownNumber, // CNUM only; may be empty on CMCC
      cnum: this._ownNumber,
      iccid: this._iccid,
      imsi: this._imsi,
      csca: this._csca,
      creg: this._creg,
      cereg: this._cereg,
      imsEnable: this._imsEnable,
      imsRegistered: this._imsRegistered,
      callState: this._callState,
      callNumber: this._callNumber,
      callClip: this._callClip,
      callLog: this._callLog.slice(-40),
      usbcfgRaw: this._usbcfgRaw,
      usbcfgUac: this._usbcfgUac,
      usbcfgPrev: this._usbcfgPrev,
      qpcmvOk: this._qpcmvOk,
      qpcmvError: this._qpcmvError,
      lastUssd: this._lastUssd,
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

  _emitUrc(payload) {
    if (!this._onUrc) return;
    try {
      this._onUrc(payload);
    } catch {
      /* ignore */
    }
  }

  _pushCallLog(line) {
    const entry = { t: Date.now(), line: String(line || '') };
    this._callLog.push(entry);
    if (this._callLog.length > 80) this._callLog.splice(0, this._callLog.length - 80);
  }

  _setCallState(state, extra = {}) {
    this._callState = state;
    if (extra.number !== undefined) this._callNumber = extra.number;
    if (extra.clip !== undefined) this._callClip = extra.clip;
    this._emitUrc({ type: 'CALL', state, number: this._callNumber, clip: this._callClip, ...extra });
  }

  _drainUrcs() {
    // Pull known URCs out of the idle buffer (CMTI + voice + USSD leftovers).
    let buf = this._rxBuf;
    let changed = false;

    // +CMTI
    const cmtiRe = /\+CMTI:\s*"([^"]+)"\s*,\s*(\d+)\r?\n?/g;
    let m;
    const cmtiFound = [];
    while ((m = cmtiRe.exec(buf)) !== null) {
      cmtiFound.push({ storage: m[1], index: parseInt(m[2], 10) });
    }
    if (cmtiFound.length) {
      buf = buf.replace(/\+CMTI:\s*"[^"]+"\s*,\s*\d+\r?\n?/g, '');
      changed = true;
      for (const item of cmtiFound) {
        this._cmtiQueue.push(item);
        this._emitUrc({ type: 'CMTI', ...item });
      }
      this._enqueue(() => this._handleCmtiQueue());
    }

    // RING
    if (/(?:^|\r?\n)RING\r?\n?/.test(buf)) {
      buf = buf.replace(/(?:^|\r?\n)RING\r?\n?/g, '\n');
      changed = true;
      this._pushCallLog('RING');
      this._setCallState('ringing');
    }

    // +CLIP: "<number>",<type>
    const clipMatches = [];
    const clipScan = /\+CLIP:\s*"([^"]*)"\s*,\s*(\d+)[^\r\n]*\r?\n?/g;
    while ((m = clipScan.exec(buf)) !== null) {
      clipMatches.push(m[1]);
    }
    if (clipMatches.length) {
      buf = buf.replace(/\+CLIP:\s*"[^"]*"\s*,\s*\d+[^\r\n]*\r?\n?/g, '');
      changed = true;
      const num = clipMatches[clipMatches.length - 1];
      this._callClip = num;
      this._pushCallLog(`+CLIP ${num}`);
      this._setCallState(this._callState === 'idle' ? 'ringing' : this._callState, { clip: num });
    }

    // CONNECT / NO CARRIER / BUSY / NO ANSWER
    if (/(?:^|\r?\n)CONNECT\b/.test(buf)) {
      buf = buf.replace(/(?:^|\r?\n)CONNECT[^\r\n]*\r?\n?/g, '\n');
      changed = true;
      this._pushCallLog('CONNECT');
      this._setCallState('active');
    }
    if (/(?:^|\r?\n)NO CARRIER\b/.test(buf)) {
      buf = buf.replace(/(?:^|\r?\n)NO CARRIER\r?\n?/g, '\n');
      changed = true;
      this._pushCallLog('NO CARRIER');
      this._setCallState('idle', { number: null, clip: this._callClip });
    }
    if (/(?:^|\r?\n)BUSY\b/.test(buf)) {
      buf = buf.replace(/(?:^|\r?\n)BUSY\r?\n?/g, '\n');
      changed = true;
      this._pushCallLog('BUSY');
      this._setCallState('idle', { number: null });
    }
    if (/(?:^|\r?\n)NO ANSWER\b/.test(buf)) {
      buf = buf.replace(/(?:^|\r?\n)NO ANSWER\r?\n?/g, '\n');
      changed = true;
      this._pushCallLog('NO ANSWER');
      this._setCallState('idle', { number: null });
    }

    // +CUSD leftover URC (when not awaited)
    const cusdRe = /\+CUSD:\s*([^\r\n]+)\r?\n?/g;
    const cusdBits = [];
    while ((m = cusdRe.exec(buf)) !== null) cusdBits.push(m[1]);
    if (cusdBits.length) {
      buf = buf.replace(/\+CUSD:\s*[^\r\n]+\r?\n?/g, '');
      changed = true;
      const raw = cusdBits[cusdBits.length - 1];
      this._lastUssd = { raw, at: Date.now() };
      this._emitUrc({ type: 'CUSD', raw });
    }

    if (changed) this._rxBuf = buf.replace(/^\n+/, '');
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
          this._emitUrc({ type: 'SMS_NEW', message: entry, storage: entry.storage, index: entry.index });
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
    this._vidPid = normalizeVidPid(match.vid, match.pid);
    const desc = String(match.description || '');
    if (/百旺|baiwang|wwan|ndis|qdc507|cellular/i.test(desc)) {
      this._adapterHint = desc.slice(0, 80);
    } else if (this._vidPid) {
      this._adapterHint = `USB ${this._vidPid}`;
    } else {
      this._adapterHint = null;
    }
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
      // CLIP=1 for caller ID on voice URCs (common Mac-tool AT practice).
      const cmds = ['ATE0', 'AT+CMGF=0', 'AT+CNMI=2,1,0,0,0', 'AT+CLIP=1'];
      for (const cmd of cmds) {
        try {
          await this._command(cmd);
        } catch (err) {
          if (cmd === 'AT+CLIP=1') {
            /* CLIP optional on some firmwares */
          } else {
            throw err;
          }
        }
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
    await this._readUsbcfgLocked();
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


  callStatus() {
    return {
      status: this.status(),
      callState: this._callState,
      callNumber: this._callNumber,
      callClip: this._callClip,
      callLog: this._callLog.slice(-40),
    };
  }

  async _readUsbcfgLocked() {
    const raw = await this._safeQuery('AT+QCFG="usbcfg"', (r) => r, 5000);
    if (!raw) {
      this._usbcfgRaw = null;
      this._usbcfgUac = null;
      return null;
    }
    const line = firstMatch(raw, /\+QCFG:\s*"usbcfg"\s*,\s*([^\r\n]+)/i) || raw.trim();
    this._usbcfgRaw = line;
    // Last CSV field is commonly the UAC flag on Quectel modules.
    const fields = parseCsvFields(line.replace(/^\+QCFG:\s*"usbcfg"\s*,\s*/i, ''));
    const last = fields.length ? fields[fields.length - 1].trim() : '';
    const uacNum = last === '' ? null : parseInt(last, 10);
    this._usbcfgUac = Number.isFinite(uacNum) ? uacNum : null;
    return { raw: line, fields, uac: this._usbcfgUac };
  }

  dial(number) {
    return this._enqueue(() => this._dialLocked(number));
  }

  async _dialLocked(number) {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    const num = String(number || '').trim().replace(/[^\d+*#]/g, '');
    if (!num) throw new Error('请输入号码');
    if (this._imsRegistered !== 1) {
      // Soft warn — still allow attempt; UI should warn harder.
      this._pushCallLog('警告: IMS 未注册，拨号可能失败');
    }
    this._callNumber = num;
    this._callClip = null;
    this._setCallState('dialing', { number: num });
    this._pushCallLog(`ATD${num};`);
    try {
      // Voice call: trailing semicolon (3GPP ATD voice).
      await this._command(`ATD${num};`, { timeout: 15000 });
      this._pushCallLog('ATD OK');
      return { ok: true, status: this.status() };
    } catch (err) {
      this._setCallState('idle', { number: null });
      this._pushCallLog(`ATD 失败: ${err.message || err}`);
      throw err;
    }
  }

  answer() {
    return this._enqueue(() => this._answerLocked());
  }

  async _answerLocked() {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    this._pushCallLog('ATA');
    await this._command('ATA', { timeout: 10000 });
    this._setCallState('active');
    this._pushCallLog('ATA OK');
    return { ok: true, status: this.status() };
  }

  hangup() {
    return this._enqueue(() => this._hangupLocked());
  }

  async _hangupLocked() {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    this._pushCallLog('ATH');
    this._setCallState('ending');
    try {
      await this._command('ATH', { timeout: 10000 });
    } catch (err) {
      // Some firmwares return NO CARRIER instead of OK on ATH.
      const msg = String(err.message || err);
      if (!/NO CARRIER/i.test(msg)) throw err;
    }
    this._setCallState('idle', { number: null });
    this._pushCallLog('挂断');
    return { ok: true, status: this.status() };
  }

  sendUssd(code) {
    return this._enqueue(() => this._sendUssdLocked(code));
  }

  async _sendUssdLocked(code) {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    const ussd = String(code || '').trim();
    if (!ussd) throw new Error('USSD 码不能为空');
    // AT+CUSD=1,"*208#",15 — DCS 15 = GSM7 default alphabet
    this._rxBuf = '';
    this._serial.write(`AT+CUSD=1,"${ussd.replace(/"/g, '')}",15\r`);
    await new Promise((resolve, reject) => {
      this._serial.drain((err) => (err ? reject(err) : resolve()));
    });

    const deadline = Date.now() + 45000;
    this._awaitingResponse = true;
    let gotOk = false;
    let cusdRaw = null;
    try {
      while (Date.now() < deadline && !this._stopped) {
        const text = this._rxBuf;
        if (!gotOk && /(?:^|\r?\n)OK\r?\n/.test(text)) gotOk = true;
        if (/(?:^|\r?\n)(?:ERROR|\+CME ERROR:)/.test(text)) {
          const err = text.trim().slice(0, 300);
          this._rxBuf = '';
          throw new Error(err);
        }
        const m = text.match(/\+CUSD:\s*([^\r\n]+)/);
        if (m) {
          cusdRaw = m[1];
          this._rxBuf = '';
          break;
        }
        await sleep(40);
      }
    } finally {
      this._awaitingResponse = false;
      this._drainUrcs();
    }
    if (!cusdRaw) {
      // Some modules only return OK; leave raw empty.
      if (!gotOk) throw new Error('USSD 超时');
      cusdRaw = '(无 +CUSD 正文，仅收到 OK)';
    }
    // Decode quoted UCS2 hex if present: +CUSD: 0,"00410042",72
    let textOut = cusdRaw;
    const qm = cusdRaw.match(/^(?:\d+\s*,\s*)?"([0-9A-Fa-f]*)"\s*(?:,\s*(\d+))?/);
    if (qm && qm[1] && /^[0-9A-Fa-f]*$/.test(qm[1]) && qm[1].length >= 4 && qm[1].length % 4 === 0) {
      try {
        const hex = qm[1];
        const buf = Buffer.from(hex, 'hex');
        // UCS2 BE
        textOut = buf.swap16().toString('utf16le');
      } catch {
        textOut = cusdRaw;
      }
    } else {
      const qm2 = cusdRaw.match(/^(?:\d+\s*,\s*)?"([^"]*)"/);
      if (qm2) textOut = qm2[1];
    }
    this._lastUssd = { code: ussd, raw: cusdRaw, text: textOut, at: Date.now() };
    return {
      ok: true,
      code: ussd,
      raw: cusdRaw,
      text: textOut,
      status: this.status(),
    };
  }

  queryUsbcfg() {
    return this._enqueue(async () => {
      if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
      const info = await this._readUsbcfgLocked();
      return { ok: true, ...(info || {}), status: this.status() };
    });
  }

  /**
   * Set usbcfg last flag (UAC) to 1. Saves previous raw field list for restore.
   * Requires module reboot to take effect — caller must confirm in UI.
   */
  enableUsbAudio({ reboot = false } = {}) {
    return this._enqueue(() => this._enableUsbAudioLocked(reboot));
  }

  async _enableUsbAudioLocked(reboot) {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    const info = await this._readUsbcfgLocked();
    if (!info || !info.fields || !info.fields.length) {
      throw new Error('无法读取 AT+QCFG="usbcfg"');
    }
    this._usbcfgPrev = {
      fields: info.fields.slice(),
      uac: info.uac,
      raw: info.raw,
      at: Date.now(),
    };
    const next = info.fields.slice();
    next[next.length - 1] = '1';
    const arg = next.join(',');
    await this._command(`AT+QCFG="usbcfg",${arg}`, { timeout: 8000 });
    await this._readUsbcfgLocked();
    let rebooting = false;
    if (reboot) {
      rebooting = true;
      try {
        this._serial.write('AT+CFUN=1,1\r');
        await new Promise((resolve, reject) => {
          this._serial.drain((err) => (err ? reject(err) : resolve()));
        });
      } catch {
        /* ignore */
      }
      await sleep(500);
      await this._disconnect();
      this._error = '已修改 usbcfg UAC=1 并软重启，请等待模组重新枚举后点「重新连接」';
    }
    return {
      ok: true,
      previous: this._usbcfgPrev,
      status: this.status(),
      rebooting,
      note: 'UAC 变更通常需重启模组后生效',
    };
  }

  restoreUsbcfg({ reboot = false } = {}) {
    return this._enqueue(() => this._restoreUsbcfgLocked(reboot));
  }

  async _restoreUsbcfgLocked(reboot) {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    if (!this._usbcfgPrev || !this._usbcfgPrev.fields) {
      throw new Error('无已保存的 usbcfg 旧值可恢复（本次会话内未改过）');
    }
    const arg = this._usbcfgPrev.fields.join(',');
    await this._command(`AT+QCFG="usbcfg",${arg}`, { timeout: 8000 });
    await this._readUsbcfgLocked();
    let rebooting = false;
    if (reboot) {
      rebooting = true;
      try {
        this._serial.write('AT+CFUN=1,1\r');
        await new Promise((resolve, reject) => {
          this._serial.drain((err) => (err ? reject(err) : resolve()));
        });
      } catch {
        /* ignore */
      }
      await sleep(500);
      await this._disconnect();
      this._error = '已恢复 usbcfg 并软重启，请等待模组重新枚举后点「重新连接」';
    }
    return { ok: true, status: this.status(), rebooting };
  }

  tryQpcmv() {
    return this._enqueue(() => this._tryQpcmvLocked());
  }

  async _tryQpcmvLocked() {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    // Quectel PCM/UAC voice path; many QDC507 builds return ERROR.
    try {
      await this._command('AT+QPCMV=1,2', { timeout: 5000 });
      this._qpcmvOk = true;
      this._qpcmvError = null;
      return {
        ok: true,
        qpcmvOk: true,
        message: 'AT+QPCMV=1,2 已接受',
        status: this.status(),
      };
    } catch (err) {
      this._qpcmvOk = false;
      this._qpcmvError = String(err.message || err);
      return {
        ok: false,
        qpcmvOk: false,
        error: this._qpcmvError,
        message:
          '本机固件可能无 UAC/QPCMV，通话控制可用但电脑音频可能无声',
        status: this.status(),
      };
    }
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

  async _sendPduOnce(recipient, text) {
    const { pduHex, tpduLen } = encodeSubmitPdu(recipient, text);
    await this._command('AT+CMGF=0');
    await this._command(`AT+CMGS=${tpduLen}`, { timeout: 5000, expectPrompt: true });
    this._serial.write(Buffer.from(`${pduHex}\x1a`, 'ascii'));
    await new Promise((resolve, reject) => {
      this._serial.drain((err) => (err ? reject(err) : resolve()));
    });
    const response = await this._readResponse(SMS_SUBMIT_TIMEOUT_MS);
    if (/(?:^|\r?\n)(?:ERROR|\+CMS ERROR:|\+CME ERROR:)/.test(response)) {
      const errText = response.trim().slice(0, 300);
      const err = new Error(errText);
      err.cms = /\+CMS ERROR:/i.test(errText);
      err.raw = errText;
      throw err;
    }
    if (!/\+CMGS:\s*\d+/.test(response)) {
      throw new Error('未收到 +CMGS 确认');
    }
    return { ok: true, mode: 'PDU' };
  }

  async _sendTextFallback(recipient, text) {
    const useUcs2 = !canEncodeGsm7(text);
    let switched = false;
    try {
      await this._command('AT+CMGF=1');
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
        try {
          await this._command('AT+CSCS="GSM"');
        } catch {
          /* keep current CSCS */
        }
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
        throw new Error('未收到 +CMGS 确认（文本模式）');
      }
      return { ok: true, mode: 'TEXT' };
    } finally {
      if (switched && this._serial && this._serial.isOpen) {
        try {
          await this._command('AT+CSCS="GSM"');
          await this._command('AT+CSMP=17,167,0,0');
        } catch {
          /* ignore */
        }
      }
      if (this._serial && this._serial.isOpen) {
        try {
          await this._command('AT+CMGF=0');
        } catch {
          /* ignore */
        }
      }
    }
  }

  async _sendLocked(recipient, text) {
    recipient = String(recipient || '').trim();
    text = String(text || '');
    if (!recipient || !text) throw new Error('号码和内容不能为空');
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');

    try {
      return await this._sendPduOnce(recipient, text);
    } catch (err) {
      const msg = String(err.message || err);
      const isCms = err.cms || /\+CMS ERROR:/i.test(msg);
      if (!isCms) throw err;
      try {
        return await this._sendTextFallback(recipient, text);
      } catch (fallbackErr) {
        throw new Error(
          `PDU 发送失败（${msg.slice(0, 120)}）；文本模式回退也失败：${String(fallbackErr.message || fallbackErr).slice(0, 200)}`
        );
      }
    }
  }

  deleteMessage({ storage, index } = {}) {
    return this._enqueue(() => this._deleteMessageLocked(storage, index));
  }

  async _deleteMessageLocked(storage, index) {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    const stor = String(storage || 'SM').toUpperCase();
    // Reassembled concat may use "1+2+3" index string.
    const indexes = String(index ?? '')
      .split('+')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => parseInt(s, 10));
    if (!indexes.length) throw new Error('无效的短信索引');
    await this._command(`AT+CPMS="${stor}","${stor}","${stor}"`);
    for (const idx of indexes) {
      await this._command(`AT+CMGD=${idx}`, { timeout: 10000 });
    }
    await this._refreshLocked();
    return { ok: true, status: this.status(), messages: this.messages() };
  }

  deleteMessages(items) {
    return this._enqueue(() => this._deleteMessagesLocked(items));
  }

  async _deleteMessagesLocked(items) {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    const list = Array.isArray(items) ? items : [];
    if (!list.length) throw new Error('未选择要删除的短信');

    // Expand concat indexes; group by storage to minimize CPMS switches.
    const byStorage = new Map();
    for (const it of list) {
      const stor = String(it?.storage || 'SM').toUpperCase();
      const indexes = String(it?.index ?? '')
        .split('+')
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .map((s) => parseInt(s, 10));
      if (!indexes.length) continue;
      if (!byStorage.has(stor)) byStorage.set(stor, new Set());
      for (const idx of indexes) byStorage.get(stor).add(idx);
    }
    if (!byStorage.size) throw new Error('无效的短信索引');

    for (const [stor, idxSet] of byStorage) {
      await this._command(`AT+CPMS="${stor}","${stor}","${stor}"`);
      for (const idx of [...idxSet].sort((a, b) => a - b)) {
        await this._command(`AT+CMGD=${idx}`, { timeout: 10000 });
      }
    }
    await this._refreshLocked();
    return { ok: true, status: this.status(), messages: this.messages() };
  }

  deleteAll({ storage } = {}) {
    return this._enqueue(() => this._deleteAllLocked(storage));
  }

  async _deleteAllLocked(storage) {
    if (!this._serial || !this._serial.isOpen) throw new Error('设备未连接');
    const stor = String(storage || 'SM').toUpperCase();
    // AT+CMGD=<index>,4 — delflag 4 deletes all messages in current storage
    await this._command(`AT+CPMS="${stor}","${stor}","${stor}"`);
    await this._command('AT+CMGD=1,4', { timeout: 30000 });
    await this._refreshLocked();
    return { ok: true, status: this.status(), messages: this.messages() };
  }

  /** Interactive AT console: return raw response; ERROR payloads returned as ok:false. */
  atRaw(command, opts = {}) {
    return this._enqueue(() => this._atRawLocked(command, opts));
  }

  async _atRawLocked(command, { timeout = 10000 } = {}) {
    if (!this._serial || !this._serial.isOpen) {
      throw new Error('设备未连接');
    }
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('请输入 AT 命令');
    const upper = cmd.toUpperCase();
    if (upper.startsWith('AT+CMGS') || upper.startsWith('AT+CUSD') || upper.startsWith('ATD')) {
      throw new Error('该命令请使用对应功能页，勿在调试台发送（避免交互/挂起）');
    }
    if (!/^AT/i.test(cmd) && cmd !== 'A/' && cmd !== 'a/') {
      throw new Error('仅允许 AT 开头的命令');
    }
    try {
      const raw = await this._command(cmd, { timeout });
      return { ok: true, command: cmd, raw: String(raw || '').trim(), status: this.status() };
    } catch (err) {
      const raw = String(err.message || err);
      return { ok: false, command: cmd, raw, error: raw, status: this.status() };
    }
  }
}

module.exports = {
  AtModem,
  parseCsvFields,
};
