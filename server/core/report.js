// 產生月結報表（.xlsx），欄位/版面盡量比照社區原本在用的 Excel 範本：
// 管理費收入明細、未繳名單、預繳名單。
// 這裡用 SheetJS 的社群版，能正確產生資料列與欄位結構，但不支援儲存格底色/框線等樣式，
// 社區打開後版面會比原本範本樸素一些，但資料是完整、可以直接使用的。

const XLSX = require('xlsx');

function isoPeriodToRoc(period) {
  const [y, m] = String(period).split('-');
  return { rocYear: Number(y) - 1911, month: m };
}

// 系統統一寫法：月份 115/07、日期 115/07/15；報表裡的月份欄名也用 115/07，
// 跟匯入範本一致，匯出的未繳／預繳名單可以直接拿來當下次的匯入檔。
function rocPeriodLabel(period) {
  if (!period) return '';
  const { rocYear, month } = isoPeriodToRoc(period);
  return `${rocYear}/${month}`;
}

function rocMonthHeader(period) {
  return rocPeriodLabel(period);
}

// 「未繳名單匯入」「預繳名單匯入」「本期已繳（期初…）」是系統內部的來源標記，不印在報表上；
// 年繳／半年繳優惠等有意義的備註才保留。
function isSystemNote(note) {
  return /^(未繳名單匯入|預繳名單匯入|本期已繳（期初)/.test(String(note));
}

let COMMUNITY = '社區';
let RANGE = '';

function rocDateLabel(iso) {
  if (!iso) return '';
  const parts = String(iso).split('-');
  if (parts.length < 2) return String(iso);
  const [y, m, d] = parts;
  return `${Number(y) - 1911}/${m}${d ? '/' + d : ''}`;
}

function buildIncomeSheet(period, rows) {
  const label = rocPeriodLabel(period);
  const aoa = [];
  aoa.push([`${COMMUNITY} ${label} 管理費收入明細${RANGE}`]);
  aoa.push(['入帳日期', '內容摘要', '住戶名稱', '入帳方式', '繳款月份/期別', '前期補繳', '本期管理費', '預繳', '合計']);

  let sumPrior = 0, sumCurrent = 0, sumPrepay = 0, sumTotal = 0;
  rows.forEach(r => {
    aoa.push([
      rocDateLabel(r.date), '管理費收入', r.unit, 'ATM',
      r.periodRange ? rocPeriodRangeLabel(r.periodRange) : '',
      r.prior || '', r.current || '', r.prepay || '', r.total,
    ]);
    sumPrior += r.prior || 0; sumCurrent += r.current || 0; sumPrepay += r.prepay || 0; sumTotal += r.total || 0;
  });
  aoa.push(['收入合計', '', '', '', '', sumPrior, sumCurrent, sumPrepay, sumTotal]);
  return XLSX.utils.aoa_to_sheet(aoa);
}

function rocPeriodRangeLabel(range) {
  // range 是 'YYYY-MM' 或 'YYYY-MM~YYYY-MM'
  const parts = String(range).split('~');
  return parts.map(p => {
    const { rocYear, month } = isoPeriodToRoc(p);
    return `${rocYear}/${month}`;
  }).join('~');
}

function buildUnpaidSheet(period, rows) {
  const label = rocPeriodLabel(period);
  const periods = Array.from(new Set(rows.map(r => r.period))).sort();
  const aoa = [];
  aoa.push([`${COMMUNITY} 管理費未繳明細（截至 ${label}）`]);
  aoa.push(['戶號', '每月應繳管理費', ...periods.map(p => rocMonthHeader(p)), '未繳合計', '備註']);

  const byUnit = new Map();
  rows.forEach(r => {
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, { unit: r.unit, due: r.amountDue, byPeriod: {}, notes: new Set() });
    const h = byUnit.get(r.unit);
    h.byPeriod[r.period] = r.amountOwed;
    if (r.amountDue) h.due = r.amountDue;
    if (r.note && !isSystemNote(r.note)) h.notes.add(r.note);
  });

  const totals = periods.map(() => 0);
  let grand = 0;
  Array.from(byUnit.values())
    .sort((a, b) => a.unit.localeCompare(b.unit))
    .forEach(h => {
      let rowTotal = 0;
      const cells = periods.map((p, i) => {
        const v = h.byPeriod[p] || 0;
        totals[i] += v;
        rowTotal += v;
        return v || '';
      });
      grand += rowTotal;
      aoa.push([h.unit, h.due, ...cells, rowTotal, Array.from(h.notes).join('；')]);
    });
  aoa.push(['合計未繳', '', ...totals, grand, '']);
  return XLSX.utils.aoa_to_sheet(aoa);
}

function buildPrepaidSheet(period, rows) {
  const label = rocPeriodLabel(period);
  const periods = Array.from(new Set(rows.map(r => r.period))).sort();
  const aoa = [];
  aoa.push([`${COMMUNITY} 管理費預繳明細（本期 ${label}）`]);
  aoa.push(['戶號', '每月應繳', ...periods.map(p => rocMonthHeader(p)), '合計', '備註']);

  const byUnit = new Map();
  rows.forEach(r => {
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, { unit: r.unit, due: r.amountDue, byPeriod: {}, notes: new Set() });
    const h = byUnit.get(r.unit);
    h.byPeriod[r.period] = r.amountPaid;
    if (r.amountDue) h.due = r.amountDue;
    if (r.note && !isSystemNote(r.note)) h.notes.add(r.note);
  });

  const totals = periods.map(() => 0);
  let grand = 0;
  Array.from(byUnit.values())
    .sort((a, b) => a.unit.localeCompare(b.unit))
    .forEach(h => {
      let rowTotal = 0;
      const cells = periods.map((p, i) => {
        const v = h.byPeriod[p] || 0;
        totals[i] += v;
        rowTotal += v;
        return v || '';
      });
      grand += rowTotal;
      aoa.push([h.unit, h.due, ...cells, rowTotal, Array.from(h.notes).join('；')]);
    });
  aoa.push(['合計預繳', '', ...totals, grand, '']);
  return XLSX.utils.aoa_to_sheet(aoa);
}

function buildMonthlyReportWorkbook(period, { incomeRows, unpaidRows, prepaidRows, communityName, range }) {
  COMMUNITY = communityName || '社區';
  RANGE = range ? `（${rocDateLabel(range.start)}～${rocDateLabel(range.end)}）` : '';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildIncomeSheet(period, incomeRows || []), '管理費收入明細');
  XLSX.utils.book_append_sheet(wb, buildUnpaidSheet(period, unpaidRows || []), '未繳名單');
  XLSX.utils.book_append_sheet(wb, buildPrepaidSheet(period, prepaidRows || []), '預繳名單');
  return wb;
}

module.exports = { buildMonthlyReportWorkbook, rocPeriodLabel, rocDateLabel };
