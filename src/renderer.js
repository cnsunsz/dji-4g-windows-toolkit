'use strict';

const $ = (id) => document.getElementById(id);

const THEME_KEY = 'dji4g-toolkit-theme';
const VIEW_META = {
  overview: { title: '模块概览', sub: '运营商 / 信号 / SIM / IMS 一览' },
  sms: { title: '短信', sub: 'PDU 收发 · SM / ME / MT · +CMTI 监听' },
  drivers: { title: '驱动', sub: 'Quectel qcser / qcmdm / qcfilter · 需 UAC' },
  diag: { title: '诊断', sub: 'USB / AT 口 / ATI · IMS 启用' },
};

let refreshTimer = null;
let busy = false;
let lastStatus = null;

function setBusy(isBusy) {
  busy = isBusy;
  for (const id of [
    'btnDrivers',
    'btnDetect',
    'btnSmsRefresh',
    'btnSmsReconnect',
    'btnSend',
    'btnEnableIms',
    'btnEnableImsReboot',
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

  setTile('sim', s.ownNumber || '(无 CNUM)', s.ownNumber ? 'ok' : 'muted');

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

function renderMessages(msgs) {
  const box = $('smsList');
  if (!msgs || !msgs.length) {
    box.innerHTML =
      '<div class="inbox-empty">暂无短信<br><span style="font-size:12px;opacity:.85">PDU 列表为空时多为网络 / IMS / SIM 侧未投递</span></div>';
    return;
  }

  box.textContent = '';
  for (const m of msgs) {
    const concat =
      m.concat && m.concat.reassembled
        ? ` · 长短信 ${m.concat.seq || ''}/${m.concat.total}`
        : m.concat
          ? ` · 分段 ${m.concat.seq}/${m.concat.total}`
          : '';

    const row = document.createElement('article');
    row.className = 'msg';

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

    row.appendChild(side);
    row.appendChild(body);
    box.appendChild(row);
  }
}

async function refreshSms() {
  try {
    const data = await window.toolkit.smsRefresh();
    const s = data.status || {};
    setSmsStatus(s, !!(s.connected && !s.error));
    renderMessages(data.messages || []);
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
    window.toolkit.onSmsUrc(() => {
      if (!busy) refreshSms();
    });
  }

  $('btnDrivers').onclick = async () => {
    const log = $('driverLog');
    appendLog(log, '=== 一键安装驱动（需要管理员 UAC）===');
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
