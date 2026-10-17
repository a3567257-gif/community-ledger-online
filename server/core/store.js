// 資料儲存與業務邏輯層（線上版）。
// 跟離線版 store.js 是同一份業務邏輯，只改了「資料放在哪裡」：
//   離線版：一個社區一份 JSON 檔案；
//   線上版：一個社區一份 JSON 文件，存在資料庫 community_data.doc。
// 伺服器每次處理請求時：useDoc(資料庫裡的 doc) → 呼叫下面的函式 → takeDoc() 寫回資料庫。
// useDoc 到 takeDoc 之間全部是同步程式，不會跟別的請求交錯，所以模組變數 store 是安全的。
// 原本「複製一份資料檔當備份」的地方，改成 safetyBackup() 把快照放進待寫清單，
// 由伺服器跟 doc 在同一個交易裡寫進 snapshots 資料表。
// 業務邏輯修改時，請盡量跟離線版保持一致（test/core.golden.test.js 會比對兩邊結果）。

const P = require('./period.js');
const { allocatePayment, calcHouseholdTotal, statusOf, parseCSV, normalizeBankRow, findHouseholdByAccountDigits, matchHouseholdByAccount } = require('./fifo.js');

let store = null;
let pendingSnapshots = []; // 這次請求要寫進 snapshots 資料表的快照 [{ reason, label, doc }]

function freshStore() {
  return {
    communityInfo: { code: 'A001', name: '示範社區', closingDay: 10 },
    rateVersions: [
      {
        id: 1,
        effectiveFrom: '2026-01',
        effectiveTo: null,
        categoryRates: { '店面': 60, '大樓住宅': 70 },
        publicFundFee: 200,
        buildingFundPerPing: 10,
        annualDiscount: 0,     // 年繳折扣率，例如 0.95 代表95折；0 代表不提供
        semiAnnualDiscount: 0, // 半年繳折扣率；0 代表不提供
      },
    ],
    households: [],
    householdLedger: [],
    importBatches: [],
    bankTransactions: [],
    paymentAllocations: [],
    generatedPeriods: [],
    currentPeriod: null,   // 本期（開帳時設定，之後只能透過「本期結帳」往下一期推進）
    closedPeriods: [],     // 已結帳的期別紀錄 [{ period, closedAt }]
    setup: { noOpeningUnpaid: false, noOpeningPrepaid: false, periodConfirmed: false }, // 開帳檢查清單：社區確認「沒有期初欠繳／預繳」時勾選
    security: { managerPasswordHash: null, managerPasswordSalt: null }, // 未設定密碼＝任何人都能以「社區主任」身份進入（維持目前預設的開放狀態）
    nextIds: { household: 1, ledger: 1, batch: 1, transaction: 1, allocation: 1 },
  };
}

function nextId(key) {
  const id = store.nextIds[key];
  store.nextIds[key] += 1;
  return id;
}

function currentRateVersion() {
  return store.rateVersions.find(v => v.effectiveTo === null) || store.rateVersions[store.rateVersions.length - 1];
}

// 社區第一次使用時，只匯入「住戶主檔」——不自動假設「上期已全部繳清」。
// 每一戶期初到底繳到哪個月、有沒有預繳，請用「未繳名單」「預繳名單」頁面明確登記，
// 避免系統用錯誤的假設，把補繳款誤判成當期或預繳款（這正是社區主任交接時最容易出錯的地方）。
// 線上版：seed 直接傳物件（assets/demo_seed.json 的內容），不讀檔案
function seedFromHouseholdsJson(seed) {
  // 新格式：{ communityInfo, rates, households }（示範版的虛構社區）；舊格式：直接是住戶陣列
  const list = Array.isArray(seed) ? seed : (seed.households || []);
  if (!Array.isArray(seed)) {
    if (seed.communityInfo) store.communityInfo = { ...store.communityInfo, ...seed.communityInfo };
    if (seed.rates) Object.assign(store.rateVersions[0], seed.rates);
    if (seed.currentPeriod) {
      store.currentPeriod = seed.currentPeriod;
      store.rateVersions[0].effectiveFrom = seed.currentPeriod;
      store.setup = { ...(store.setup || {}), periodConfirmed: true };
    }
  }
  list.forEach(h => {
    const householdId = nextId('household');
    store.households.push({
      id: householdId,
      unit: h.unit,
      category: h.category,
      account: h.account,
      area: h.area,
      carFee: h.carFee || 0,
      carRent: h.carRent || 0,
      carStatus: h.carStatus || '無',
      motoFee: h.motoFee || 0,
      motoRent: h.motoRent || 0,
      motoStatus: h.motoStatus || '無',
      isActive: true,
    });
  });
}

// 正式版：完全空白的社區（沒有住戶、沒有示範費率、沒有社區名稱），第一次開啟時由社區主任自己設定。
function blankStore(currentPeriod) {
  const s = freshStore();
  s.communityInfo = { code: '', name: '', closingDay: 0 };
  s.currentPeriod = currentPeriod || null;
  const rv = s.rateVersions[0];
  if (currentPeriod) rv.effectiveFrom = currentPeriod; // 第一次設定費率時直接改這一版，不會多出一筆空白的歷史版本
  rv.categoryRates = {};
  rv.publicFundFee = 0;
  rv.buildingFundPerPing = 0;
  return s;
}

function looksLikeValidData(parsed) {
  return !!parsed && Array.isArray(parsed.households) && Array.isArray(parsed.householdLedger) && Array.isArray(parsed.rateVersions);
}

// 舊版資料檔（沒有這些欄位時）補上預設值，讓新功能可以安全套用在舊資料上
function ensureBackwardCompat() {
  if (!store.generatedPeriods) store.generatedPeriods = [];
  if (!store.security) store.security = { managerPasswordHash: null, managerPasswordSalt: null };
  if (!store.setup) store.setup = { noOpeningUnpaid: false, noOpeningPrepaid: false };
  if (!store.closedPeriods) store.closedPeriods = [];
  if (!store.currentPeriod) store.currentPeriod = '2026-07'; // v5 以前的資料檔：本期固定是 115/07
  if (store.setup.periodConfirmed === undefined) {
    store.setup.periodConfirmed = store.households.length > 0 || store.householdLedger.length > 0;
  }
  if (!store.communityInfo) store.communityInfo = { code: '', name: '', closingDay: 0 };
  if (store.communityInfo.closingDay === undefined) store.communityInfo.closingDay = 0;
  store.households.forEach(h => {
    if (h.carRent === undefined) h.carRent = 0;
    if (h.motoRent === undefined) h.motoRent = 0;
  });
}

// ---------- 線上版：載入／取出一個社區的資料 ----------
// 管理密碼（離線版的 security 欄位）線上版不用，改成正式的使用者帳號（server/auth.js）。

function useDoc(doc) {
  if (!looksLikeValidData(doc)) throw new Error('社區資料格式不正確');
  store = doc;
  pendingSnapshots = [];
  ensureBackwardCompat();
}

function takeDoc() {
  return store;
}

function takeSnapshots() {
  const s = pendingSnapshots;
  pendingSnapshots = [];
  return s;
}

// 建立一個新社區的資料：正式版是完全空白的社區，示範版載入虛構的示範社區
function newCommunityDoc({ blankPeriod, seed } = {}) {
  store = blankPeriod ? blankStore(blankPeriod) : freshStore();
  if (!blankPeriod && seed) seedFromHouseholdsJson(seed);
  ensureBackwardCompat();
  pendingSnapshots = [];
  return store;
}

function getRecoveryNotice() {
  return null; // 線上版沒有「資料檔案損毀」這回事（資料庫交易保證不會寫一半）
}

// 離線版這裡會寫檔；線上版由伺服器在請求結束時把 takeDoc() 寫回資料庫，這裡什麼都不用做。
// 保留這個函式，業務邏輯的寫法才能跟離線版一致。
function persist() {}

// 還原前一定先把「還原前的目前資料」也存一份快照，
// 這樣如果選錯備份、還原後才發現不對，還能救回來，不會愈救愈糟。
function restoreFromDoc(parsed) {
  if (!looksLikeValidData(parsed)) {
    throw new Error('這個檔案看起來不是社區帳房的資料檔，無法還原');
  }
  const safetyBackupPath = safetyBackup('before-restore');
  store = parsed;
  ensureBackwardCompat();
  persist();
  return { safetyBackupPath };
}

