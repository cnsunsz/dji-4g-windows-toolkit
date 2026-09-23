'use strict';

const fromEl = document.getElementById('smsFrom');
const previewEl = document.getElementById('smsPreview');
const otpRow = document.getElementById('otpRow');
const audioEl = document.getElementById('smsAudio');
const btnOpen = document.getElementById('btnOpen');
const btnDismiss = document.getElementById('btnDismiss');

let currentPeer = null;

function stopSound() {
  try {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  } catch (_) {}
}

function playSound(payload) {
  stopSound();
  const url = payload && payload.soundUrl;
  if (!url) return;
  const vol = typeof payload.volume === 'number' ? payload.volume : 0.7;
  audioEl.volume = Math.max(0, Math.min(1, vol));
  audioEl.src = url;
  audioEl.loop = false;
  const p = audioEl.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function paintOtps(codes) {
  otpRow.innerHTML = '';
  const list = Array.isArray(codes) ? codes.filter(Boolean) : [];
  if (!list.length) {
    otpRow.hidden = true;
    return;
  }
  otpRow.hidden = false;
  for (const code of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'otp-chip';
    btn.textContent = `验证码 ${code}`;
    btn.title = '复制验证码';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(code));
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = `验证码 ${code}`; }, 1200);
      } catch (_) {}
    });
    otpRow.appendChild(btn);
  }
}

if (window.smsCard) {
  window.smsCard.onShow((payload) => {
    currentPeer = (payload && (payload.peer || payload.from || payload.number)) || null;
    fromEl.textContent = (payload && (payload.display || payload.from || payload.number)) || '未知发件人';
    previewEl.textContent = (payload && (payload.preview || payload.body || '')) || '';
    paintOtps(payload && payload.otps);
    playSound(payload || {});
  });
  window.smsCard.onHide(() => {
    stopSound();
  });
}

btnOpen.addEventListener('click', async () => {
  stopSound();
  try {
    await window.smsCard.open(currentPeer);
  } catch (_) {}
});

btnDismiss.addEventListener('click', async () => {
  stopSound();
  try {
    await window.smsCard.dismiss();
  } catch (_) {}
});

window.addEventListener('beforeunload', stopSound);
