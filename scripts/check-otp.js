'use strict';

/**
 * Lightweight OTP extractor check (mirrors renderer extractOtpCodes logic).
 * Run: npm run check:otp
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

const cases = [
  ['【银行】验证码 384921，5分钟内有效', ['384921']],
  ['Your code is 5821', ['5821']],
  ['动态密码：906633请勿泄露', ['906633']],
  ['123456为您的验证码', ['123456']],
  ['普通短信无码 你好', []],
  ['来自 13800138000 的通知', []],
];

let failed = 0;
for (const [input, expect] of cases) {
  const got = extractOtpCodes(input);
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(ok ? 'OK ' : 'FAIL', JSON.stringify(input), '=>', got);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`Failed ${failed} case(s)`);
  process.exit(1);
}
console.log('All OTP cases passed');