// 開始一個全新的空白社區：清空住戶、帳款、銀行明細、費率（不帶示範資料）。
// 清空前一定先把目前的資料完整存一份快照，隨時可以從「備份與還原」頁還原回來。
function startBlankCommunity(currentPeriod) {
  const safetyBackupPath = safetyBackup('before-new-community');
  store = blankStore(currentPeriod);
  persist();
  return { safetyBackupPath };
}

// 還原成示範資料（示範版專用）：清空後重新載入內建的虛構示範社區。
function resetStore(seed) {
  const safetyBackupPath = safetyBackup('before-reset-demo');
  store = freshStore();
  if (seed) seedFromHouseholdsJson(seed);
  ensureBackwardCompat();
  persist();
  return { safetyBackupPath };
}

function paidAmountForLedger(ledgerId) {
  const reversed = reversedAllocationIds();
  return store.paymentAllocations
    .filter(a => a.ledgerId === ledgerId && !a.isReversal && !reversed.has(a.id))
    .reduce((sum, a) => sum + a.amount, 0);
}

// ---------- 復原匯入（沖銷）----------
// 收款分配紀錄（payment_allocations）一律不刪、不改：復原時是「另外寫一筆沖銷紀錄」指向原本那筆，
// 原本那筆從此不再計入已繳金額。這樣事後查帳看得到「哪天匯入、哪天復原」，不會有錢憑空消失。
function reversedAllocationIds() {
  const s = new Set();
  store.paymentAllocations.forEach(a => { if (a.isReversal && a.reversalOfId) s.add(a.reversalOfId); });
  return s;
}

function activeTx(tx) {
  return tx && !tx.voidedAt;
}

const OPENING_BATCH_TYPES = ['opening_prepaid', 'opening_unpaid', 'seed'];
const OPENING_LEDGER_NOTES = ['預繳名單匯入', '本期已繳（期初'];

// 離線版是把目前的資料檔複製一份；線上版是把「這個動作做之前」的資料存成快照（呼叫時還沒開始改資料）。
// 回傳快照名稱，畫面上用來告訴使用者「已經自動備份，名稱是 …」。
function safetyBackup(prefix) {
  if (!store) return null;
  const label = `${prefix}-${Date.now()}`;
  pendingSnapshots.push({ reason: prefix, label, doc: JSON.parse(JSON.stringify(store)) });
  return label;
}

// 沖銷一批交易：寫沖銷紀錄、交易標記作廢；
// 這些交易套用過的年繳／半年繳優惠還原成原價；
// 因為這些交易才建立、現在已經沒有任何收款的「未來月份」帳款列一併移除（不然會留下空的預繳月份）。
function voidTransactions(txIds, reason) {
  const now = new Date().toISOString();
  const reversed = reversedAllocationIds();
  const affectedLedgerIds = new Set();
  store.paymentAllocations
    .filter(a => txIds.has(a.transactionId) && !a.isReversal && !reversed.has(a.id))
    .forEach(a => {
      store.paymentAllocations.push({
        id: nextId('allocation'), transactionId: a.transactionId, householdId: a.householdId, ledgerId: a.ledgerId,
        period: a.period, type: a.type, amount: a.amount, isReversal: true, reversalOfId: a.id, createdAt: now, reason,
      });
      if (a.ledgerId) affectedLedgerIds.add(a.ledgerId);
    });
  store.bankTransactions.forEach(tx => {
    if (txIds.has(tx.id) && !tx.voidedAt) { tx.voidedAt = now; tx.voidReason = reason; }
  });

  const rv = currentRateVersion();
  const cur = store.currentPeriod;
  const removable = new Set();
  store.householdLedger.forEach(l => {
    if (!affectedLedgerIds.has(l.id)) return;
    if (/繳優惠（/.test(l.note || '')) {
      const h = store.households.find(x => x.id === l.householdId);
      if (h) l.amountDue = householdMonthlyFee(h, rv);
      l.note = undefined;
    }
    const isOpening = OPENING_LEDGER_NOTES.some(n => String(l.note || '').startsWith(n));
    if (paidAmountForLedger(l.id) === 0 && ((l.period > cur && !l.note) || isOpening)) removable.add(l.id);
  });
  store.householdLedger = store.householdLedger.filter(l => !removable.has(l.id));
  return { removedLedgerRows: removable.size };
}

function bankBatchesForPeriod(period) {
  return store.importBatches
    .filter(b => !OPENING_BATCH_TYPES.includes(b.sourceType) && b.sourceType !== 'households')
    .map(b => {
      const txs = store.bankTransactions.filter(t => t.batchId === b.id);
      return { batch: b, txs };
    })
    .filter(x => x.txs.length && x.txs.every(t => t.period === period));
}

