'use strict';

const $ = (id) => document.getElementById(id);

let refreshTimer = null;
let busy = false;

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

function imsLabel(s) {
  if (s.imsEnable == null && s.imsRegistered == null) return '(未知)';
  const en = s.imsEnable == null ? '?' : String(s.imsEnable);
  const reg = s.imsRegistered == null ? '?' : String(s.imsRegistered);
  const hint =
    s.imsEnable === 1 && s.imsRegistered === 1
      ? '已启用且已注册'
      : s.imsEnable === 1
        ? '已启用，未注册(或等待中)'
        : '未启用';
  return `${en},${reg}（${hint}）`;
}

function setSmsStatus(s, ok) {
  const el = $('smsStatus');
  if (typeof s === 'string') {
    el.textContent = s;
    el.className = 'status' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
    return;
  }
  const rows = [
    ['连接', s.connected ? '是' : '否'],
    ['端口', s.port || '(无)'],
    ['模式', s.mode || 'PDU'],
    ['本机号码', s.ownNumber || '(无 CNUM)'],
    ['ICCID', s.iccid || '(无)'],
    ['IMSI', s.imsi || '(无)'],
    ['短信中心', s.csca || '(无)'],
    ['CSQ', s.signal != null ? String(s.signal) : '(无)'],
    ['运营商', s.operator || '(无)'],
    ['CREG', s.creg || '(无)'],
    ['CEREG', s.cereg || '(无)'],
    ['IMS', imsLabel(s)],
  ];
  if (s.error) rows.push(['错误', s.error]);
  el.textContent = '';
  const grid = document.createElement('div');
  grid.className = 'status-grid';
  for (const [k, v] of rows) {
    const kk = document.createElement('span');
    kk.className = 'k';
    kk.textContent = k;
    const vv = document.createElement('span');
    vv.className = 'v';
    vv.textContent = v;
    grid.appendChild(kk);
    grid.appendChild(vv);
  }
  el.appendChild(grid);
  el.className = 'status' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
}

function renderMessages(msgs) {
  const box = $('smsList');
  if (!msgs || !msgs.length) {
    box.innerHTML = '<div class="meta">暂无短信（PDU 列表为空时多为网络/IMS/SIM 侧未投递，不一定是软件问题）</div>';
    return;
  }
  box.innerHTML = msgs
    .map(() => `<div class="msg"><div class="meta"></div><div class="body"></div></div>`)
    .join('');
  [...box.querySelectorAll('.msg')].forEach((el, i) => {
    const m = msgs[i];
    const concat =
      m.concat && m.concat.reassembled
        ? ` · 长短信 ${m.concat.seq || ''}/${m.concat.total}`
        : m.concat
          ? ` · 分段 ${m.concat.seq}/${m.concat.total}`
          : '';
    el.querySelector('.meta').textContent =
      `#${m.index ?? '?'} · ${m.storage || '?'} · ${m.sender || ''} · ${m.timestamp || ''} · ${m.status || ''}${concat}`;
    el.querySelector('.body').textContent = m.body || '';
  });
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
  try {
    const info = await window.toolkit.getInfo();
    $('ver').textContent = `v${info.version}`;
  } catch {
    $('ver').textContent = '';
  }

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
      return;
    }
    setBusy(true);
    setSmsStatus('发送中（PDU）…');
    try {
      const result = await window.toolkit.smsSend(to, text);
      if (!result.ok) throw new Error(result.error || '发送失败');
      $('smsText').value = '';
      await refreshSms();
      const st = await window.toolkit.smsStatus();
      setSmsStatus({ ...st, error: null }, true);
      // brief success note in status via temporary — refresh already shows grid
    } catch (e) {
      setSmsStatus('发送失败: ' + (e.message || e), false);
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
