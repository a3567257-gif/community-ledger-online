// 授權判斷（線上版）。規則跟離線版 shared/license.js 相同，只是授權不再是「綁電腦的授權碼」，
// 而是樓管家最高管理者在後台替每個社區設定的「可使用到哪一期」（communities.license_until）。
//
// 判斷規則（兩個條件都要成立才算有效，否則社區進入唯讀：可查看、匯出報表、下載備份，不能新增或修改帳務）：
//   1. 本期 ≤ 授權期別：本期只有按「本期結帳」才會前進，所以授權期別那一期可以完整做完月結；
//      結帳進入下一期後，就需要延長授權。
//   2. 日期保險：授權期別結束後再過 GRACE_DAYS 天，就算一直不結帳也會進入唯讀，避免「永遠不結帳」一直用下去。

const P = require('./period.js');

const GRACE_DAYS = 20;

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return P.todayISO(dt);
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// status：missing（還沒設定授權）、expired-period（本期已超過授權期別）、expired-date（超過寬限日期）、active（有效）
function evaluate({ until, currentPeriod, closingDay, today, lastSeen }) {
  const effectiveToday = maxDate(today, lastSeen);
  const base = { active: false, effectiveToday, until: until || null };
  if (!until || !/^\d{4}-\d{2}$/.test(until)) return { ...base, status: 'missing' };
  const deadline = addDays(P.periodRange(until, closingDay).end, GRACE_DAYS);
  const ok = { ...base, deadline, isLastPeriod: currentPeriod === until };
  if (currentPeriod && currentPeriod > until) return { ...ok, status: 'expired-period' };
  if (effectiveToday > deadline) return { ...ok, status: 'expired-date' };
  return { ...ok, status: 'active', active: true };
}

// 給畫面顯示的說明文字
function describe(s) {
  const until = s.until ? P.rocPeriod(s.until) : '';
  switch (s.status) {
    case 'missing': return '這個社區還沒有設定授權。';
    case 'expired-period': return `授權只到 ${until} 期，目前本期已超過授權範圍。`;
    case 'expired-date': return `授權只到 ${until} 期，已超過使用期限 ${P.rocDate(s.deadline)}。`;
    case 'active': return `授權使用至 ${until} 期（最晚 ${P.rocDate(s.deadline)}）。`;
    default: return '';
  }
}

module.exports = { evaluate, describe, addDays, GRACE_DAYS };