// 本期銀行明細匯入紀錄。只有「最後一次」可以復原：
// 錢是照先後順序沖帳的（先補最舊欠款），後面匯入的錢是在前面那次的結果上沖帳，
// 先復原前面那次會讓後面那次的月份歸屬全部錯掉，所以一定要從最後一次往回復原。
function listBankImports() {
  const cur = store.currentPeriod;
  const reversed = reversedAllocationIds();
  const list = bankBatchesForPeriod(cur).map(({ batch, txs }) => ({
    batchId: batch.id, filename: batch.filename, importedAt: batch.importedAt, undoneAt: batch.undoneAt || null,
    count: txs.length, amount: txs.reduce((s, t) => s + t.amount, 0),
    unmatched: txs.filter(t => !t.matchedHouseholdId).length,
  }));
  const open = list.filter(x => !x.undoneAt).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  const latest = open[0];
  if (latest) {
    const txIds = new Set(store.bankTransactions.filter(t => t.batchId === latest.batchId).map(t => t.id));
    const later = store.paymentAllocations.some(a => !a.isReversal && !reversed.has(a.id) && !txIds.has(a.transactionId) && a.createdAt > latest.importedAt);
    latest.canUndo = !later;
    if (later) latest.undoBlockedReason = '這次匯入之後，又有其他入帳做了人工比對，請先處理那筆';
  }
  return list.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

function undoBankImport(batchId) {
  const item = listBankImports().find(x => x.batchId === batchId);
  if (!item) throw new Error('找不到這次匯入，或這次匯入不是本期的（已結帳的期別不能復原）');
  if (item.undoneAt) throw new Error('這次匯入已經復原過了');
  if (!item.canUndo) {
    throw new Error(item.undoBlockedReason || '只能復原本期「最後一次」匯入的銀行明細。要復原比較早的匯入，請先從最後一次開始往回復原。');
  }
  const safetyBackupPath = safetyBackup('before-undo-bank');
  const txIds = new Set(store.bankTransactions.filter(t => t.batchId === batchId && !t.voidedAt).map(t => t.id));
  const batch = store.importBatches.find(b => b.id === batchId);
  voidTransactions(txIds, `復原匯入：${batch.filename}`);
  batch.undoneAt = new Date().toISOString();
  persist();
  return { filename: batch.filename, count: txIds.size, amount: item.amount, safetyBackupPath };
}

// ---------- 清除期初未繳／預繳名單（開帳時匯錯，重新匯入）----------
// 只能在「產生本期帳款之前、還沒匯入任何銀行明細」時清除：之後的帳都是在期初名單的基礎上算的。
function assertOpeningEditable(label) {
  if (periodAlreadyGenerated(store.currentPeriod)) {
    throw new Error(`本期帳款已經產生，不能再清除${label}。開帳資料有錯，請從「備份・授權」還原到產生帳款之前的備份。`);
  }
  const realTx = store.bankTransactions.some(t => activeTx(t) && !OPENING_BATCH_TYPES.includes((store.importBatches.find(b => b.id === t.batchId) || {}).sourceType));
  if (realTx) throw new Error(`已經匯入過銀行明細，不能再清除${label}。`);
}

function clearOpeningUnpaid() {
  assertOpeningEditable('期初未繳名單');
  const safetyBackupPath = safetyBackup('before-clear-unpaid');
  const before = store.householdLedger.length;
  store.householdLedger = store.householdLedger.filter(l => !(l.note === '未繳名單匯入' && paidAmountForLedger(l.id) === 0));
  const now = new Date().toISOString();
  store.importBatches.forEach(b => { if (b.sourceType === 'opening_unpaid' && !b.undoneAt) b.undoneAt = now; });
  persist();
  return { removed: before - store.householdLedger.length, safetyBackupPath };
}

function clearOpeningPrepaid() {
  assertOpeningEditable('期初預繳名單');
  const safetyBackupPath = safetyBackup('before-clear-prepaid');
  const batchIds = new Set(store.importBatches.filter(b => b.sourceType === 'opening_prepaid' && !b.undoneAt).map(b => b.id));
  const txIds = new Set(store.bankTransactions.filter(t => batchIds.has(t.batchId) && !t.voidedAt).map(t => t.id));
  const r = voidTransactions(txIds, '清除期初預繳名單');
  const now = new Date().toISOString();
  store.importBatches.forEach(b => { if (batchIds.has(b.id)) b.undoneAt = now; });
  persist();
  return { removed: r.removedLedgerRows, safetyBackupPath };
}

// ---------- 刪除住戶／復原住戶匯入（匯錯住戶資料時）----------
// 已經有帳款或入帳紀錄的住戶不能刪（刪了帳就對不起來），資料打錯請用「編輯」修改。
function householdHasAccounting(householdId) {
  return store.householdLedger.some(l => l.householdId === householdId)
    || store.bankTransactions.some(t => activeTx(t) && t.matchedHouseholdId === householdId);
}

function deleteHousehold(householdId) {
  const h = store.households.find(x => x.id === householdId);
  if (!h) throw new Error('找不到這個住戶');
  if (householdHasAccounting(householdId)) {
    throw new Error(`${h.unit} 已經有帳款或入帳紀錄，不能刪除。資料打錯請直接修改後儲存。`);
  }
  store.households = store.households.filter(x => x.id !== householdId);
  persist();
  return { unit: h.unit };
}

function lastHouseholdImport() {
  const b = [...store.importBatches].reverse().find(x => x.sourceType === 'households' && !x.undoneAt);
  if (!b) return null;
  const list = store.households.filter(h => h.importBatchId === b.id);
  const blocked = list.filter(h => householdHasAccounting(h.id)).map(h => h.unit);
  return { batchId: b.id, filename: b.filename, importedAt: b.importedAt, count: list.length, canUndo: list.length > 0 && !blocked.length, blocked };
}

function undoHouseholdImport(batchId) {
  const info = lastHouseholdImport();
  if (!info || info.batchId !== batchId) throw new Error('只能復原最後一次住戶匯入');
  if (info.blocked.length) {
    throw new Error(`這次匯入的住戶裡，${info.blocked.slice(0, 5).join('、')}${info.blocked.length > 5 ? ` 等 ${info.blocked.length} 戶` : ''}已經有帳款或入帳紀錄，不能整批復原。資料打錯請到住戶總覽逐戶「編輯」修改。`);
  }
  const safetyBackupPath = safetyBackup('before-undo-households');
  store.households = store.households.filter(h => h.importBatchId !== batchId);
  store.importBatches.find(b => b.id === batchId).undoneAt = new Date().toISOString();
  persist();
  return { count: info.count, filename: info.filename, safetyBackupPath };
}

function ledgerRowsForHousehold(householdId) {
  return store.householdLedger
    .filter(l => l.householdId === householdId)
    .map(l => ({ ledgerId: l.id, period: l.period, due: l.amountDue, paid: paidAmountForLedger(l.id), note: l.note || null }));
}

function listHouseholds() {
  return store.households
    .filter(h => h.isActive)
    .map(h => {
      const rows = ledgerRowsForHousehold(h.id).sort((a, b) => b.period.localeCompare(a.period));
      const latest = rows[0] || null;
      return {
        ...h,
        latestPeriod: latest ? latest.period : null,
        latestDue: latest ? latest.due : null,
        latestPaid: latest ? latest.paid : null,
        latestStatus: latest ? statusOf(latest.due, latest.paid) : '無資料',
      };
    });
}

function saveHousehold(data) {
  if (data.account) {
    const dup = store.households.find(h => h.account === data.account && h.id !== data.id);
    if (dup) throw new Error('這個虛擬帳號已經被其他住戶使用，帳號必須唯一');
  }
  if (data.id) {
    const h = store.households.find(x => x.id === data.id);
    if (!h) throw new Error('找不到這個住戶');
    Object.assign(h, data);
    persist();
    return h;
  } else {
    const id = nextId('household');
    const h = { id, isActive: true, carFee: 0, carRent: 0, carStatus: '無', motoFee: 0, motoRent: 0, motoStatus: '無', ...data };
    store.households.push(h);
    persist();
    return h;
  }
}

// 欄位名稱比對用：先把欄名裡的空白去掉再比對，避免 Excel 報表因為合併儲存格
// 讓欄名中間夾了好幾個空白（例如「汽車    清潔費」），造成明明看起來一樣卻比對不到的狀況。
function normalizeHeaderKey(k) {
  return String(k == null ? '' : k).replace(/\s+/g, '');
}

// 從一列資料裡，依「別名清單」（同一個欄位，不同社區可能取不同名字，例如有的社區叫
// 「機車清潔費」，有的叫「機車租金」）找出對應的值，找不到回傳空字串。
function getFieldByAliases(row, aliases) {
  let normalized = row.__normalizedKeys;
  if (!normalized) {
    normalized = {};
    Object.keys(row).forEach(k => { normalized[normalizeHeaderKey(k)] = row[k]; });
    Object.defineProperty(row, '__normalizedKeys', { value: normalized, enumerable: false });
  }
  for (const alias of aliases) {
    const v = normalized[alias];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

// 判斷這份資料的欄位名稱列有沒有認得出「戶號」跟「帳號」兩個必要欄位
function householdHeadersRecognized(rows) {
  if (!rows) return false;
  const keys = new Set((rows.headerKeys || []).map(normalizeHeaderKey));
  rows.slice(0, 3).forEach(r => Object.keys(r).forEach(k => keys.add(normalizeHeaderKey(k))));
  const hasUnit = ['棟別戶號', '棟別/戶號', '戶號'].some(a => keys.has(a));
  const hasAccount = ['帳號', '虛擬帳號'].some(a => keys.has(a));
  return hasUnit && hasAccount;
}

// 社區第一次使用時，用 Excel/CSV 批次匯入住戶資料，而不是一筆一筆手動輸入
// 欄位對應：棟別戶號（或戶號）、類型、帳號（或虛擬帳號）、坪數、
// 汽車位狀態、汽車清潔費、汽車租金、機車位狀態、機車清潔費、機車租金（清潔費與租金是不同的錢，分開存）
function importHouseholdsFromRows(rows, headerRow = 1, filename = '住戶資料匯入') {
  const rv = currentRateVersion();
  // 記錄這次匯入是哪一批，匯錯了可以整批復原（「復原這次住戶匯入」）
  const batchId = nextId('batch');
  const defaultCategory = Object.keys(rv.categoryRates)[0] || '';
  const created = [];
  const skipped = [];
  const unknownCategories = new Map(); // 類型 → 戶數

  rows.forEach((r, idx) => {
    // 回報給使用者的列號，要對得上 Excel 畫面左邊的列號，不是「第幾筆資料」
    const excelRow = (typeof r.__rowNum__ === 'number') ? r.__rowNum__ + 1 : idx + headerRow + 1;
    const unit = String(getFieldByAliases(r, ['棟別戶號', '棟別/戶號', '戶號'])).trim();
    const category = String(getFieldByAliases(r, ['類型'])).trim();
    const account = String(getFieldByAliases(r, ['帳號', '虛擬帳號'])).trim();
    const area = parseFloat(getFieldByAliases(r, ['坪數'])) || 0;
    const num = v => parseFloat(String(v).replace(/,/g, '')) || 0;
    const carFee = num(getFieldByAliases(r, ['汽車清潔費']));
    const carRent = num(getFieldByAliases(r, ['汽車租金']));
    const carStatus = String(getFieldByAliases(r, ['汽車位狀態'])).trim() || '無';
    const motoFee = num(getFieldByAliases(r, ['機車清潔費']));
    const motoRent = num(getFieldByAliases(r, ['機車租金']));
    const motoStatus = String(getFieldByAliases(r, ['機車位狀態'])).trim() || '無';

    if ((!unit && !account) || /^(合計|總計|小計)$/.test(normalizeHeaderKey(unit))) {
      skipped.push({ rowIndex: excelRow, reason: '空白列或合計列，不是住戶資料', unit, account });
      return;
    }
    if (!unit || !account) {
      skipped.push({ rowIndex: excelRow, reason: !unit ? '缺少戶號' : '缺少帳號', unit, account });
      return;
    }
    if (store.households.find(h => h.account === account)) {
      skipped.push({ rowIndex: excelRow, reason: `帳號 ${account} 已經存在，略過`, unit, account });
      return;
    }

    const finalCategory = category || defaultCategory;
    if (!(finalCategory in rv.categoryRates)) {
      unknownCategories.set(finalCategory, (unknownCategories.get(finalCategory) || 0) + 1);
    }

    const id = nextId('household');
    const h = {
      id, unit, category: finalCategory, account, area,
      carFee, carRent, carStatus, motoFee, motoRent, motoStatus, isActive: true, importBatchId: batchId,
    };
    store.households.push(h);
    created.push(h);
  });
  if (created.length) {
    store.importBatches.push({ id: batchId, sourceType: 'households', filename, rowCount: created.length, importedAt: new Date().toISOString() });
  }

  // 類型在費率設定裡找不到單價，月費會被算成 0，這不能讓它靜靜發生，一定要提醒
  const warnings = [...unknownCategories.entries()].map(([cat, n]) =>
    `有 ${n} 戶的類型是「${cat}」，但「費率設定」裡沒有這個類型的每坪單價，這些戶的管理費目前會被算成 0 元。請到「費率設定」新增「${cat}」的單價後再產生帳款。`);

  persist();
  return { created, skipped, warnings };
}

// ---------- 未繳名單 / 預繳名單 共用工具 ----------

// 把報表欄位標題轉成西元 "YYYY-MM"；辨識不出來回傳 null，代表這欄不是月份欄位（例如戶號、備註、合計）。
// 系統統一的月份寫法是民國年「115/03」（舊範本的「115/03/01」也認得）。
// 舊報表常見的「115年03月未繳」「預繳\n115年12月」也仍然認得，方便沿用舊檔案。
function extractPeriodFromHeader(header) {
  const text = String(header == null ? '' : header).trim();
  let m = text.match(/^(\d{2,3})\/(\d{1,2})(?:\/(\d{1,2}))?$/);
  if (!m) m = text.match(/(\d{2,3})\s*年[\s\S]{0,3}?(\d{1,2})/);
  if (!m) return null;
  const rocYear = Number(m[1]);
  const month = Number(m[2]);
  if (rocYear < 90 || rocYear > 200 || month < 1 || month > 12) return null;
  return `${rocYear + 1911}-${String(month).padStart(2, '0')}`;
}

// 欄名看起來像日期／月份（有數字又有 / 或「年」），但系統認不出來——
// 這種欄位整欄會被忽略，一定要告訴使用者，不能靜靜地少匯一個月。
function looksLikeDateHeader(key) {
  const k = String(key);
  if (k.startsWith('__EMPTY')) return false;
  return /\d/.test(k) && /[\/年.\-]/.test(k) && !extractPeriodFromHeader(k);
}

function excelRowOf(r, idx, headerRow) {
  return (typeof r.__rowNum__ === 'number') ? r.__rowNum__ + 1 : idx + headerRow + 1;
}

// 去掉「號」「-」「－」與空白，讓 "260-1F" 跟 "260號1F" 這種同一戶但打法不同的名稱可以互相比對
function normalizeUnit(s) {
  return String(s == null ? '' : s).replace(/[號\-－\s]/g, '');
}

function findHouseholdByUnit(unitRaw) {
  const raw = String(unitRaw == null ? '' : unitRaw).trim();
  if (!raw) return null;
  let h = store.households.find(x => x.unit === raw);
  if (h) return h;
  const norm = normalizeUnit(raw);
  return store.households.find(x => normalizeUnit(x.unit) === norm) || null;
}

function pickRowField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return row[key];
    }
  }
  return '';
}

