'use strict';

/**
 * Extract 4–8 digit OTP / verification codes from SMS body (Chinese + EN cues).
 * Shared by renderer and main-process SMS corner card.
 */
function extractOtpCodes(body) {
  const s = String(body || '');
  if (!s) return [];
  const found = [];
  const seen = new Set();
  const push = (code) => {
    const c = String(code || '');
    if (!/^\d{4,8}$/.test(c)) return;
    if (/^(19|20)\d{2}$/.test(c)) return;
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
    const cleaned = s.replace(/\+?86?1[3-9]\d{9}/g, ' ');
    const loose = cleaned.match(/(?<!\d)\d{4,8}(?!\d)/g) || [];
    for (const c of loose) {
      if (c.length === 4 || c.length === 6) push(c);
    }
  }
  return found.slice(0, 3);
}

module.exports = { extractOtpCodes };
