'use strict';

const $ = (id) => document.getElementById(id);

const THEME_KEY = 'dji4g-toolkit-theme';
const VIEW_META = {
  overview: { title: '模块概览', sub: '运营商 / 信号 / SIM / IMS / 本机号码' },
  sms: { title: '短信', sub: 'PDU 收发 · SM / ME / MT · +CMTI 监听' },
  call: { title: '通话', sub: '实验功能 · AT 语音控制 · 音频路径视固件而定' },
  drivers: { title: '驱动', sub: 'Quectel qcser / qcmdm / qcfilter · 可选 qcwwan · 需 UAC' },
  diag: { title: '诊断', sub: 'USB / AT 口 / ATI · IMS 启用' },
};

const CALL_STATE_LABEL = {
  idle: '空闲',
  dialing: '拨号中',
  ringing: '振铃',
  active: '通话中',
  ending: '挂断中',
};

let refreshTimer = null;
let busy = false;
let lastStatus = null;
/** @type {Set<string>} */
let selectedSmsKeys = new Set();
let lastMessages = [];
/** Track ICCID so UI clears number field when SIM changes */
let uiIccid = null;
let lastDetectedNumbers = [];

function setBusy(isBusy) {
  busy = isBusy;
  for (const id of [
    'btnDrivers',
    'btnDriversWwan',
    'btnDetect',
    'btnSmsRefresh',
    'btnSmsReconnect',
    'btnSend',
    'btnSmsSelectAll',
    'btnSmsSelectNone',
    'btnSmsDeleteSelected',
    'btnSmsClearSm',
    'btnEnableIms',
    'btnEnableImsReboot',
    'btnMsisdnSave',
    'btnUssd',
    'btnDial',
    'btnAnswer',
    'btnHangup',
    'btnQueryUsbcfg',
    'btnEnableUsbAudio',
    'btnRestoreUsbcfg',
    'btnTryQpcmv',
  ]) {
    const el = $(id);
    if (el) el.disabled = isBusy;
  }
}

