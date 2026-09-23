'use strict';

const $ = (id) => document.getElementById(id);

let refreshTimer = null;
let busy = false;

function setBusy(isBusy) {
  busy = isBusy;
  for (const id of ['btnDrivers', 'btnDetect', 'btnSmsRefresh', 'btnSmsReconnect', 'btnSend']) {
    const el = $(id);
    if (el) el.disabled = isBusy;
  }
}

function appendLog(el, text) {
  const line = String(text || '').replace(/\s+$/, '');
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function setSmsStatus(text, ok) {
  const el = $('smsStatus');
  el.textContent = text;
  el.className = 'status' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
}

function renderMessages(msgs) {
  const box = $('smsList');
  if (!msgs || !msgs.length) {
    box.innerHTML = '<div class="meta">暂无短信</div>';
    return;
  }
  box.innerHTML = msgs
    .map(
      () =>
        `<div class="msg"><div class="meta"></div><div class="body"></div></div>`
    )
    .join('');
  [...box.querySelectorAll('.msg')].forEach((el, i) => {
    const m = msgs[i];
    el.querySelector('.meta').textContent = `#${m.index ?? '?'} · ${m.sender || ''} · ${m.timestamp || ''} · ${m.status || ''}`;
    el.querySelector('.body').textContent = m.body || '';
  });
}

async function refreshSms() {
  try {
    const data = await window.toolkit.smsRefresh();
    const s = data.status || {};
    const lines = [
      `连接: ${s.connected ? '是' : '否'}`,
      `端口: ${s.port || '(无)'}`,
      s.signal != null ? `信号 CSQ: ${s.signal}` : null,
      s.operator ? `运营商: ${s.operator}` : null,
      s.error ? `错误: ${s.error}` : null,
    ].filter(Boolean);
    setSmsStatus(lines.join('\n'), !!(s.connected && !s.error));
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

  $('btnSend').onclick = async () => {
    const to = $('smsTo').value.trim();
    const text = $('smsText').value;
    if (!to || !text) {
      setSmsStatus('请填写号码和内容', false);
      return;
    }
    setBusy(true);
    setSmsStatus('发送中…');
    try {
      const result = await window.toolkit.smsSend(to, text);
      if (!result.ok) throw new Error(result.error || '发送失败');
      $('smsText').value = '';
      setSmsStatus('发送成功', true);
      await refreshSms();
    } catch (e) {
      setSmsStatus('发送失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  // Auto-connect SMS on startup (in-window; no external browser).
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