function householdMonthlyFee(household, rv) {
  return calcHouseholdTotal({
    area: household.area,
    categoryRate: rv.categoryRates[household.category] || 0,
    publicFundFee: rv.publicFundFee,
    buildingFundPerPing: rv.buildingFundPerPing,
    carFee: household.carFee,
    carRent: household.carRent,
    motoFee: household.motoFee,
    motoRent: household.motoRent,
  });
}

// ---------- 未繳名單匯入 ----------
// 社區第一次使用系統時，把「還欠哪幾個月、還欠多少」登記進來。一戶一列，一個月一欄。
// 欄位裡的金額代表「這一期還欠多少」（可能是部分繳清後的餘額，不一定等於整月月費），
// 所以直接當作這筆應收帳款的「應繳金額」，不建立任何繳款分配紀錄（因為這期本來就還沒收到錢）。
const UNIT_ALIASES = ['戶號', '棟別戶號', '棟/樓', '棟別/戶號'];

function collectHeaderWarnings(rows) {
  const keys = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => keys.add(k)));
  return [...keys].filter(looksLikeDateHeader).map(k =>
    `欄位「${k}」看起來像月份，但系統認不出來，這一欄沒有匯入。月份請寫成 115/03 這種格式。`);
}

function periodColumnsOf(r) {
  return Object.keys(r)
    .map(key => ({ key, period: extractPeriodFromHeader(key) }))
    .filter(x => x.period)
    .sort((a, b) => a.period.localeCompare(b.period));
}

function amountOf(v) {
  return Number(String(v == null ? '' : v).replace(/,/g, '')) || 0;
}

function importUnpaidList(rows, headerRow = 2) {
  const batchId = nextId('batch');
  store.importBatches.push({ id: batchId, sourceType: 'opening_unpaid', filename: '期初未繳名單匯入', rowCount: rows.length, importedAt: new Date().toISOString() });

  const created = [];
  const skipped = [];
  const warnings = collectHeaderWarnings(rows);

  rows.forEach((r, idx) => {
    const excelRow = excelRowOf(r, idx, headerRow);
    const unitRaw = String(getFieldByAliases(r, UNIT_ALIASES)).trim();
    const cols = periodColumnsOf(r);
    const hasAmount = cols.some(c => amountOf(r[c.key]) > 0);
    if (!unitRaw || /^(合計|總計|小計)$/.test(normalizeHeaderKey(unitRaw))) {
      if (hasAmount) skipped.push({ rowIndex: excelRow, reason: '合計列，不是住戶資料，略過', unit: '' });
      return;
    }
    const household = findHouseholdByUnit(unitRaw);
    if (!household) {
      skipped.push({ rowIndex: excelRow, reason: `找不到住戶「${unitRaw}」，請確認戶號跟住戶資料一致`, unit: unitRaw });
      return;
    }

    cols.forEach(({ key, period }) => {
      const amount = amountOf(r[key]);
      if (!amount) return;
      if (amount < 0) {
        skipped.push({ rowIndex: excelRow, reason: `${household.unit} ${key} 是負數 ${amount}，未繳金額不能是負數，略過`, unit: household.unit, period });
        return;
      }
      const exists = store.householdLedger.find(l => l.householdId === household.id && l.period === period);
      if (exists) {
        skipped.push({ rowIndex: excelRow, reason: `${household.unit} ${key} 已經有應收帳款紀錄，略過這一欄`, unit: household.unit, period });
        return;
      }
      const ledgerId = nextId('ledger');
      store.householdLedger.push({ id: ledgerId, householdId: household.id, period, amountDue: amount, note: '未繳名單匯入' });
      created.push({ unit: household.unit, period, amount });
    });
  });

  persist();
  return { created, skipped, warnings };
}

