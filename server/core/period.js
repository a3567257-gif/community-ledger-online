// 期別與結算日的計算（純邏輯，不依賴 Electron，可直接用 Node 測試）
//
// 期別一律存成西元 'YYYY-MM'；畫面上顯示民國年 115/07。
// 結算日 closingDay：
//   0     ＝ 月底結算，115/08 這一期的範圍是 115/08/01～115/08/31
//   1～28 ＝ 每月這一天結算，例如 10：115/08 這一期的範圍是 115/08/11～115/09/10
//           （跟社區報表「08月收入明細（08/11~09/10）」的算法相同）

function pad(n) { return String(n).padStart(2, '0'); }

function nextPeriod(p) {
  const [y, m] = p.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

function prevPeriod(p) {
  const [y, m] = p.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

function lastDayOf(y, m) {
  return new Date(y, m, 0).getDate(); // m 是 1～12，new Date(y, m, 0) 是該月最後一天
}

function periodRange(period, closingDay) {
  const [y, m] = period.split('-').map(Number);
  const d = Number(closingDay) || 0;
  if (!d) {
    return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDayOf(y, m))}` };
  }
  const [ny, nm] = nextPeriod(period).split('-').map(Number);
  return { start: `${y}-${pad(m)}-${pad(d + 1)}`, end: `${ny}-${pad(nm)}-${pad(d)}` };
}

// 依今天日期，算出「今天這筆錢屬於哪一期」
function periodContaining(dateISO, closingDay) {
  const [y, m, day] = dateISO.split('-').map(Number);
  const p = `${y}-${pad(m)}`;
  const d = Number(closingDay) || 0;
  if (!d) return p;
  return day > d ? p : prevPeriod(p);
}

function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// 本期是否落後：今天所屬期別的「前一期」通常還在做月結報表，所以本期落後 2 期以上才提醒。
function periodsBehind(currentPeriod, dateISO, closingDay) {
  let p = currentPeriod, n = 0;
  const target = periodContaining(dateISO, closingDay);
  while (p < target && n < 240) { p = nextPeriod(p); n++; }
  return n;
}

function rocPeriod(p) {
  const [y, m] = String(p || '').split('-');
  return y && m ? `${Number(y) - 1911}/${m}` : '';
}

function rocDate(iso) {
  const [y, m, d] = String(iso || '').split('-');
  return y && m && d ? `${Number(y) - 1911}/${m}/${d}` : String(iso || '');
}

module.exports = { nextPeriod, prevPeriod, periodRange, periodContaining, todayISO, periodsBehind, rocPeriod, rocDate };
