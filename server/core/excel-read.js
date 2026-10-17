// 讀取匯入用的 Excel 檔案（住戶資料、未繳名單、預繳名單、銀行明細共用）。
// 跟離線版 excel-read.js 相同，只差在線上版讀的是「上傳的檔案內容（Buffer）」而不是電腦上的檔案路徑。
const path = require('path');
const XLSX = require('xlsx');
const store = require('./store.js');

function assertExcelName(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xls') {
    throw new Error('只能匯入 Excel 檔案（.xlsx 或 .xls），請用 Excel 另存新檔後再匯入。');
  }
}

function readWorkbook(buffer, filename) {
  assertExcelName(filename);
  try {
    return XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    throw new Error('這個檔案打不開，請確認是正常的 Excel 檔案。');
  }
}

// 只讀第一個工作表。
// 欄位名稱會先去掉所有空白（例如「汽車　　清潔費」→「汽車清潔費」、「預繳\n115年12月」→「預繳115年12月」）。
function readExcelRows(workbook, headerRow) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', range: headerRow - 1 });
  // 欄位名稱列本身（就算底下完全沒有資料，也要能判斷這是不是正確的範本）
  const headerCells = (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', range: headerRow - 1 })[0] || [])
    .map(k => store.normalizeHeaderKey(k)).filter(Boolean);
  const rows = raw.map(r => {
    const o = {};
    Object.keys(r).forEach(k => { o[store.normalizeHeaderKey(k)] = r[k]; });
    // 保留 Excel 列號，錯誤訊息才能對照 Excel 畫面左邊的列號
    if (typeof r.__rowNum__ === 'number') Object.defineProperty(o, '__rowNum__', { value: r.__rowNum__, enumerable: false });
    return o;
  });
  Object.defineProperty(rows, 'headerKeys', { value: headerCells, enumerable: false });
  return rows;
}

// 範本規定：第 1 列報表標題、第 2 列欄位名稱（銀行明細是第 1 列）。
// 系統仍在前 5 列自動找欄位名稱列當保險，萬一有人刪掉或多加了標題列，也不會整份讀不到。
function readWithHeaderDetect(buffer, filename, recognized) {
  const wb = readWorkbook(buffer, filename);
  for (let hr = 1; hr <= 5; hr++) {
    const rows = readExcelRows(wb, hr);
    if (recognized(rows)) return { rows, headerRow: hr };
  }
  return null;
}

function keysOf(rows) {
  const keys = new Set(rows.headerKeys || []);
  rows.slice(0, 3).forEach(r => Object.keys(r).forEach(k => keys.add(k)));
  return keys;
}
const hasUnitColumn = rows => store.UNIT_ALIASES.some(a => keysOf(rows).has(a));
const { BANK_ACCOUNT_COLS, BANK_AMOUNT_COLS, BANK_REMARK_COLS } = require('./fifo.js');
// 銀行明細：要有金額欄，加上帳號欄或摘要欄（有些銀行把虛擬帳號寫在摘要裡）
const hasBankColumns = rows => {
  const k = keysOf(rows);
  return BANK_AMOUNT_COLS.some(a => k.has(a)) && (BANK_ACCOUNT_COLS.some(a => k.has(a)) || BANK_REMARK_COLS.some(a => k.has(a)));
};

module.exports = { readExcelRows, readWithHeaderDetect, hasUnitColumn, hasBankColumns };