// ---------- 預繳名單匯入 ----------
// 只有「系統本期之後」的月份才算預繳。
// 本期那一欄有金額，代表這個月的錢在系統啟用前就已經收到了：登記為「本期已繳（期初）」，
// 不算預繳，也不會出現在本期收入明細（錢不是本期銀行明細收到的），但這個月不能被當成欠繳。
// 本期以前的月份不屬於預繳名單，有金額就略過並提醒。
// （舊版是把檔案裡最早的一欄當基準直接丟掉，會漏掉第一個預繳月、也會把已繳的本期當成欠繳，已改掉。）
//
// 應繳金額一律用系統試算出的當月月費，匯入欄位裡的金額只代表「這一期已經繳了多少」。
// 如果直接把欄位金額當成應繳金額，遇到異常小額（例如手民誤植的 10 元）會被誤判成
// 「這期已經全額繳清」，之後真正的銀行匯款就會被整筆誤歸類成預繳。
// 改成「應繳=試算月費、已繳=匯入金額」，異常小額會正確顯示成「部分繳」。
function importPrepaidList(rows, currentPeriod, headerRow = 2) {
  const rv = currentRateVersion();
  const created = [];
  const skipped = [];
  const warnings = collectHeaderWarnings(rows).map(message => ({ message }));

  const pastCols = new Set();
  const toRoc = p => `${Number(p.slice(0, 4)) - 1911}/${p.slice(5)}`;

  rows.forEach((r, idx) => {
    const excelRow = excelRowOf(r, idx, headerRow);
    const unitRaw = String(getFieldByAliases(r, UNIT_ALIASES)).trim();
    const cols = periodColumnsOf(r);
    const hasAmount = cols.some(c => amountOf(r[c.key]) > 0);
    if (!unitRaw || /^(合計|總計|小計)$/.test(normalizeHeaderKey(unitRaw))) {
      if (hasAmount) skipped.push({ rowIndex: excelRow, reason: '合計列，不是住戶資料，略過', unit: '' });
      return;
    }
    const household = findHouseholdByUnit(unitRaw);
    if (!household) {
      skipped.push({ rowIndex: excelRow, reason: `找不到住戶「${unitRaw}」，請確認戶號跟住戶資料一致`, unit: unitRaw });
      return;
    }

    const monthlyFee = householdMonthlyFee(household, rv);

    cols.forEach(({ key, period }) => {
      const amount = amountOf(r[key]);
      if (!amount) return;
      if (currentPeriod && period < currentPeriod) { pastCols.add(key); return; }
      const isCurrent = currentPeriod && period === currentPeriod;
      if (amount < 0) {
        skipped.push({ rowIndex: excelRow, reason: `${household.unit} ${key} 是負數 ${amount}，略過`, unit: household.unit, period });
        return;
      }
      const exists = store.householdLedger.find(l => l.householdId === household.id && l.period === period);
      if (exists) {
        skipped.push({ rowIndex: excelRow, reason: `${household.unit} ${key} 已經有應收帳款紀錄，略過這一欄`, unit: household.unit, period });
        return;
      }

      const ledgerId = nextId('ledger');
      store.householdLedger.push({ id: ledgerId, householdId: household.id, period, amountDue: monthlyFee, note: isCurrent ? '本期已繳（期初，系統啟用前收到）' : '預繳名單匯入' });

      const batchId = nextId('batch');
      store.importBatches.push({ id: batchId, sourceType: 'opening_prepaid', filename: '期初預繳名單匯入', rowCount: 1, importedAt: new Date().toISOString() });
      const txId = nextId('transaction');
      store.bankTransactions.push({
        id: txId, batchId, transDate: period + '-01', amount, remark: '期初預繳名單匯入',
        virtualAccountRaw: household.account, matchedHouseholdId: household.id, matchStatus: '自動比對', matchedAt: new Date().toISOString(),
      });
      store.paymentAllocations.push({
        id: nextId('allocation'), transactionId: txId, householdId: household.id, ledgerId, period,
        type: isCurrent ? '當月管理費' : '預繳管理費', amount, isReversal: false, reversalOfId: null, createdAt: new Date().toISOString(),
      });

      created.push({ unit: household.unit, period, amount, monthlyFee, isCurrent: !!isCurrent });

      // 從不悄悄相信匯入的數字——金額跟試算月費對不上，一律列出來讓人核對
      if (amount !== monthlyFee) {
        warnings.push({
          unit: household.unit, period, importedAmount: amount, expectedMonthlyFee: monthlyFee,
          message: amount < monthlyFee
            ? `${household.unit}（${key}）預繳金額 ${amount} 元明顯小於一個月應繳金額 ${monthlyFee} 元，可能是資料誤植，請人工核對`
            : `${household.unit}（${key}）預繳金額 ${amount} 元跟目前試算月費 ${monthlyFee} 元不同，可能是費率調整前的舊資料，請人工核對`,
        });
      }
    });
  });

  if (pastCols.size) {
    warnings.unshift({ message: `「${[...pastCols].join('」「')}」是本期（${toRoc(currentPeriod)}）以前的月份，不屬於預繳名單，這些欄位沒有匯入。以前月份的欠繳請用未繳名單登記。` });
  }
  const currentCount = created.filter(c => c.isCurrent).length;
  if (currentCount) {
    warnings.unshift({ message: `有 ${currentCount} 戶在本期（${toRoc(currentPeriod)}）欄位有金額，已登記為「本期已繳（期初）」：這個月不算欠繳，也不算預繳，不會出現在本期收入明細。` });
  }

  persist();
  return { created, skipped, warnings, currentPeriod };
}

// ---------- 本期管理 ----------
// 本期不直接跟著電腦日期走：社區常在下個月才做上個月的月結（例如 9/15 才做 08 月報表），
// 如果本期自動跳到 09 月，08 月的銀行明細就會被算錯月。
// 所以本期是資料裡記錄的狀態：開帳時設定一次，之後每個月做完月結，按「本期結帳」才進入下一期。
function getCurrentPeriod() {
  return store.currentPeriod;
}

function periodLocked() {
  return store.householdLedger.length > 0 || store.bankTransactions.some(activeTx) || store.closedPeriods.length > 0;
}

function getPeriodState(today) {
  const closingDay = Number((store.communityInfo || {}).closingDay) || 0;
  const t = today || P.todayISO();
  return {
    currentPeriod: store.currentPeriod,
    closingDay,
    range: P.periodRange(store.currentPeriod, closingDay),
    locked: periodLocked(),
    periodConfirmed: !!store.setup.periodConfirmed,
    generated: periodAlreadyGenerated(store.currentPeriod),
    closedPeriods: [...store.closedPeriods],
    bankCountThisPeriod: store.bankTransactions.filter(tx => activeTx(tx) && tx.period === store.currentPeriod).length,
    today: t,
    suggestedPeriod: P.periodContaining(t, closingDay),
    behind: P.periodsBehind(store.currentPeriod, t, closingDay),
  };
}

function savePeriodSettings({ closingDay, currentPeriod }) {
  const cd = Number(closingDay);
  if (!Number.isInteger(cd) || cd < 0 || cd > 28) throw new Error('每月結算日要在 1～28 日之間，或選「月底」');
  if (currentPeriod && currentPeriod !== store.currentPeriod) {
    if (!/^\d{4}-\d{2}$/.test(currentPeriod)) throw new Error('本期格式不正確');
    if (periodLocked()) throw new Error('已經有帳款或銀行明細資料，本期不能直接修改。本期只能透過「本期結帳」往下一期推進。');
    store.currentPeriod = currentPeriod;
    if (store.rateVersions.length === 1) store.rateVersions[0].effectiveFrom = currentPeriod;
  }
  store.communityInfo = { ...store.communityInfo, closingDay: cd };
  store.setup.periodConfirmed = true;
  persist();
  return getPeriodState();
}

// 本期結帳：本期的帳款一定要先產生；結帳前自動備份，結錯了可以從備份還原。
function closeCurrentPeriod() {
  const period = store.currentPeriod;
  if (!periodAlreadyGenerated(period)) {
    throw new Error(`本期（${P.rocPeriod(period)}）的應收帳款還沒產生，不能結帳。請先到「本期試算與核對」產生本期帳款。`);
  }
  const safetyBackupPath = safetyBackup(`before-close-${period}`);
  const bankCount = store.bankTransactions.filter(tx => tx.period === period).length;
  store.closedPeriods.push({ period, closedAt: new Date().toISOString() });
  store.currentPeriod = P.nextPeriod(period);
  persist();
  return { closedPeriod: period, newPeriod: store.currentPeriod, safetyBackupPath, bankCount };
}

// ---------- 開帳檢查清單 ----------
// 社區第一次使用時要完成的步驟，全部完成後畫面上的清單自動消失。
// 換社區主任時，接手的人也能從這裡看出開帳做到哪裡。
function getSetupStatus() {
  const rv = currentRateVersion();
  const hasRates = Object.values(rv.categoryRates || {}).some(v => Number(v) > 0);
  const batchTypes = new Set(store.importBatches.filter(b => !b.undoneAt).map(b => b.sourceType));
  const items = [
    { key: 'name', label: '設定社區名稱、每月結算日、開始記帳的月份（本期）', done: !!(store.communityInfo && store.communityInfo.name) && !!store.setup.periodConfirmed, where: 'rates' },
    { key: 'rates', label: '設定費率（類型與每坪單價、公共基金、修繕基金）', done: hasRates, where: 'rates' },
    { key: 'households', label: '匯入住戶資料', done: store.households.length > 0, where: 'households' },
    { key: 'unpaid', label: '匯入期初未繳名單', done: batchTypes.has('opening_unpaid') || !!store.setup.noOpeningUnpaid, none: !!store.setup.noOpeningUnpaid, where: 'unpaid', canMarkNone: true },
    { key: 'prepaid', label: '匯入期初預繳名單', done: batchTypes.has('opening_prepaid') || !!store.setup.noOpeningPrepaid, none: !!store.setup.noOpeningPrepaid, where: 'prepaid', canMarkNone: true },
  ];
  return { items, allDone: items.every(i => i.done) };
}

function setSetupNone(key, value) {
  if (key === 'unpaid') store.setup.noOpeningUnpaid = !!value;
  else if (key === 'prepaid') store.setup.noOpeningPrepaid = !!value;
  else throw new Error('不支援的項目');
  persist();
  return getSetupStatus();
}

