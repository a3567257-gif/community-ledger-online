// 核心沖帳邏輯：先補前期欠款 -> 再抵當月 -> 剩餘轉預繳
// 純邏輯模組，不依賴 Electron／sql.js，main process 與測試都直接 require 這份檔案

function nextPeriod(p) {
  const [y, m] = p.split('-').map(Number);
  let ny = y, nm = m + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function statusOf(due, paid) {
  if (paid >= due) return '已繳';
  if (paid > 0) return '部分繳';
  return '未繳';
}

/**
 * ledgerRows: [{period, due, paid}]
 * amount: 這筆匯款金額
 * currentPeriod: 'YYYY-MM'，用來判斷前期/當月
 * getFeeForPeriod(period): 產生新一期(預繳)時的應繳金額
 * 回傳: { allocations, updatedRows }
 */
function allocatePayment({ ledgerRows, amount, currentPeriod, guardMax = 12, getFeeForPeriod }) {
  let remaining = amount;
  const allocations = [];
  const rows = ledgerRows.map(r => ({ ...r }));

  const outstanding = rows
    .filter(r => statusOf(r.due, r.paid) !== '已繳')
    .sort((a, b) => a.period.localeCompare(b.period));

  for (const r of outstanding) {
    if (remaining <= 0) break;
    const owed = r.due - r.paid;
    const pay = Math.min(remaining, owed);
    // 未繳清的月份可能在本期之後（例如上一筆預繳只繳到一半），那部分仍然是預繳，不是當月
    const type = r.period < currentPeriod ? '前期補繳' : r.period === currentPeriod ? '當月管理費' : '預繳管理費';
    allocations.push({ period: r.period, type, amount: pay });
    r.paid += pay;
    remaining -= pay;
  }

  if (remaining > 0) {
    const periods = rows.map(r => r.period).sort();
    let cursor = periods.length ? nextPeriod(periods[periods.length - 1]) : currentPeriod;
    let guard = 0;
    while (remaining > 0 && guard < guardMax) {
      let r = rows.find(x => x.period === cursor);
      if (!r) {
        r = { period: cursor, due: getFeeForPeriod ? getFeeForPeriod(cursor) : 0, paid: 0 };
        rows.push(r);
      }
      const owed = r.due - r.paid;
      const pay = Math.min(remaining, owed);
      allocations.push({ period: cursor, type: '預繳管理費', amount: pay });
      r.paid += pay;
      remaining -= pay;
      cursor = nextPeriod(cursor);
      guard++;
    }
    if (remaining > 0) {
      allocations.push({ period: null, type: '待人工確認', amount: remaining });
    }
  }

  return { allocations, updatedRows: rows };
}

// 每坪相關項目加總後，最後才四捨五入到整數
// 每月應繳＝坪數×類型每坪單價＋公共基金＋坪數×修繕基金提撥＋汽車清潔費＋汽車租金＋機車清潔費＋機車租金
// 清潔費（有停車就要收）跟租金（向社區承租車位才收）是兩筆不同性質的錢，分開存、分開顯示，計算時才加總。
function calcHouseholdTotal({ area, categoryRate, publicFundFee, buildingFundPerPing, carFee, carRent, motoFee, motoRent }) {
  const base = area * categoryRate;
  const bf = area * buildingFundPerPing;
  const n = v => Number(v) || 0;
  return Math.round(base + publicFundFee + bf + n(carFee) + n(carRent) + n(motoFee) + n(motoRent));
}

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

// 只留數字，濾掉銀行匯出檔常見的括號、字母代碼、空白等雜訊，例如 "(500137058ECT)" -> "500137058"
function extractDigits(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

// 民國年日期（例如 1150715 = 民國115年07月15日）轉成西元 YYYY-MM-DD；
// 辨識不出來就回傳 null，由呼叫端自行使用原始值
function parseRocDateLike(value) {
  const digits = extractDigits(value);
  if (digits.length === 6 || digits.length === 7) {
    const day = digits.slice(-2);
    const month = digits.slice(-4, -2);
    const rocYear = digits.slice(0, -4);
    const year = Number(rocYear) + 1911;
    return `${year}-${month}-${day}`;
  }
  return null;
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return row[key];
    }
  }
  return '';
}

// 把不同銀行匯出格式的一列資料，統一轉成 {date, accountRaw, accountDigits, amount, remark}
// 目前支援的欄位名稱：交易日期/日期/轉帳日期、虛擬帳號/轉入帳號/對方帳號/帳號、金額/存入金額/交易金額、備註/摘要/說明
// 各銀行的欄位名稱不同，這裡列出認得的寫法（欄名的空白已在讀檔時去掉，所以「收入 (存入)」會是「收入(存入)」）
const BANK_DATE_COLS = ['交易日期', '日期', '轉帳日期', '入帳日期', '記帳日'];
const BANK_ACCOUNT_COLS = ['虛擬帳號', '轉入帳號', '對方帳號', '帳號', '繳款帳號'];
const BANK_AMOUNT_COLS = ['存入金額', '收入(存入)', '收入', '存入', '存款金額', '入帳金額', '貸方金額', '金額', '交易金額'];
const BANK_REMARK_COLS = ['摘要', '備註', '說明', '附言'];

