'use strict';

const numberEl = document.getElementById('callerNumber');
const audioEl = document.getElementById('ringAudio');
const btnAnswer = document.getElementById('btnAnswer');
const btnReject = document.getElementById('btnReject');

function stopRingtone() {
  try {
    audioEl.pause();
    audioEl.currentTime = 0;
    audioEl.removeAttribute('src');
    audioEl.load();
  } catch (_) {}
}

function startRingtone(payload) {
  stopRingtone();
  const fileUrl = payload && payload.ringtoneUrl;
  if (!fileUrl) return;
  const vol = typeof payload.volume === 'number' ? payload.volume : 0.85;
  audioEl.volume = Math.max(0, Math.min(1, vol));
  audioEl.src = fileUrl;
  audioEl.loop = true;
  const p = audioEl.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

if (window.callCard) {
  window.callCard.onShow((payload) => {
    const display = (payload && (payload.display || payload.number)) || '未知号码';
    numberEl.textContent = display;
    startRingtone(payload || {});
  });
  window.callCard.onHide(() => {
    stopRingtone();
  });
}

btnAnswer.addEventListener('click', async () => {
  stopRingtone();
  try {
    await window.callCard.answer();
  } catch (_) {}
});

btnReject.addEventListener('click', async () => {
  stopRingtone();
  try {
    await window.callCard.reject();
  } catch (_) {}
});

window.addEventListener('beforeunload', stopRingtone);
