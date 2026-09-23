'use strict';

const $ = (id) => document.getElementById(id);

const THEME_KEY = 'dji4g-toolkit-theme';
const VIEW_META = {
  overview: { title: '模块概览', sub: '运营商、信号、SIM、IMS 与适配器' },
  sms: { title: '短信', sub: '会话线程 · PDU 收发 · 本地已发送持久化' },
  call: { title: '通话', sub: '实验功能 · AT 语音控制 · 音频路径视固件而定' },
  drivers: { title: '驱动', sub: 'Quectel qcser / qcmdm / qcfilter · 可选 qcwwan · 需 UAC' },
  diag: { title: '诊断', sub: 'USB / AT 口 · AT 控制台 · IMS' },
  settings: { title: '设置', sub: '开机启动 · 托盘 · 来电/短信角标 · 铃声 · 自动连接' },
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
let lastMessages = [];
let lastThreads = [];
let activePeer = null;
let threadSearch = '';
let uiIccid = null;
let lastDetectedNumbers = [];
let settingsCache = null;
let popupIgnored = false;

function setBusy(isBusy) {
  busy = isBusy;
  for (const id of [
    'btnDrivers',
    'btnDriversWwan',
    'btnDetect',
    'btnSmsRefresh',
    'btnSmsReconnect',
    'btnSend',
    'btnSmsClearSm',
    'btnClearThread',
    'btnNewThread',
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
    'btnPopupAnswer',
    'btnPopupHangup',
    'btnAtSend',
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

function getThemePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch (_) {}
  return 'system';
}

function resolveTheme(pref) {
  const p = pref || getThemePref();
  if (p === 'dark' || p === 'light') return p;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch (_) {}
  return 'light';
}

function themeLabel(pref) {
  if (pref === 'dark') return '深色';
  if (pref === 'light') return '浅色';
  return '跟随系统';
}

function applyTheme(pref) {
  const choice = pref === 'dark' || pref === 'light' || pref === 'system' ? pref : 'system';
  const resolved = resolveTheme(choice);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', choice);
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch (_) {}
  const btn = $('btnTheme');
  if (btn) btn.textContent = themeLabel(choice);
  const sel = $('setThemePref');
  if (sel && sel.value !== choice) sel.value = choice;
}

function toggleTheme() {
  const order = ['system', 'light', 'dark'];
  const cur = getThemePref();
  const idx = order.indexOf(cur);
  applyTheme(order[(idx + 1) % order.length]);
}

function bindSystemThemeListener() {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getThemePref() === 'system') applyTheme('system');
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onChange);
}

/** Extract 4–8 digit OTP / verification codes from SMS body (Chinese + EN cues). */
function extractOtpCodes(body) {
  const s = String(body || '');
  if (!s) return [];
  const found = [];
  const seen = new Set();
  const push = (code) => {
    const c = String(code || '');
    if (!/^\d{4,8}$/.test(c)) return;
    if (/^(19|20)\d{2}$/.test(c)) return; // years
    if (seen.has(c)) return;
    seen.add(c);
    found.push(c);
  };
  const keywordRe =
    /(?:验证码|校验码|动态码|动态密码|认证码|确认码|短信码|code|otp|password|pin)[^\d]{0,12}(\d{4,8})/gi;
  let m;
  while ((m = keywordRe.exec(s))) push(m[1]);
  if (!found.length) {
    const reverseRe = /(\d{4,8})[^\d]{0,6}(?:验证码|校验码|动态码|为您的验证码)/g;
    while ((m = reverseRe.exec(s))) push(m[1]);
  }
  if (!found.length) {
    // Avoid swallowing mainland mobile numbers
    const cleaned = s.replace(/\+?86?1[3-9]\d{9}/g, ' ');
    const loose = cleaned.match(/(?<!\d)\d{4,8}(?!\d)/g) || [];
    for (const c of loose) {
      if (c.length === 4 || c.length === 6) push(c);
    }
  }
  return found.slice(0, 3);
}

async function copyText(text) {
  const v = String(text || '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(v);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = v;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (_) {
    return false;
  }
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

function displayPeerLocal(raw) {
  const s = String(raw || '').trim();
  if (!s) return '(未知)';
  const m = s.match(/^\+?86(1[3-9]\d{9})$/);
  if (m) return m[1];
  if (/^1[3-9]\d{9}$/.test(s)) return s;
  return s;
}

function formatTimeShort(ts, timestamp) {
  let t = ts;
  if (!t && timestamp) {
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed)) t = parsed;
  }
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(timestamp || '');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
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

  // Corner call-card BrowserWindow (main process) is primary UI even when minimized/tray
  if (state !== 'ringing') {
    hideCallPopup();
    popupIgnored = false;
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
    setTile('adapter', '—', 'muted');
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

  if (s.adapterHint) {
    setTile('adapter', s.adapterHint, connected ? 'info' : 'muted');
  } else if (s.vidPid) {
    setTile('adapter', `USB ${s.vidPid}`, connected ? 'info' : 'muted');
  } else if (connected) {
    setTile('adapter', '已连接', 'ok');
  } else {
    setTile('adapter', '未检测到', 'muted');
  }

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

function updateSmsNavBadge(threads) {
  const btn = document.querySelector('.rail-item[data-view="sms"] .rail-label');
  if (!btn) return;
  const total = (threads || []).reduce((n, t) => n + (t.unread || 0), 0);
  let label = btn.childNodes[0] && btn.childNodes[0].nodeType === 3 ? btn.childNodes[0] : null;
  // Keep text "短信" and optional badge span
  const base = '短信';
  btn.textContent = '';
  btn.appendChild(document.createTextNode(base));
  if (total > 0) {
    const dot = document.createElement('span');
    dot.className = 'unread-dot';
    dot.title = `${total} 条未读`;
    btn.appendChild(dot);
  }
}

function renderThreads(threads) {
  lastThreads = Array.isArray(threads) ? threads.slice() : [];
  updateSmsNavBadge(lastThreads);

  const box = $('threadList');
  if (!box) return;

  const q = String(threadSearch || '')
    .trim()
    .toLowerCase();
  const filtered = !q
    ? lastThreads
    : lastThreads.filter((t) => {
        const peer = displayPeerLocal(t.peer).toLowerCase();
        const preview = String(t.lastPreview || '').toLowerCase();
        const raw = String(t.peer || '').toLowerCase();
        return peer.includes(q) || preview.includes(q) || raw.includes(q);
      });

  if (!filtered.length) {
    box.innerHTML =
      '<div class="inbox-empty" style="padding:28px 12px">暂无会话<br><span style="font-size:12px;opacity:.85">收到或发送短信后将按号码聚合</span></div>';
  } else {
    box.textContent = '';
    for (const t of filtered) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thread-item' + (t.peer === activePeer ? ' is-active' : '');
      const peerEl = document.createElement('div');
      peerEl.className = 'thread-item-peer';
      peerEl.textContent = displayPeerLocal(t.peer);
      const meta = document.createElement('div');
      meta.className = 'thread-item-meta';
      if (t.unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'thread-badge';
        badge.textContent = t.unread > 99 ? '99+' : String(t.unread);
        meta.appendChild(badge);
      } else {
        meta.textContent = formatTimeShort(t.lastAt);
      }
      const preview = document.createElement('div');
      preview.className = 'thread-item-preview';
      preview.textContent = t.lastPreview || '（无内容）';
      btn.appendChild(peerEl);
      btn.appendChild(meta);
      btn.appendChild(preview);
      btn.addEventListener('click', () => selectThread(t.peer));
      box.appendChild(btn);
    }
  }

  if (activePeer) {
    const still = lastThreads.find((t) => t.peer === activePeer);
    if (still) renderConversation(still);
    else {
      // Keep compose target but empty bubbles if thread cleared
      renderConversation({ peer: activePeer, messages: [], unread: 0 });
    }
  } else {
    renderConversation(null);
  }
}

function renderConversation(thread) {
  const title = $('threadPeerTitle');
  const sub = $('threadPeerSub');
  const clearBtn = $('btnClearThread');
  const bubbles = $('chatBubbles');
  if (!bubbles) return;

  if (!thread) {
    if (title) title.textContent = '选择会话';
    if (sub) sub.textContent = '左侧选择号码查看对话，或点「新建」';
    if (clearBtn) clearBtn.hidden = true;
    bubbles.innerHTML = '<div class="chat-empty">选择左侧会话，或发送一条新短信开始对话</div>';
    return;
  }

  if (title) title.textContent = displayPeerLocal(thread.peer);
  if (sub) {
    sub.textContent =
      thread.peer && thread.peer !== displayPeerLocal(thread.peer)
        ? thread.peer
        : `${(thread.messages || []).length} 条消息`;
  }
  if (clearBtn) clearBtn.hidden = false;

  const to = $('smsTo');
  if (to && document.activeElement !== to) {
    to.value = displayPeerLocal(thread.peer);
  }

  const msgs = thread.messages || [];
  if (!msgs.length) {
    bubbles.innerHTML = '<div class="chat-empty">会话为空。在下方输入内容发送。</div>';
    return;
  }

  bubbles.textContent = '';
  for (const m of msgs) {
    const row = document.createElement('div');
    row.className = 'bubble-row ' + (m.direction === 'out' ? 'is-out' : 'is-in');

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const bodyText = m.body || '';
    bubble.appendChild(document.createTextNode(bodyText));
    if (m.direction === 'in') {
      const otps = extractOtpCodes(bodyText);
      if (otps.length) {
        const row = document.createElement('div');
        row.className = 'otp-chip-row';
        for (const code of otps) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'otp-chip';
          chip.title = '点击复制验证码';
          const lab = document.createElement('span');
          lab.className = 'otp-chip-label';
          lab.textContent = '验证码';
          const val = document.createElement('span');
          val.textContent = code;
          chip.appendChild(lab);
          chip.appendChild(val);
          chip.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const ok = await copyText(code);
            chip.title = ok ? '已复制' : '复制失败';
            const prev = val.textContent;
            val.textContent = ok ? '已复制' : '失败';
            setTimeout(() => {
              val.textContent = prev;
            }, 1200);
          });
          row.appendChild(chip);
        }
        bubble.appendChild(row);
      }
    }

    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    const time = document.createElement('span');
    time.textContent =
      formatTimeShort(m.ts, m.timestamp) ||
      (m.direction === 'out' ? '已发送' : '收到');
    meta.appendChild(time);

    if (m.direction === 'in' && m.index != null && m.index !== '') {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bubble-del';
      del.textContent = '删除';
      del.title = `从模组删除 #${m.index} (${m.storage || 'SM'})`;
      del.addEventListener('click', () => deleteInboundMessage(m));
      meta.appendChild(del);
    } else if (m.direction === 'out' && m.local && m.id) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bubble-del';
      del.textContent = '删除本地';
      del.addEventListener('click', () => deleteOutboundMessage(m));
      meta.appendChild(del);
    }

    row.appendChild(bubble);
    row.appendChild(meta);
    bubbles.appendChild(row);
  }
  bubbles.scrollTop = bubbles.scrollHeight;
}