function normalizeBankRow(row) {
  const rawDate = pickField(row, BANK_DATE_COLS);
  const remark = pickField(row, BANK_REMARK_COLS);
  // 有些銀行沒有獨立的帳號欄，虛擬帳號寫在「摘要」裡，這時就從摘要取帳號
  let rawAccount = pickField(row, BANK_ACCOUNT_COLS);
  if (!rawAccount && /\d{6,}/.test(String(remark || ''))) rawAccount = remark;
  const rawAmount = pickField(row, BANK_AMOUNT_COLS);

  const rocDate = parseRocDateLike(rawDate);
  const date = rocDate || String(rawDate).trim();
  const accountDigits = extractDigits(rawAccount);
  const amount = Number(String(rawAmount).replace(/,/g, ''));

  return { date, accountRaw: String(rawAccount).trim(), accountDigits, amount, remark: String(remark || '').trim() };
}

// 用數字尾碼比對戶號跟銀行匯出的帳號（銀行常只顯示帳號後面幾碼），任一方向吻合即算比對成功
function findHouseholdByAccountDigits(households, accountDigits) {
  if (!accountDigits || accountDigits.length < 6) return null;
  return households.find(h => {
    const hDigits = extractDigits(h.account);
    return hDigits.endsWith(accountDigits) || accountDigits.endsWith(hDigits);
  });
}

// 銀行存摺上一格常常夾了好幾組數字，例如「99990-ATMF (101082491ECT) 7」：
// 99990 是分行/代碼、括號裡 101082491 才是虛擬帳號尾碼、最後的 7 是別的註記。
// 如果把所有數字接起來（999901010824917）就永遠對不到住戶。
// 所以改成把數字「一組一組」拆開，括號裡的那組優先，每組至少 6 碼才拿來比對。
function accountCandidates(raw) {
  const s = String(raw == null ? '' : raw);
  const out = [];
  const push = d => { if (d.length >= 6 && !out.includes(d)) out.push(d); };
  (s.match(/[（(][^）)]*[）)]/g) || []).forEach(p => (p.match(/\d+/g) || []).forEach(push));
  (s.match(/\d+/g) || []).forEach(push);
  push(extractDigits(s)); // 最後才用「全部數字接起來」，相容原本只有一組數字的格式
  return out;
}

// 依候選數字找住戶：找到剛好一戶才算比對成功；
// 同一組數字對到兩戶以上時不猜，回傳 ambiguous，交給人工比對。
function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function matchHouseholdByAccount(households, raw) {
  const cands = accountCandidates(raw);
  // 1. 完全相同，或銀行只顯示帳號的後幾碼（尾碼相符）
  for (const cand of cands) {
    const hits = households.filter(h => {
      const hDigits = extractDigits(h.account);
      return hDigits && (hDigits.endsWith(cand) || cand.endsWith(hDigits));
    });
    if (hits.length === 1) return { household: hits[0], ambiguous: false, matchedDigits: cand, method: 'exact' };
    if (hits.length > 1) return { household: null, ambiguous: true, matchedDigits: cand, candidates: hits.map(h => h.unit) };
  }
  // 2. 很多銀行的虛擬帳號，最後幾碼是會隨金額或日期變動的「檢核碼」，
  //    例如住戶資料是 99990101082491，銀行入帳顯示 99990101082482：前 10 碼（含戶別碼）相同、末 4 碼不同。
  //    所以同樣長度的帳號，前面相同的位數最多、而且只有一戶、最多只差最後 4 碼，就算比對成功。
  //    兩戶以上一樣接近時不猜，交給人工。
  for (const cand of cands) {
    if (cand.length < 10) continue;
    let best = 0, hits = [];
    households.forEach(h => {
      const hDigits = extractDigits(h.account);
      if (hDigits.length !== cand.length) return;
      const n = commonPrefixLength(hDigits, cand);
      if (n > best) { best = n; hits = [h]; } else if (n === best) hits.push(h);
    });
    if (best >= cand.length - 4 && best > 0) {
      if (hits.length === 1) return { household: hits[0], ambiguous: false, matchedDigits: cand, method: 'prefix', prefixLength: best };
      return { household: null, ambiguous: true, matchedDigits: cand, candidates: hits.map(h => h.unit) };
    }
  }
  return { household: null, ambiguous: false };
}

module.exports = {
  nextPeriod, statusOf, allocatePayment, calcHouseholdTotal, parseCSV,
  extractDigits, parseRocDateLike, normalizeBankRow, findHouseholdByAccountDigits,
  accountCandidates, matchHouseholdByAccount, BANK_ACCOUNT_COLS, BANK_AMOUNT_COLS, BANK_REMARK_COLS,
};