function appendLog(el, text) {
  const line = String(text || '').replace(/\s+$/, '');
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (_) {}
  const btn = $('btnTheme');
  if (btn) btn.textContent = next === 'dark' ? '深色' : '浅色';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

function switchView(name) {
  const key = VIEW_META[name] ? name : 'overview';
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('is-active', el.id === `view-${key}`);
  });
  document.querySelectorAll('.rail-item').forEach((btn) => {
    const on = btn.getAttribute('data-view') === key;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const meta = VIEW_META[key];
  $('pageTitle').textContent = meta.title;
  $('pageSub').textContent = meta.sub;
}

function imsLabel(s) {
  if (s.imsEnable == null && s.imsRegistered == null) return '(未知)';
  const en = s.imsEnable == null ? '?' : String(s.imsEnable);
  const reg = s.imsRegistered == null ? '?' : String(s.imsRegistered);
  const hint =
    s.imsEnable === 1 && s.imsRegistered === 1
      ? '已启用且已注册'
      : s.imsEnable === 1
        ? '已启用，未注册'
        : '未启用';
  return `${en},${reg}（${hint}）`;
}

function shortIccid(v) {
  const s = String(v || '');
  if (!s || s === '(无)') return s || '—';
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function setTile(field, text, tone) {
  const el = document.querySelector(`[data-field="${field}"]`);
  if (!el) return;
  el.textContent = text || '—';
  el.className = 'tile-v' + (tone ? ` is-${tone}` : '');
}

function sourcePillClass(source) {
  if (source === 'cnum') return 'source-pill is-cnum';
  if (source === 'saved') return 'source-pill is-saved';
  return 'source-pill is-none';
}

function sourceLabel(s) {
  if (!s) return '未设置';
  if (s.effectiveMsisdnLabel) return s.effectiveMsisdnLabel;
  if (s.effectiveMsisdnSource === 'cnum') return 'CNUM';
  if (s.effectiveMsisdnSource === 'saved') return '已保存';
  return '未设置';
}

function paintMsisdn(s) {
  const eff = (s && s.effectiveMsisdn) || null;
  const src = (s && s.effectiveMsisdnSource) || 'none';
  const label = sourceLabel(s);

  const effEl = $('msisdnEffective');
  if (effEl) effEl.textContent = eff || '未设置';

  const pill = $('msisdnSourcePill');
  if (pill) {
    pill.textContent = label;
    pill.className = sourcePillClass(src);
  }

  const smsNum = $('smsOwnNumber');
  if (smsNum) smsNum.textContent = eff || '未设置';
  const smsSrc = $('smsOwnSource');
  if (smsSrc) {
    smsSrc.textContent = label;
    smsSrc.className = sourcePillClass(src);
  }

  const note = $('msisdnSourceNote');
  if (note) {
    if (src === 'cnum') {
      note.textContent = '来自模组 AT+CNUM';
    } else if (src === 'saved') {
      note.textContent = 'CNUM 为空；显示已按 ICCID 保存的本机号码';
    } else {
      note.textContent = 'CNUM 为空且未保存；国内移动卡常见，可手动填写或 USSD 查号';
    }
  }

  const iccid = (s && s.iccid) || null;
  if (iccid !== uiIccid) {
    uiIccid = iccid;
    const input = $('msisdnInput');
    if (input) {
      // Clear until user saves again for this ICCID; prefill saved if any.
      input.value = (s && s.savedMsisdn) || '';
    }
  } else if (s && s.savedMsisdn && $('msisdnInput') && !$('msisdnInput').value) {
    $('msisdnInput').value = s.savedMsisdn;
  }
}

function paintCall(s) {
  if (!s) return;
  const imsOk = s.imsEnable === 1 && s.imsRegistered === 1;
  const warn = $('callImsWarn');
  if (warn) warn.hidden = !s.connected || imsOk;

  const imsLine = $('callImsLine');
  if (imsLine) imsLine.textContent = `IMS：${imsLabel(s)}`;

  const state = s.callState || 'idle';
  const pill = $('callStatePill');
  if (pill) {
    pill.textContent = CALL_STATE_LABEL[state] || state;
    pill.className =
      'call-state-pill' +
      (state === 'active' ? ' is-active' : state === 'ringing' || state === 'dialing' ? ' is-ringing' : '');
  }

  const clip = $('callClipLine');
  if (clip) {
    const who = s.callClip || s.callNumber || '—';
    clip.textContent = `来电显示 / 当前号码：${who}`;
  }

  const usbcfgLine = $('usbcfgLine');
  if (usbcfgLine) {
    if (s.usbcfgRaw) {
      usbcfgLine.textContent = `usbcfg：${s.usbcfgRaw} · UAC=${s.usbcfgUac == null ? '?' : s.usbcfgUac}`;
    } else {
      usbcfgLine.textContent = 'usbcfg / UAC：未查询';
    }
  }

  const qpcmvLine = $('qpcmvLine');
  if (qpcmvLine) {
    if (s.qpcmvOk === true) qpcmvLine.textContent = 'QPCMV：已接受 (AT+QPCMV=1,2)';
    else if (s.qpcmvOk === false)
      qpcmvLine.textContent =
        '本机固件可能无 UAC/QPCMV，通话控制可用但电脑音频可能无声' +
        (s.qpcmvError ? `（${String(s.qpcmvError).slice(0, 80)}）` : '');
    else qpcmvLine.textContent = 'QPCMV：未尝试';
  }

  if (Array.isArray(s.callLog) && s.callLog.length) {
    const log = $('callLog');
    if (log) {
      log.textContent = s.callLog
        .map((e) => {
          const d = new Date(e.t || Date.now());
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          const ss = String(d.getSeconds()).padStart(2, '0');
          return `[${hh}:${mm}:${ss}] ${e.line}`;
        })
        .join('\n');
      log.scrollTop = log.scrollHeight;
    }
  }
}

function paintOverview(s) {
  if (!s || typeof s === 'string') {
    setTile('operator', '—', 'muted');
    setTile('signal', '—', 'muted');
    setTile('network', '—', 'muted');
    setTile('sim', '—', 'muted');
    setTile('ims', '—', 'muted');
    setTile('port', '—', 'muted');
    setTile('iccid', '—', 'muted');
    setTile('reg', '—', 'muted');
    paintMsisdn(null);
    return;
  }

  const connected = !!s.connected && !s.error;
  setTile('operator', s.operator || '—', s.operator ? 'info' : 'muted');

  let signalTone = 'muted';
  let signalText = '—';
  if (s.signal != null) {
    const n = Number(s.signal);
    signalText = String(s.signal);
    if (!Number.isNaN(n)) {
      if (n >= 20) signalTone = 'ok';
      else if (n >= 12) signalTone = 'info';
      else if (n >= 5) signalTone = 'warn';
      else signalTone = 'bad';
    }
  }
  setTile('signal', signalText, signalTone);

  const netParts = [];
  if (s.mode) netParts.push(s.mode);
  if (s.cereg) netParts.push(`CEREG ${s.cereg}`);
  else if (s.creg) netParts.push(`CREG ${s.creg}`);
  setTile('network', netParts.join(' · ') || '—', connected ? 'info' : 'muted');

  // Never claim CNUM works when empty — show effective number with source.
  const eff = s.effectiveMsisdn;
  if (eff) {
    const tag = s.effectiveMsisdnSource === 'cnum' ? 'CNUM' : '已保存';
    setTile('sim', `${eff}（${tag}）`, 'ok');
  } else {
    setTile('sim', '未设置', 'muted');
  }

  let imsTone = 'muted';
  if (s.imsEnable === 1 && s.imsRegistered === 1) imsTone = 'ok';
  else if (s.imsEnable === 1) imsTone = 'warn';
  else if (s.imsEnable === 0) imsTone = 'bad';
  setTile('ims', imsLabel(s), imsTone);

  setTile('port', s.port || '(无)', s.port ? 'info' : 'muted');
  setTile('iccid', shortIccid(s.iccid), s.iccid ? '' : 'muted');

  const reg = [s.creg && `CREG ${s.creg}`, s.cereg && `CEREG ${s.cereg}`]
    .filter(Boolean)
    .join(' / ');
  setTile('reg', reg || (connected ? '已连接' : '未注册'), connected ? 'ok' : 'muted');

  paintMsisdn(s);
  paintCall(s);
}

function setSmsStatus(s, ok) {
  const el = $('smsStatus');
  lastStatus = typeof s === 'string' ? null : s;

  if (typeof s === 'string') {
    el.hidden = false;
    el.textContent = s;
    el.className = 'connect-banner' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
    paintOverview(null);
    return;
  }

  paintOverview(s);

  if (s.error) {
    el.hidden = false;
    el.textContent = s.error;
    el.className = 'connect-banner bad';
  } else if (!s.connected) {
    el.hidden = false;
    el.textContent = '模组未连接。请安装驱动后点「重新连接」，或到「诊断」检测模块。';
    el.className = 'connect-banner';
  } else {
    el.hidden = true;
    el.textContent = '';
    el.className = 'connect-banner' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
  }
}

function msgKey(m) {
  return `${m.storage || 'SM'}:${m.index}`;
}

function renderDetectedChips(boxId, listId, numbers, { preferOwn = true } = {}) {
  const box = $(boxId);
  const list = $(listId);
  if (!box || !list) return;
  const items = Array.isArray(numbers) ? numbers.slice() : [];
  if (!items.length) {
    box.hidden = true;
    list.textContent = '';
    return;
  }
  if (preferOwn) items.sort((a, b) => Number(!!b.ownContext) - Number(!!a.ownContext));
  box.hidden = false;
  list.textContent = '';
  for (const n of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (n.ownContext ? ' is-own' : '');
    const label = n.e164 || n.number;
    btn.textContent = n.ownContext ? `${label} · 疑似本机` : label;
    btn.title = n.snippet || label;
    btn.addEventListener('click', () => saveMsisdnNumber(n.e164 || n.number));
    list.appendChild(btn);
  }
}

function renderMessages(msgs) {
  const box = $('smsList');
  lastMessages = Array.isArray(msgs) ? msgs.slice() : [];
  const alive = new Set(lastMessages.filter((m) => m.index != null && m.index !== '').map(msgKey));
  for (const k of [...selectedSmsKeys]) {
    if (!alive.has(k)) selectedSmsKeys.delete(k);
  }

  if (!lastMessages.length) {
    box.innerHTML =
      '<div class="inbox-empty">暂无短信<br><span style="font-size:12px;opacity:.85">PDU 列表为空时多为网络 / IMS / SIM 侧未投递</span></div>';
    return;
  }

  box.textContent = '';
  for (const m of lastMessages) {
    const concat =
      m.concat && m.concat.reassembled
        ? ` · 长短信 ${m.concat.seq || ''}/${m.concat.total}`
        : m.concat
          ? ` · 分段 ${m.concat.seq}/${m.concat.total}`
          : '';

    const key = msgKey(m);
    const canSelect = m.index != null && m.index !== '';

    const row = document.createElement('article');
    row.className = 'msg';

    const checkWrap = document.createElement('label');
    checkWrap.className = 'msg-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = !canSelect;
    cb.checked = canSelect && selectedSmsKeys.has(key);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedSmsKeys.add(key);
      else selectedSmsKeys.delete(key);
    });
    checkWrap.appendChild(cb);

    const side = document.createElement('div');
    side.className = 'msg-side';

    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    sender.textContent = m.sender || '(未知发件人)';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = `${m.timestamp || '时间未知'} · #${m.index ?? '?'} · ${m.storage || '?'}${concat}`;

    side.appendChild(sender);
    side.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = m.body || '';

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn tiny danger-ghost';
    delBtn.textContent = '删除';
    delBtn.title = '从模组存储删除此条';
    delBtn.disabled = !canSelect;
    delBtn.addEventListener('click', () => deleteOneMessage(m));
    actions.appendChild(delBtn);

    row.appendChild(checkWrap);
    row.appendChild(side);
    row.appendChild(body);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

function selectedItems() {
  const map = new Map(lastMessages.filter((m) => m.index != null && m.index !== '').map((m) => [msgKey(m), m]));
  const items = [];
  for (const k of selectedSmsKeys) {
    const m = map.get(k);
    if (m) items.push({ storage: m.storage || 'SM', index: m.index });
  }
  return items;
}

async function saveMsisdnNumber(number) {
  const num = String(number || '').trim();
  if (!num) {
    setSmsStatus('请填写本机号码', false);
    return;
  }
  setBusy(true);
  try {
    const result = await window.toolkit.msisdnSet(num, uiIccid || undefined);
    if (!result.ok) throw new Error(result.error || '保存失败');
    if ($('msisdnInput')) $('msisdnInput').value = num;
    if (result.status) {
      setSmsStatus(result.status, !!(result.status.connected && !result.status.error));
    }
    const banner = $('smsStatus');
    if (banner) {
      banner.hidden = false;
      banner.textContent = '已按 ICCID 保存本机号码';
      banner.className = 'connect-banner ok';
    }
  } catch (e) {
    setSmsStatus('保存本机号码失败: ' + (e.message || e), false);
  } finally {
    setBusy(false);
  }
}

async function deleteOneMessage(m) {
  if (!m || m.index == null || m.index === '') return;
  const ok = window.confirm(
    `确定删除此短信？\n发件人: ${m.sender || '?'}\n索引: #${m.index} · 存储: ${m.storage || 'SM'}\n\n不会自动删除；仅在确认后执行 AT+CMGD。`
  );
  if (!ok) return;
  setBusy(true);
  setSmsStatus('正在删除…');
  try {
    const result = await window.toolkit.smsDelete(m.storage || 'SM', m.index);
    if (!result.ok) throw new Error(result.error || '删除失败');
    selectedSmsKeys.delete(msgKey(m));
    setSmsStatus(result.status || {}, !!(result.status && result.status.connected && !result.status.error));
    renderMessages(result.messages || []);
  } catch (e) {
    setSmsStatus('删除失败: ' + (e.message || e), false);
  } finally {
    setBusy(false);
  }
}

async function deleteSelectedMessages() {
  const items = selectedItems();
  if (!items.length) {
    setSmsStatus('请先勾选要删除的短信', false);
    switchView('sms');
    return;
  }
  const ok = window.confirm(
    `确定删除所选 ${items.length} 条短信？\n将对每条执行 AT+CMGD（按存储切换 CPMS）。\n此操作不可恢复。`
  );
  if (!ok) return;
  setBusy(true);
  setSmsStatus(`正在删除所选 ${items.length} 条…`);
  try {
    const result = await window.toolkit.smsDeleteMany(items);
    if (!result.ok) throw new Error(result.error || '批量删除失败');
    selectedSmsKeys.clear();
    setSmsStatus(result.status || {}, !!(result.status && result.status.connected && !result.status.error));
    renderMessages(result.messages || []);
  } catch (e) {
    setSmsStatus('批量删除失败: ' + (e.message || e), false);
  } finally {
    setBusy(false);
  }
}

async function refreshSms() {
  try {
    const data = await window.toolkit.smsRefresh();
    const s = data.status || {};
    setSmsStatus(s, !!(s.connected && !s.error));
    renderMessages(data.messages || []);
    lastDetectedNumbers = data.detectedNumbers || [];
    renderDetectedChips('smsDetectBox', 'smsDetectList', lastDetectedNumbers);
    ensureAutoRefresh(!!s.connected);
  } catch (e) {
    setSmsStatus(String(e.message || e), false);
    ensureAutoRefresh(false);
  }
}

function ensureAutoRefresh(connected) {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (connected) {
    refreshTimer = setInterval(() => {
      if (!busy) refreshSms();
    }, 15000);
  }
}

function currentUssdCode() {
  const preset = $('ussdPreset')?.value;
  if (preset === 'custom') return ($('ussdCustom')?.value || '').trim();
  return String(preset || '').trim();
}

async function init() {
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

  try {
    const info = await window.toolkit.getInfo();
    $('ver').textContent = `v${info.version}`;
  } catch {
    $('ver').textContent = '';
  }

  document.querySelectorAll('.rail-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view')));
  });

  $('btnTheme').onclick = () => toggleTheme();

  if (window.toolkit.onSmsUrc) {
    window.toolkit.onSmsUrc((payload) => {
      if (payload && payload.type === 'CALL') {
        paintCall({ ...(lastStatus || {}), callState: payload.state, callNumber: payload.number, callClip: payload.clip });
        return;
      }
      if (!busy) refreshSms();
    });
  }
  if (window.toolkit.onCallUrc) {
    window.toolkit.onCallUrc(async () => {
      try {
        const data = await window.toolkit.callStatus();
        if (data.status) {
          lastStatus = data.status;
          paintCall(data.status);
        }
      } catch (_) {}
    });
  }

  $('ussdPreset').onchange = () => {
    const custom = $('ussdCustom');
    if (!custom) return;
    custom.hidden = $('ussdPreset').value !== 'custom';
  };

  $('btnMsisdnSave').onclick = async () => {
    await saveMsisdnNumber($('msisdnInput').value);
  };

  $('btnUssd').onclick = async () => {
    const code = currentUssdCode();
    if (!code) {
      setSmsStatus('请选择或填写 USSD 码', false);
      return;
    }
    setBusy(true);
    const out = $('ussdResult');
    out.hidden = false;
    out.textContent = `发送 USSD ${code} …`;
    try {
      const result = await window.toolkit.ussdSend(code);
      if (!result.ok) throw new Error(result.error || 'USSD 失败');
      const text = result.text || result.raw || '';
      out.textContent = `>>> ${code}\n${text}\n\n(raw) ${result.raw || ''}`;
      if (result.status) setSmsStatus(result.status, !!(result.status.connected && !result.status.error));
      renderDetectedChips('ussdDetectBox', 'ussdDetectList', result.detected || []);
      switchView('overview');
    } catch (e) {
      out.textContent = 'USSD 失败: ' + (e.message || e);
      setSmsStatus('USSD 失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnDrivers').onclick = async () => {
    const log = $('driverLog');
    appendLog(log, '=== 一键安装驱动（qcser/qcmdm/qcfilter，需要管理员 UAC）===');
    setBusy(true);
    try {
      const result = await window.toolkit.installDrivers();
      appendLog(log, result.message || JSON.stringify(result));
      appendLog(log, result.ok ? '成功' : '失败或已取消');
    } catch (e) {
      appendLog(log, String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  $('btnDriversWwan').onclick = async () => {
    const ok = window.confirm(
      '将安装上网驱动 qcwwan.inf（Quectel NDIS WWAN）。\n\n可能覆盖已有的百旺/大疆 WWAN 网卡驱动；若当前已能上网可跳过。\n\n需要管理员 UAC。是否继续？'
    );
    if (!ok) return;
    const log = $('driverLog');
    appendLog(log, '=== 安装上网驱动 qcwwan（需要管理员 UAC）===');
    appendLog(log, '警告：可能覆盖已有百旺/大疆 WWAN 驱动；已能上网则可跳过。');
    setBusy(true);
    try {
      const result = await window.toolkit.installWwanDriver();
      appendLog(log, result.message || JSON.stringify(result));
      appendLog(log, result.ok ? '成功' : '失败或已取消');
    } catch (e) {
      appendLog(log, String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  $('btnDetect').onclick = async () => {
    const log = $('moduleLog');
    log.textContent = '=== 检测模块状态 ===\n检测中…';
    setBusy(true);
    try {
      const status = await window.toolkit.detectDevice({ probe: true });
      log.textContent = '=== 检测模块状态 ===\n' + (status.text || JSON.stringify(status, null, 2));
    } catch (e) {
      log.textContent = '=== 检测模块状态 ===\n' + String(e.message || e);
    } finally {
      setBusy(false);
    }
  };

  $('btnSmsRefresh').onclick = async () => {
    setBusy(true);
    try {
      await refreshSms();
    } finally {
      setBusy(false);
    }
  };

  $('btnSmsReconnect').onclick = async () => {
    setBusy(true);
    setSmsStatus('重新连接中…');
    try {
      await window.toolkit.smsReconnect();
      await refreshSms();
    } catch (e) {
      setSmsStatus(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnEnableIms').onclick = async () => {
    setBusy(true);
    setSmsStatus('正在启用 IMS (AT+QCFG="ims",1)…');
    try {
      const result = await window.toolkit.smsEnableIms(false);
      if (!result.ok) throw new Error(result.error || '启用失败');
      setSmsStatus(result.status || {}, !!(result.status && result.status.connected && !result.status.error));
      renderMessages(result.messages || []);
      await refreshSms();
    } catch (e) {
      setSmsStatus('启用 IMS 失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnEnableImsReboot').onclick = async () => {
    const ok = window.confirm(
      '将执行：\n1) AT+QCFG="ims",1\n2) AT+CFUN=1,1 软重启模组\n\n重启后 USB 会短暂断开，需再点「重新连接」。是否继续？'
    );
    if (!ok) return;
    setBusy(true);
    setSmsStatus('启用 IMS 并软重启中…');
    try {
      const result = await window.toolkit.smsEnableIms(true);
      if (!result.ok) throw new Error(result.error || '失败');
      setSmsStatus(
        (result.status && result.status.error) ||
          '已发送软重启，请等待模组重新枚举后点「重新连接」',
        false
      );
    } catch (e) {
      setSmsStatus('启用 IMS/重启失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnSmsSelectAll').onclick = () => {
    for (const m of lastMessages) {
      if (m.index == null || m.index === '') continue;
      selectedSmsKeys.add(msgKey(m));
    }
    renderMessages(lastMessages);
  };

  $('btnSmsSelectNone').onclick = () => {
    selectedSmsKeys.clear();
    renderMessages(lastMessages);
  };

  $('btnSmsDeleteSelected').onclick = () => deleteSelectedMessages();

  $('btnSmsClearSm').onclick = async () => {
    const ok = window.confirm(
      '将清空当前存储 SM 中的全部短信（AT+CMGD=1,4）。\n此操作不可恢复。是否继续？'
    );
    if (!ok) return;
    setBusy(true);
    setSmsStatus('正在清空 SM…');
    try {
      const result = await window.toolkit.smsDeleteAll('SM');
      if (!result.ok) throw new Error(result.error || '清空失败');
      setSmsStatus(result.status || {}, !!(result.status && result.status.connected && !result.status.error));
      renderMessages(result.messages || []);
    } catch (e) {
      setSmsStatus('清空失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnSend').onclick = async () => {
    const to = $('smsTo').value.trim();
    const text = $('smsText').value;
    if (!to || !text) {
      setSmsStatus('请填写号码和内容', false);
      switchView('sms');
      return;
    }
    setBusy(true);
    setSmsStatus('发送中（PDU）…');
    try {
      const result = await window.toolkit.smsSend(to, text);
      if (!result.ok) throw new Error(result.error || '发送失败');
      $('smsText').value = '';
      await refreshSms();
    } catch (e) {
      setSmsStatus('发送失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('smsText').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      $('btnSend').click();
    }
  });

  // —— Call ——
  $('dialPad').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-digit]');
    if (!btn) return;
    const input = $('callNumber');
    input.value = (input.value || '') + btn.getAttribute('data-digit');
  });

  $('btnDial').onclick = async () => {
    const num = $('callNumber').value.trim();
    if (!num) {
      setSmsStatus('请输入要拨打的号码', false);
      switchView('call');
      return;
    }
    if (lastStatus && lastStatus.imsRegistered !== 1) {
      const go = window.confirm('IMS 当前未注册，拨号可能失败。仍要尝试？');
      if (!go) return;
    }
    setBusy(true);
    try {
      const result = await window.toolkit.callDial(num);
      if (!result.ok) throw new Error(result.error || '拨号失败');
      if (result.status) {
        lastStatus = result.status;
        paintCall(result.status);
      }
    } catch (e) {
      setSmsStatus('拨号失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnAnswer').onclick = async () => {
    setBusy(true);
    try {
      const result = await window.toolkit.callAnswer();
      if (!result.ok) throw new Error(result.error || '接听失败');
      if (result.status) {
        lastStatus = result.status;
        paintCall(result.status);
      }
    } catch (e) {
      setSmsStatus('接听失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnHangup').onclick = async () => {
    setBusy(true);
    try {
      const result = await window.toolkit.callHangup();
      if (!result.ok) throw new Error(result.error || '挂断失败');
      if (result.status) {
        lastStatus = result.status;
        paintCall(result.status);
      }
    } catch (e) {
      setSmsStatus('挂断失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnQueryUsbcfg').onclick = async () => {
    setBusy(true);
    try {
      const result = await window.toolkit.callQueryUsbcfg();
      if (!result.ok && result.error) throw new Error(result.error);
      if (result.status) {
        lastStatus = result.status;
        paintCall(result.status);
      }
    } catch (e) {
      setSmsStatus('查询 usbcfg 失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnEnableUsbAudio').onclick = async () => {
    const ok = window.confirm(
      '将尝试把 AT+QCFG="usbcfg" 最后一位（UAC）设为 1，并保存旧值以便恢复。\n\n更改后通常需要软重启模组才生效。\n是否继续并软重启？'
    );
    if (!ok) return;
    setBusy(true);
    try {
      const result = await window.toolkit.callEnableUsbAudio(true);
      if (!result.ok) throw new Error(result.error || '失败');
      setSmsStatus(
        (result.status && result.status.error) ||
          '已设置 UAC=1 并软重启，请等待模组重新枚举后点「重新连接」',
        false
      );
    } catch (e) {
      setSmsStatus('启用 USB 音频失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnRestoreUsbcfg').onclick = async () => {
    const ok = window.confirm('恢复本次会话保存的 usbcfg 旧值，并软重启模组？');
    if (!ok) return;
    setBusy(true);
    try {
      const result = await window.toolkit.callRestoreUsbcfg(true);
      if (!result.ok) throw new Error(result.error || '失败');
      setSmsStatus(
        (result.status && result.status.error) ||
          '已恢复 usbcfg 并软重启，请等待后点「重新连接」',
        false
      );
    } catch (e) {
      setSmsStatus('恢复 usbcfg 失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  $('btnTryQpcmv').onclick = async () => {
    setBusy(true);
    try {
      const result = await window.toolkit.callTryQpcmv();
      if (result.status) {
        lastStatus = result.status;
        paintCall(result.status);
      }
      if (!result.ok) {
        setSmsStatus(result.message || '本机固件可能无 UAC/QPCMV，通话控制可用但电脑音频可能无声', false);
      } else {
        setSmsStatus(result.message || 'QPCMV 已接受', true);
      }
    } catch (e) {
      setSmsStatus('QPCMV 失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  setBusy(true);
  try {
    await window.toolkit.smsReconnect();
    await refreshSms();
  } catch (e) {
    setSmsStatus(String(e.message || e), false);
  } finally {
    setBusy(false);
  }
}

document.addEventListener('DOMContentLoaded', init);