function getCommunityInfo() {
  return { ...store.communityInfo };
}

function saveCommunityInfo({ name }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('社區名稱不能空白');
  store.communityInfo = { ...store.communityInfo, name: n };
  persist();
  return getCommunityInfo();
}

// ---------- 未繳名單 / 預繳名單 檢視（隨每月銀行明細匯入自動更新）----------

// 只列「本期以前（含本期）」還沒繳清的月份。本期之後的月份還沒到期，
// 就算預繳的錢只夠繳一部分，也不算欠繳（那是預繳名單的「部分」），不能出現在未繳名單。
function listUnpaid() {
  const cur = store.currentPeriod;
  const out = [];
  store.households.filter(h => h.isActive).forEach(h => {
    ledgerRowsForHousehold(h.id)
      .filter(r => (!cur || r.period <= cur) && statusOf(r.due, r.paid) !== '已繳')
      .forEach(r => {
        out.push({
          householdId: h.id, unit: h.unit, account: h.account, period: r.period,
          amountDue: r.due, amountPaid: r.paid, amountOwed: r.due - r.paid, status: statusOf(r.due, r.paid), note: r.note,
        });
      });
  });
  return out.sort((a, b) => a.unit.localeCompare(b.unit) || a.period.localeCompare(b.period));
}

// 本期在系統啟用前就已經繳過的（預繳名單的本期欄）：不算預繳，但預繳名單畫面要顯示，才能跟原本的 Excel 對得起來
function listCurrentOpeningPaid(currentPeriod) {
  const out = [];
  store.households.filter(h => h.isActive).forEach(h => {
    store.householdLedger
      .filter(l => l.householdId === h.id && l.period === currentPeriod && String(l.note || '').startsWith('本期已繳（期初'))
      .forEach(l => out.push({ householdId: h.id, unit: h.unit, account: h.account, period: l.period, amountDue: l.amountDue, amountPaid: paidAmountForLedger(l.id) }));
  });
  return out;
}

function listPrepaid(currentPeriod) {
  const out = [];
  store.households.filter(h => h.isActive).forEach(h => {
    ledgerRowsForHousehold(h.id)
      .filter(r => r.period > currentPeriod && statusOf(r.due, r.paid) !== '未繳')
      .forEach(r => {
        out.push({
          householdId: h.id, unit: h.unit, account: h.account, period: r.period,
          amountDue: r.due, amountPaid: r.paid, status: statusOf(r.due, r.paid), note: r.note,
        });
      });
  });
  return out.sort((a, b) => a.unit.localeCompare(b.unit) || a.period.localeCompare(b.period));
}