async function selectThread(peer) {
  activePeer = peer;
  renderThreads(lastThreads);
  try {
    const data = await window.toolkit.smsMarkRead(peer, uiIccid || undefined);
    if (data && data.threads) {
      lastThreads = data.threads;
      renderThreads(lastThreads);
    }
  } catch (_) {
    /* ignore */
  }
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

async function deleteInboundMessage(m) {
  if (!m || m.index == null || m.index === '') return;
  const ok = window.confirm(
    `确定删除此短信？\n对端: ${displayPeerLocal(m.peer)}\n索引: #${m.index} · 存储: ${m.storage || 'SM'}\n\n仅在确认后执行 AT+CMGD。`
  );
  if (!ok) return;
  setBusy(true);
  setSmsStatus('正在删除…');
  try {
    const result = await window.toolkit.smsDelete(m.storage || 'SM', m.index);
    if (!result.ok) throw new Error(result.error || '删除失败');
    setSmsStatus(result.status || {}, !!(result.status && result.status.connected && !result.status.error));
    if (result.threads) renderThreads(result.threads);
    else await refreshSms();
  } catch (e) {
    setSmsStatus('删除失败: ' + (e.message || e), false);
  } finally {
    setBusy(false);
  }
}

async function deleteOutboundMessage(m) {
  if (!m || !m.id) return;
  const ok = window.confirm('删除本地已发送记录？（不影响对端已收到的短信）');
  if (!ok) return;
  setBusy(true);
  try {
    const result = await window.toolkit.smsDeleteOutbound(m.id, uiIccid || undefined);
    if (!result.ok) throw new Error(result.error || '删除失败');
    if (result.threads) renderThreads(result.threads);
  } catch (e) {
    setSmsStatus('删除本地记录失败: ' + (e.message || e), false);
  } finally {
    setBusy(false);
  }
}

async function clearActiveThread() {
  if (!activePeer) return;
  const ok = window.confirm(
    `清空与 ${displayPeerLocal(activePeer)} 的会话？\n将删除模组内该号码的收件短信，并清除本地已发送记录。`
  );
  if (!ok) return;
  setBusy(true);
  setSmsStatus('正在清空会话…');
  try {
    const result = await window.toolkit.smsClearThread(activePeer, uiIccid || undefined);
    if (!result.ok) throw new Error(result.error || '清空失败');
    if (result.status) {
      setSmsStatus(result.status, !!(result.status.connected && !result.status.error));
    }
    if (result.threads) renderThreads(result.threads);
    else await refreshSms();
  } catch (e) {
    setSmsStatus('清空会话失败: ' + (e.message || e), false);
  } finally {
    setBusy(false);
  }
}

async function refreshSms() {
  try {
    const data = await window.toolkit.smsRefresh();
    const s = data.status || {};
    setSmsStatus(s, !!(s.connected && !s.error));
    lastMessages = data.messages || [];
    if (data.threads) renderThreads(data.threads);
    else {
      const t = await window.toolkit.smsThreads();
      if (t.threads) renderThreads(t.threads);
    }
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

function showCallPopup(number) {
  const el = $('callPopup');
  if (!el) return;
  $('callPopupNumber').textContent = displayPeerLocal(number) || '未知号码';
  $('callPopupSub').textContent = '振铃中…';
  el.hidden = false;
}

function hideCallPopup() {
  const el = $('callPopup');
  if (el) el.hidden = true;
}

function paintSettings(s) {
  settingsCache = s || settingsCache;
  if (!settingsCache) return;
  const map = {
    setOpenAtLogin: 'openAtLogin',
    setCloseToTray: 'closeToTray',
    setPopupOnCall: 'popupOnCall',
    setPopupOnSms: 'popupOnSms',
    setSmsSound: 'smsSound',
    setAutoConnect: 'autoConnect',
    setFlashTrayOnRing: 'flashTrayOnRing',
  };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    if (el) el.checked = !!settingsCache[key];
  }
  const ringSel = $('setRingtone');
  if (ringSel) ringSel.value = settingsCache.ringtone || 'apple';
  const vol = $('setRingtoneVolume');
  if (vol) {
    const v = typeof settingsCache.ringtoneVolume === 'number' ? settingsCache.ringtoneVolume : 0.85;
    vol.value = String(Math.round(v * 100));
  }
  const pathLabel = $('customRingtonePathLabel');
  if (pathLabel) {
    const cp = settingsCache.customRingtonePath || '';
    pathLabel.textContent = cp
      ? cp
      : '未选择（文件留在您的电脑上，不会上传或打进 Release）';
  }
}

async function loadSettings() {
  try {
    const s = await window.toolkit.getSettings();
    paintSettings(s);
  } catch (_) {
    paintSettings({
      openAtLogin: false,
      closeToTray: true,
      notifyOnCall: false,
      popupOnCall: true,
      popupOnSms: true,
      smsSound: true,
      autoConnect: true,
      flashTrayOnRing: true,
      ringtone: 'apple',
      ringtoneVolume: 0.85,
      customRingtonePath: '',
    });
  }
}

async function saveSetting(key, value) {
  try {
    const result = await window.toolkit.setSettings({ [key]: value });
    if (result && result.settings) paintSettings(result.settings);
    const note = $('settingsSaveNote');
    if (note) note.textContent = '已保存并立即生效。';
    return result;
  } catch (e) {
    const note = $('settingsSaveNote');
    if (note) note.textContent = '保存失败: ' + (e.message || e);
    return null;
  }
}

function stopRingtonePreview() {
  try {
    const el = $('ringtonePreview');
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  } catch (_) {}
}

async function previewRingtone() {
  stopRingtonePreview();
  try {
    const info = await window.toolkit.resolveRingtone();
    if (!info || !info.url) {
      const note = $('settingsSaveNote');
      if (note) {
        note.textContent = (settingsCache && settingsCache.ringtone === 'mute')
          ? '当前为静音。'
          : '无法试听：请先选择有效铃声或自定义文件。';
      }
      return;
    }
    const el = $('ringtonePreview');
    if (!el) return;
    el.loop = false;
    el.volume = typeof info.volume === 'number' ? info.volume : 0.85;
    el.src = info.url;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    setTimeout(() => stopRingtonePreview(), 4000);
  } catch (e) {
    const note = $('settingsSaveNote');
    if (note) note.textContent = '试听失败: ' + (e.message || e);
  }
}

async function init() {
  applyTheme(getThemePref());
  bindSystemThemeListener();

  try {
    const info = await window.toolkit.getInfo();
    $('ver').textContent = `v${info.version}`;
  } catch {
    $('ver').textContent = '';
  }

  await loadSettings();

  document.querySelectorAll('.rail-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view')));
  });

  $('btnTheme').onclick = () => toggleTheme();
  const themeSel = $('setThemePref');
  if (themeSel) {
    themeSel.value = getThemePref();
    themeSel.addEventListener('change', () => applyTheme(themeSel.value));
  }

  if (window.toolkit.onSmsUrc) {
    window.toolkit.onSmsUrc((payload) => {
      if (payload && payload.type === 'CALL') {
        paintCall({
          ...(lastStatus || {}),
          callState: payload.state,
          callNumber: payload.number,
          callClip: payload.clip,
        });
        return;
      }
      if (payload && payload.type === 'AUTO_CONNECT') {
        if (!busy) refreshSms();
        return;
      }
      if (!busy) refreshSms();
    });
  }
  if (window.toolkit.onCallUrc) {
    window.toolkit.onCallUrc(async (payload) => {
      try {
        const data = await window.toolkit.callStatus();
        if (data.status) {
          lastStatus = data.status;
          paintCall(data.status);
        } else if (payload) {
          paintCall({
            ...(lastStatus || {}),
            callState: payload.state,
            callNumber: payload.number,
            callClip: payload.clip,
          });
        }
      } catch (_) {}
    });
  }
  if (window.toolkit.onIncomingCallPopup) {
    window.toolkit.onIncomingCallPopup((_payload) => {
      // v0.8: dedicated always-on-top corner window handles UI (works when minimized/tray)
      hideCallPopup();
    });
  }
  if (window.toolkit.onNewInboundSms) {
    window.toolkit.onNewInboundSms(() => {
      if (!busy) refreshSms();
    });
  }
  if (window.toolkit.onOpenSmsThread) {
    window.toolkit.onOpenSmsThread(async (payload) => {
      try {
        switchView('sms');
        if (!busy) await refreshSms();
        const peer = payload && payload.peer;
        if (peer) await selectThread(peer);
      } catch (_) {}
    });
  }

  // Settings checkboxes
  const settingBind = [
    ['setOpenAtLogin', 'openAtLogin'],
    ['setCloseToTray', 'closeToTray'],
    ['setPopupOnCall', 'popupOnCall'],
    ['setPopupOnSms', 'popupOnSms'],
    ['setSmsSound', 'smsSound'],
    ['setAutoConnect', 'autoConnect'],
    ['setFlashTrayOnRing', 'flashTrayOnRing'],
  ];
  for (const [id, key] of settingBind) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('change', () => saveSetting(key, el.checked));
  }

  const ringSel = $('setRingtone');
  if (ringSel) {
    ringSel.addEventListener('change', async () => {
      const val = ringSel.value;
      if (val === 'custom') {
        if (window.toolkit.pickCustomRingtone) {
          const result = await window.toolkit.pickCustomRingtone();
          if (result && result.settings) paintSettings(result.settings);
          else await saveSetting('ringtone', 'custom');
        } else {
          await saveSetting('ringtone', 'custom');
        }
      } else {
        await saveSetting('ringtone', val);
      }
    });
  }
  const volEl = $('setRingtoneVolume');
  if (volEl) {
    volEl.addEventListener('change', () => {
      const v = Math.max(0, Math.min(100, Number(volEl.value) || 0)) / 100;
      saveSetting('ringtoneVolume', v);
    });
  }
  if ($('btnPreviewRingtone')) {
    $('btnPreviewRingtone').onclick = () => previewRingtone();
  }
  if ($('btnPickRingtone')) {
    $('btnPickRingtone').onclick = async () => {
      try {
        const result = await window.toolkit.pickCustomRingtone();
        if (result && result.settings) paintSettings(result.settings);
        const note = $('settingsSaveNote');
        if (note && result && result.ok) note.textContent = '已选择本机自定义铃声（仅保存路径）。';
      } catch (e) {
        const note = $('settingsSaveNote');
        if (note) note.textContent = '选择失败: ' + (e.message || e);
      }
    };
  }
  if ($('btnClearRingtone')) {
    $('btnClearRingtone').onclick = async () => {
      try {
        const result = await window.toolkit.clearCustomRingtone();
        if (result && result.settings) paintSettings(result.settings);
        const note = $('settingsSaveNote');
        if (note) note.textContent = '已清除自定义路径，恢复苹果风。';
      } catch (e) {
        const note = $('settingsSaveNote');
        if (note) note.textContent = '清除失败: ' + (e.message || e);
      }
    };
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

  async function sendAtConsole(cmd) {
    const input = $('atInput');
    const out = $('atConsole');
    const line = String(cmd != null ? cmd : (input && input.value) || '').trim();
    if (!line) return;
    if (input) input.value = line;
    if (out) appendLog(out, `>>> ${line}`);
    setBusy(true);
    try {
      const result = await window.toolkit.atRaw(line);
      const raw = (result && (result.raw || result.error)) || '(无响应)';
      if (out) appendLog(out, raw + (result && result.ok === false ? '' : ''));
      if (result && result.status) {
        lastStatus = result.status;
        paintOverview(result.status);
      }
    } catch (e) {
      if (out) appendLog(out, '错误: ' + (e.message || e));
    } finally {
      setBusy(false);
    }
  }

  if ($('btnAtSend')) {
    $('btnAtSend').onclick = () => sendAtConsole();
  }
  if ($('atInput')) {
    $('atInput').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        sendAtConsole();
      }
    });
  }
  if ($('btnAtClear') && $('atConsole')) {
    $('btnAtClear').onclick = () => {
      $('atConsole').textContent = '';
    };
  }
  document.querySelectorAll('#atPresets [data-at]').forEach((btn) => {
    btn.addEventListener('click', () => sendAtConsole(btn.getAttribute('data-at')));
  });

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
      if (result.threads) renderThreads(result.threads);
      else await refreshSms();
    } catch (e) {
      setSmsStatus('清空失败: ' + (e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  if ($('btnClearThread')) {
    $('btnClearThread').onclick = () => clearActiveThread();
  }

  if ($('btnNewThread')) {
    $('btnNewThread').onclick = () => {
      activePeer = null;
      renderThreads(lastThreads);
      const to = $('smsTo');
      if (to) {
        to.value = '';
        to.focus();
      }
      switchView('sms');
    };
  }

  if ($('threadSearch')) {
    $('threadSearch').addEventListener('input', () => {
      threadSearch = $('threadSearch').value || '';
      renderThreads(lastThreads);
    });
  }

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
      // Prefer selecting the peer we just sent to
      if (result.threads) {
        lastThreads = result.threads;
        // Find matching peer
        const hit = result.threads.find(
          (t) =>
            displayPeerLocal(t.peer) === displayPeerLocal(to) ||
            String(t.peer).includes(to.replace(/\D/g, '').slice(-11))
        );
        if (hit) activePeer = hit.peer;
        renderThreads(result.threads);
      }
      await refreshSms();
      if (result.status) {
        setSmsStatus(result.status, !!(result.status.connected && !result.status.error));
      }
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

  // —— Call popup ——
  if ($('btnPopupAnswer')) {
    $('btnPopupAnswer').onclick = async () => {
      hideCallPopup();
      popupIgnored = false;
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
  }
  if ($('btnPopupHangup')) {
    $('btnPopupHangup').onclick = async () => {
      hideCallPopup();
      popupIgnored = false;
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
  }
  if ($('btnPopupIgnore')) {
    $('btnPopupIgnore').onclick = () => {
      popupIgnored = true;
      hideCallPopup();
    };
  }

  // —— Call page ——
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
      hideCallPopup();
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
      hideCallPopup();
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
    // If autoConnect already ran in main, reconnect is still fine / refreshes
    await window.toolkit.smsReconnect();
    await refreshSms();
  } catch (e) {
    setSmsStatus(String(e.message || e), false);
  } finally {
    setBusy(false);
  }
}

init();