// 依「銀行明細比對」產生的分配紀錄，還原成社區慣用的「OO月管理費收入明細」報表格式：
// 一筆銀行入帳一列，拆成前期補繳／本期／預繳三欄。只抓真正的銀行匯款批次，
// 不含期初未繳／預繳名單匯入這種用來登記期初狀態的內部批次。
function incomeDetailForPeriod(period) {
  const openingBatchIds = new Set(
    store.importBatches.filter(b => b.sourceType === 'opening_prepaid' || b.sourceType === 'opening_unpaid' || b.sourceType === 'seed').map(b => b.id)
  );
  // 以「匯入時的本期」歸屬，不看交易日期的月份——有結算日的社區（例如每月 10 日結算），
  // 08 月這一期包含 09/01～09/10 的入帳，用日期判斷會算錯月。舊資料沒有記錄期別時才退回用日期。
  const txs = store.bankTransactions.filter(tx => activeTx(tx) && !openingBatchIds.has(tx.batchId)
    && (tx.period ? tx.period === period : String(tx.transDate || '').startsWith(period)));

  const reversed = reversedAllocationIds();
  const rows = txs.map(tx => {
    const allocations = store.paymentAllocations.filter(a => a.transactionId === tx.id && !a.isReversal && !reversed.has(a.id));
    const household = store.households.find(h => h.id === tx.matchedHouseholdId);
    const prior = allocations.filter(a => a.type === '前期補繳').reduce((s, a) => s + a.amount, 0);
    const current = allocations.filter(a => a.type === '當月管理費').reduce((s, a) => s + a.amount, 0);
    const prepay = allocations.filter(a => a.type === '預繳管理費').reduce((s, a) => s + a.amount, 0);
    const periods = allocations.map(a => a.period).filter(Boolean).sort();
    const periodRange = periods.length
      ? (periods[0] === periods[periods.length - 1] ? periods[0] : `${periods[0]}~${periods[periods.length - 1]}`)
      : null;
    return {
      date: tx.transDate,
      unit: household ? household.unit : '（待人工比對）',
      account: tx.virtualAccountRaw,
      periodRange,
      prior, current, prepay,
      total: tx.amount,
    };
  });

  return rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function getRateSettings() {
  return currentRateVersion();
}

// 依生效期間新到舊排列，讓「這幾年費率調整過幾次、什麼時候調的」一目了然，
// 交接下一任社區主任時可以直接看這份紀錄，不用再去翻舊會議紀錄或問前一任。
function listRateVersions() {
  const cur = currentRateVersion();
  return [...store.rateVersions]
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
    .map(v => ({ ...v, isCurrent: v.id === cur.id }));
}

// 儲存費率設定：同一期間內的調整直接更新目前版本；換到新的生效期間才建立新版本並把舊版本結束
function saveRateSettings({ categoryRates, publicFundFee, buildingFundPerPing, annualDiscount, semiAnnualDiscount, effectiveFrom }) {
  const rv = currentRateVersion();
  const ad = Number(annualDiscount) || 0;
  const sad = Number(semiAnnualDiscount) || 0;
  if (rv.effectiveFrom === effectiveFrom) {
    rv.categoryRates = categoryRates;
    rv.publicFundFee = publicFundFee;
    rv.buildingFundPerPing = buildingFundPerPing;
    rv.annualDiscount = ad;
    rv.semiAnnualDiscount = sad;
  } else {
    rv.effectiveTo = effectiveFrom;
    store.rateVersions.push({
      id: store.rateVersions.length + 1,
      effectiveFrom, effectiveTo: null, categoryRates, publicFundFee, buildingFundPerPing,
      annualDiscount: ad, semiAnnualDiscount: sad,
    });
  }
  persist();
  return currentRateVersion();
}

function monthlyPreview() {
  const rv = currentRateVersion();
  return store.households.filter(h => h.isActive).map(h => ({
    householdId: h.id,
    unit: h.unit,
    account: h.account,
    estimatedTotal: householdMonthlyFee(h, rv),
  }));
}

// 只跟「本期之前」最近一筆實際帳款比對，避免把已經匯入的未來預繳資料誤判成「金額變動」
function monthlyChanges(currentPeriod) {
  return monthlyPreview()
    .map(p => {
      const rows = ledgerRowsForHousehold(p.householdId)
        .filter(r => r.period < currentPeriod)
        .sort((a, b) => b.period.localeCompare(a.period));
      const latest = rows[0] || null;
      const lastDue = latest ? latest.due : null;
      const delta = lastDue === null ? p.estimatedTotal : p.estimatedTotal - lastDue;
      return { ...p, lastPeriod: latest ? latest.period : null, lastDue, delta };
    })
    .filter(x => x.delta !== 0);
}

// 本期應收帳款明細：每一戶的月費組成（管理費、公共基金、修繕基金、車位費）＋這一期應收、已收、未收。
// 帳款還沒產生時是試算（應收＝試算月費）；產生後以帳款資料為準
// （期初已繳、預繳名單建立的那一期，應收金額可能跟試算不同，以帳款為準才對得起來）。
function periodReceivables(period) {
  const rv = currentRateVersion();
  const n = v => Number(v) || 0;
  const rows = store.households.filter(h => h.isActive).map(h => {
    const area = n(h.area);
    const base = area * n(rv.categoryRates[h.category]);
    const publicFund = n(rv.publicFundFee);
    const buildingFund = area * n(rv.buildingFundPerPing);
    const parking = n(h.carFee) + n(h.carRent) + n(h.motoFee) + n(h.motoRent);
    const estimated = householdMonthlyFee(h, rv);
    const ledger = ledgerRowsForHousehold(h.id).find(r => r.period === period) || null;
    const due = ledger ? ledger.due : estimated;
    const paid = ledger ? ledger.paid : 0;
    return {
      householdId: h.id, unit: h.unit, category: h.category, area,
      base: Math.round(base), publicFund, buildingFund: Math.round(buildingFund), parking, estimated,
      hasLedger: !!ledger, due, paid, owed: Math.max(due - paid, 0),
      status: ledger ? statusOf(due, paid) : '尚未產生', note: ledger ? ledger.note : null,
    };
  }).sort((a, b) => a.unit.localeCompare(b.unit, 'zh-Hant', { numeric: true }));
  const sum = k => rows.reduce((s, r) => s + r[k], 0);
  return {
    period, generated: periodAlreadyGenerated(period), rows,
    totals: { base: sum('base'), publicFund: sum('publicFund'), buildingFund: sum('buildingFund'), parking: sum('parking'), due: sum('due'), paid: sum('paid'), owed: sum('owed') },
  };
}

function periodAlreadyGenerated(period) {
  return (store.generatedPeriods || []).includes(period);
}

// 產生本期應收帳款。如果某住戶這一期已經有資料（例如預繳名單匯入時就建立過），就跳過不重複建立，
// 只補齊還沒有這期資料的住戶。
function generatePeriod(period) {
  if (periodAlreadyGenerated(period)) {
    throw new Error(`${period} 這一期的帳款已經產生過了，不能重複產生`);
  }
  // 類型沒有每坪單價時，產生的帳款金額會少算，而且之後很難發現——一定要先擋下來
  const rv = currentRateVersion();
  const missing = {};
  store.households.filter(h => h.isActive).forEach(h => {
    if (!(Number(rv.categoryRates[h.category]) > 0)) missing[h.category || '（空白）'] = (missing[h.category || '（空白）'] || 0) + 1;
  });
  if (Object.keys(missing).length) {
    throw new Error('以下類型還沒設定每坪單價，產生帳款會少算，請先到「費率設定」填好：' +
      Object.entries(missing).map(([c, n]) => `「${c}」${n} 戶`).join('、'));
  }
  const preview = monthlyPreview();
  let created = 0;
  let skippedExisting = 0;
  preview.forEach(p => {
    const exists = store.householdLedger.find(l => l.householdId === p.householdId && l.period === period);
    if (exists) { skippedExisting++; return; }
    store.householdLedger.push({ id: nextId('ledger'), householdId: p.householdId, period, amountDue: p.estimatedTotal });
    created++;
  });
  store.generatedPeriods.push(period);
  persist();
  return { created, skippedExisting, total: preview.length };
}

function recordAllocationsForPayment(householdId, transactionId, amount, currentPeriod) {
  const rv = currentRateVersion();
  const h = store.households.find(x => x.id === householdId);
  const rows = ledgerRowsForHousehold(householdId).map(r => ({ period: r.period, due: r.due, paid: r.paid }));

  const { allocations } = allocatePayment({
    ledgerRows: rows,
    amount,
    currentPeriod,
    getFeeForPeriod: () => householdMonthlyFee(h, rv),
  });

  allocations.forEach(a => {
    let ledgerId = null;
    if (a.period) {
      let l = store.householdLedger.find(x => x.householdId === householdId && x.period === a.period);
      if (!l) {
        // 若是全新一期（預繳），應繳金額用試算金額，而不是這筆分配的金額
        l = { id: nextId('ledger'), householdId, period: a.period, amountDue: householdMonthlyFee(h, rv) };
        store.householdLedger.push(l);
      }
      ledgerId = l.id;
    }
    store.paymentAllocations.push({
      id: nextId('allocation'), transactionId, householdId, ledgerId, period: a.period,
      type: a.type, amount: a.amount, isReversal: false, reversalOfId: null, createdAt: new Date().toISOString(),
    });
  });

  return allocations;
}

// 銀行明細防重複匯入：跟以前匯入過的銀行入帳比對「交易日期＋帳號＋金額」，完全相同的視為同一筆，不再沖帳。
// 同一份明細不小心匯兩次，每一戶都會被多算一次錢，多出來的會變成好幾個月的預繳，而且很難發現。
// 用「次數」比對而不是只看有沒有：同一天同帳號同金額匯兩次是可能的（例如分兩次轉帳），
// 以前匯入過 1 筆、這次檔案裡有 2 筆，就只略過 1 筆、匯入 1 筆。
// 只比對真正的銀行明細（不含期初未繳／預繳名單匯入時建立的內部紀錄）。
function bankTxKey(date, accountRaw, amount) {
  return `${date}|${String(accountRaw || '').replace(/\s+/g, '')}|${amount}`;
}

function existingBankTxCounts() {
  const realBatches = new Map(store.importBatches
    .filter(b => !['opening_prepaid', 'opening_unpaid', 'seed'].includes(b.sourceType))
    .map(b => [b.id, b]));
  const counts = new Map();
  store.bankTransactions.forEach(tx => {
    const batch = realBatches.get(tx.batchId);
    if (!batch || !activeTx(tx)) return; // 已復原的匯入不算，復原後可以重新匯入正確的檔案
    const k = bankTxKey(tx.transDate, tx.virtualAccountRaw, tx.amount);
    const c = counts.get(k) || { n: 0, batch };
    c.n += 1;
    counts.set(k, c);
  });
  return counts;
}

function importBankRows(rows, sourceType, filename, currentPeriod) {
  const prior = existingBankTxCounts();
  const duplicates = [];
  const keep = [];
  rows.forEach((row, idx) => {
    const norm = normalizeBankRow(row);
    if (norm.accountDigits && norm.amount > 0) {
      const k = bankTxKey(norm.date, norm.accountRaw, norm.amount);
      const c = prior.get(k);
      if (c && c.n > 0) {
        c.n -= 1;
        const excelRow = (typeof row.__rowNum__ === 'number') ? row.__rowNum__ + 1 : idx + 2;
        duplicates.push({ rowIndex: excelRow, date: norm.date, account: norm.accountRaw, amount: norm.amount,
          previousFile: c.batch.filename, previousAt: c.batch.importedAt });
        return;
      }
    }
    keep.push(row);
  });
  const hasNew = keep.some(row => { const n = normalizeBankRow(row); return n.accountDigits && n.amount > 0; });
  if (duplicates.length && !hasNew) {
    const first = duplicates[0];
    const when = new Date(first.previousAt).toLocaleString('zh-TW', { hour12: false });
    throw new Error(`這份銀行明細的 ${duplicates.length} 筆入帳，以前都已經匯入過了（${first.previousFile}，${when}），這次沒有匯入任何資料，帳款不受影響。`);
  }
  rows = keep;

  const batchId = nextId('batch');
  store.importBatches.push({ id: batchId, sourceType, filename, rowCount: rows.length, importedAt: new Date().toISOString() });

  const results = [];
  const unmatched = [];

  // 同一個檔案裡，同一戶一個月可能匯款兩次以上。錢要「照匯款日期先後」依序沖帳，
  // 不能照檔案列的順序——否則 9/20 那筆排在 9/1 前面時，會被算去補最舊的欠款，
  // 每一筆錢歸屬哪個月份就錯了（總額對、明細錯，交接時查不清楚）。
  // 這個系統只處理「住戶繳的管理費收入」。帳號或金額有問題的列不處理，但一定列出來給人看，
  // 例如存摺轉成 Excel 時不小心把支出、退款（負數）或利息（沒有住戶帳號）放進來。
  const rejected = [];
  const all = rows.map((row, idx) => ({ norm: normalizeBankRow(row), idx, row }));
  all.forEach(({ norm, idx, row }) => {
    const excelRow = (typeof row.__rowNum__ === 'number') ? row.__rowNum__ + 1 : idx + 2;
    const isBlank = !norm.accountRaw && !norm.amount && !norm.remark;
    if (isBlank) return;
    if (norm.amount < 0) rejected.push({ rowIndex: excelRow, date: norm.date, account: norm.accountRaw, amount: norm.amount, reason: '金額是負數（支出或退款），不處理' });
    else if (!norm.amount) rejected.push({ rowIndex: excelRow, date: norm.date, account: norm.accountRaw, amount: norm.amount, reason: '沒有金額或金額為 0，不處理' });
    else if (!norm.accountDigits) rejected.push({ rowIndex: excelRow, date: norm.date, account: norm.accountRaw, amount: norm.amount, reason: '沒有帳號數字（可能是利息或其他收入），不處理' });
  });
  // 交易日期不在本期範圍內（例如把下個月的明細匯進來），照樣處理，但列出來提醒核對
  const range = P.periodRange(currentPeriod, (store.communityInfo || {}).closingDay);
  const outOfRange = all
    .filter(x => x.norm.accountDigits && x.norm.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(x.norm.date))
    .filter(x => x.norm.date < range.start || x.norm.date > range.end)
    .map(x => ({ date: x.norm.date, account: x.norm.accountRaw, amount: x.norm.amount }));
  const normalized = all
    .filter(x => x.norm.accountDigits && x.norm.amount > 0)
    .sort((a, b) => {
      const da = /^\d{4}-\d{2}-\d{2}$/.test(a.norm.date) ? a.norm.date : '9999';
      const db = /^\d{4}-\d{2}-\d{2}$/.test(b.norm.date) ? b.norm.date : '9999';
      return da.localeCompare(db) || a.idx - b.idx;
    });

  normalized.forEach(({ norm }) => {
    const m = matchHouseholdByAccount(store.households, norm.accountRaw);
    const household = m.household;
    const txId = nextId('transaction');
    store.bankTransactions.push({
      id: txId, batchId, period: currentPeriod, transDate: norm.date, amount: norm.amount, remark: norm.remark,
      virtualAccountRaw: norm.accountRaw,
      matchedHouseholdId: household ? household.id : null,
      matchStatus: household ? '自動比對' : '未比對',
      matchedAt: household ? new Date().toISOString() : null,
    });

    if (!household) {
      unmatched.push({ transactionId: txId, date: norm.date, account: norm.accountRaw, amount: norm.amount, remark: norm.remark,
        reason: m.ambiguous ? `帳號數字 ${m.matchedDigits} 同時對到 ${m.candidates.join('、')}，系統不猜，請人工指定` : '找不到帳號相符的住戶' });
      return;
    }
    const allocations = recordAllocationsForPayment(household.id, txId, norm.amount, currentPeriod);
    results.push({ transactionId: txId, date: norm.date, account: norm.accountRaw, amount: norm.amount, remark: norm.remark, household, allocations, manual: false,
      matchNote: m.method === 'prefix' ? `帳號末 ${m.matchedDigits.length - m.prefixLength} 碼跟住戶資料不同（銀行檢核碼），依前 ${m.prefixLength} 碼比對` : null });
  });

  persist();
  return { batchId, results, unmatched, rejected, outOfRange, range, duplicates };
}

function manualMatch(transactionId, householdId, currentPeriod) {
  const tx = store.bankTransactions.find(t => t.id === transactionId);
  if (!tx) throw new Error('找不到這筆交易');
  if (!activeTx(tx)) throw new Error('這筆入帳所屬的匯入已經復原，請重新匯入銀行明細');
  if (tx.matchedHouseholdId) throw new Error('這筆入帳已經比對過住戶了');
  const household = store.households.find(h => h.id === householdId);
  if (!household) throw new Error('找不到這個住戶');

  tx.matchedHouseholdId = householdId;
  tx.matchStatus = '人工比對';
  tx.matchedAt = new Date().toISOString();

  const allocations = recordAllocationsForPayment(householdId, transactionId, tx.amount, currentPeriod);
  persist();
  return { transactionId, date: tx.transDate, account: tx.virtualAccountRaw, amount: tx.amount, remark: tx.remark, household, allocations, manual: true };
}

// ---------- 年繳／半年繳優惠 ----------
// 社區習慣做法：每一期的應繳金額仍然顯示原價，折扣整筆放在最後一期扣除，
// 而不是把折扣平均攤到每一期——這樣多數月份的金額還是跟一般住戶一致，
// 不會讓人誤以為費率算錯，折扣只集中顯示在最後一期，並附上清楚的備註。
//
// 這個動作只調整 household_ledger 的應繳金額（本來就會隨時間調整的表），
// 完全不動 payment_allocations（已經收到的錢的紀錄，維持不可修改），
// 所以帳款的『這筆錢實際收多少、算哪一期』不會被這個動作改變，只是把
// 『這一期應該繳多少』從原價修正成折扣後金額，讓未繳/預繳名單顯示正確。
const DISCOUNT_PLANS = {
  annual: { periods: 12, label: '年繳優惠', rateKey: 'annualDiscount' },
  semiAnnual: { periods: 6, label: '半年繳優惠', rateKey: 'semiAnnualDiscount' },
};

function applyBulkDiscount(transactionId, planType) {
  const plan = DISCOUNT_PLANS[planType];
  if (!plan) throw new Error('不支援的繳費方案');

  const rv = currentRateVersion();
  const discountRate = Number(rv[plan.rateKey]) || 0;
  if (discountRate <= 0 || discountRate >= 1) {
    throw new Error(`目前費率設定沒有開放「${plan.label}」，請先到「費率設定」頁設定折扣（0代表不提供）`);
  }

  const tx = store.bankTransactions.find(t => t.id === transactionId);
  if (!tx) throw new Error('找不到這筆交易');
  if (!activeTx(tx)) throw new Error('這筆入帳所屬的匯入已經復原');
  const household = store.households.find(h => h.id === tx.matchedHouseholdId);
  if (!household) throw new Error('這筆交易還沒有比對到住戶，請先完成住戶比對');

  // 只看這筆交易「當月管理費」「預繳管理費」的分配（前期補繳＝欠款，不套折扣）
  const reversed = reversedAllocationIds();
  const allocations = store.paymentAllocations
    .filter(a => a.transactionId === transactionId && !a.isReversal && !reversed.has(a.id) && a.period && (a.type === '當月管理費' || a.type === '預繳管理費'))
    .sort((a, b) => a.period.localeCompare(b.period));

  const periods = Array.from(new Set(allocations.map(a => a.period)));
  if (periods.length < plan.periods) {
    throw new Error(`這筆入帳只涵蓋 ${periods.length} 期（不含前期補繳），不足 ${plan.periods} 期，無法套用「${plan.label}」。請確認金額是否正確，或改用一般沖帳方式。`);
  }
  const targetPeriods = periods.slice(0, plan.periods);
  const lastPeriod = targetPeriods[targetPeriods.length - 1];

  const fullFee = householdMonthlyFee(household, rv);
  const undiscountedTotal = fullFee * plan.periods;
  const discountedTotal = Math.round(undiscountedTotal * discountRate);
  const discountAmount = undiscountedTotal - discountedTotal;
  const lastDue = fullFee - discountAmount;

  if (lastDue < 0) {
    throw new Error(`折扣金額（${discountAmount}）超過一整期月費（${fullFee}），設定可能有誤，請先檢查費率設定裡「${plan.label}」的折扣數字是否正確`);
  }

  const note = `${plan.label}（${Math.round(discountRate * 100)}折，原價每期${fullFee}，${plan.periods}期優惠總額${discountedTotal}）`;
  targetPeriods.forEach(period => {
    const l = store.householdLedger.find(x => x.householdId === household.id && x.period === period);
    if (!l) return;
    l.amountDue = period === lastPeriod ? lastDue : fullFee;
    l.note = note;
  });

  const actuallyPaidForThoseN = allocations
    .filter(a => targetPeriods.includes(a.period))
    .reduce((s, a) => s + a.amount, 0);
  const mismatch = actuallyPaidForThoseN !== discountedTotal
    ? { expected: discountedTotal, actuallyPaid: actuallyPaidForThoseN, diff: actuallyPaidForThoseN - discountedTotal }
    : null;

  persist();
  return {
    unit: household.unit, plan: planType, label: plan.label, periods: targetPeriods,
    fullFee, discountRate, discountedTotal, discountAmount, lastPeriod, lastDue, mismatch,
  };
}

module.exports = {
  useDoc, takeDoc, takeSnapshots, newCommunityDoc, restoreFromDoc, looksLikeValidData,
  persist, resetStore, listHouseholds, saveHousehold, importHouseholdsFromRows, householdHeadersRecognized, startBlankCommunity,
  getSetupStatus, setSetupNone, getCommunityInfo, saveCommunityInfo,
  getCurrentPeriod, getPeriodState, listCurrentOpeningPaid, savePeriodSettings, closeCurrentPeriod, periodLocked, UNIT_ALIASES, normalizeHeaderKey,
  importUnpaidList, importPrepaidList, listUnpaid, listPrepaid, incomeDetailForPeriod,
  extractPeriodFromHeader, normalizeUnit, findHouseholdByUnit,
  getRateSettings, saveRateSettings, listRateVersions, monthlyPreview, monthlyChanges,
  generatePeriod, periodAlreadyGenerated, periodReceivables, importBankRows, manualMatch, applyBulkDiscount,
  ledgerRowsForHousehold,
  getRecoveryNotice,
  listBankImports, undoBankImport, clearOpeningUnpaid, clearOpeningPrepaid,
  deleteHousehold, lastHouseholdImport, undoHouseholdImport,
  _getStoreForTest: () => store,
};
