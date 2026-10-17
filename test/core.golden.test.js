// 黃金比對測試：同樣的資料、同樣的操作，線上版 store 跟離線版 store 算出來的帳必須一模一樣。
// 離線版原始碼只讀取、不修改。找不到離線版原始碼時（例如在雲端主機上）自動略過。
//
// 離線版位置可用環境變數 OFFLINE_SRC 指定。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OFFLINE_SRC = process.env.OFFLINE_SRC
  || 'C:\\Users\\Administrator\\Desktop\\打包\\claude\\離線版社區AI帳房\\社區帳房-v10原始碼\\community-ledger';
const HAS_OFFLINE = fs.existsSync(path.join(OFFLINE_SRC, 'store.js'));

const ROOT = path.join(__dirname, '..');
const DEMO = f => path.join(ROOT, 'assets', 'demo-files', f);
const SEED = path.join(ROOT, 'assets', 'demo_seed.json');

// 時間戳記、備份檔路徑這些每次執行都不同的欄位不比對；管理密碼欄位線上版不用
const VOLATILE = new Set(['createdAt', 'importedAt', 'matchedAt', 'voidedAt', 'closedAt', 'undoneAt', 'safetyBackupPath', 'security', 'previousAt']);
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).sort().forEach(k => {
      if (VOLATILE.has(k)) { o[k] = v[k] == null ? null : '<volatile>'; return; }
      if (v[k] === undefined) return; // JSON 存檔後 undefined 欄位會消失，兩邊統一不比
      o[k] = clean(v[k]);
    });
    return o;
  }
  return v;
}

function makeRunners() {
  // 離線版：資料寫到暫存資料夾，不碰任何真實資料
  const offStore = require(path.join(OFFLINE_SRC, 'store.js'));
  const offExcel = require(path.join(OFFLINE_SRC, 'excel-read.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-golden-'));

  const onStore = require('../server/core/store.js');
  const onExcel = require('../server/core/excel-read.js');

  const off = {
    name: 'offline', store: offStore,
    read: (file, rec) => offExcel.readWithHeaderDetect(file, rec(offStore, offExcel)),
    init(opts) { offStore.initStore(path.join(tmp, `d-${Date.now()}-${Math.random()}.json`), opts.blankPeriod ? null : SEED, opts); },
    doc: () => offStore._getStoreForTest(),
  };
  const on = {
    name: 'online', store: onStore,
    read: (file, rec) => onExcel.readWithHeaderDetect(fs.readFileSync(file), path.basename(file), rec(onStore, onExcel)),
    init(opts) { onStore.newCommunityDoc(opts.blankPeriod ? opts : { seed: JSON.parse(fs.readFileSync(SEED, 'utf-8')) }); },
    doc: () => onStore._getStoreForTest(),
  };
  return [off, on];
}

const REC = {
  households: (s) => rows => s.householdHeadersRecognized(rows),
  unit: (s, x) => x.hasUnitColumn,
  bank: (s, x) => x.hasBankColumns,
};

// 每一步在兩邊各跑一次，回傳值（或丟出的錯誤訊息）必須相同
function step(runners, fn) {
  const out = runners.map(r => {
    try { return { ok: clean(JSON.parse(JSON.stringify(fn(r) ?? null))) }; } catch (e) { return { error: e.message }; }
  });
  assert.deepStrictEqual(out[1], out[0]);
  return out[0];
}

test('示範社區完整流程：線上版跟離線版結果一致', { skip: !HAS_OFFLINE && '找不到離線版原始碼' }, () => {
  const R = makeRunners();
  R.forEach(r => r.init({}));
  const cur = () => R[0].store.getCurrentPeriod();

  step(R, r => r.store.importUnpaidList(r.read(DEMO('demo2_unpaid.xlsx'), REC.unit).rows, 2));
  step(R, r => r.store.importPrepaidList(r.read(DEMO('demo3_prepaid.xlsx'), REC.unit).rows, r.store.getCurrentPeriod(), 2));
  step(R, r => r.store.listUnpaid());
  step(R, r => r.store.monthlyChanges(r.store.getCurrentPeriod()));
  step(R, r => r.store.generatePeriod(r.store.getCurrentPeriod()));
  const bank = step(R, r => {
    const f = r.read(DEMO('demo4_bank_11507.xlsx'), REC.bank);
    return r.store.importBankRows(f.rows, 'xlsx', 'demo4_bank_11507.xlsx', r.store.getCurrentPeriod());
  });
  assert.ok(bank.ok.results.length > 30, '示範銀行明細應該有 30 筆以上自動比對');
  assert.strictEqual(bank.ok.unmatched.length, 1, '示範銀行明細應該有 1 筆對不到');

  // 人工指定 101-6F
  step(R, r => {
    const tx = r.doc().bankTransactions.find(t => !t.matchedHouseholdId);
    const h = r.doc().households.find(x => x.unit === '101-6F');
    return r.store.manualMatch(tx.id, h.id, r.store.getCurrentPeriod());
  });

  // 開放年繳 95 折後，替 101-8F 那筆 12 個月的入帳套用年繳優惠
  step(R, r => {
    const rv = r.store.getRateSettings();
    return r.store.saveRateSettings({ ...rv, annualDiscount: 0.95, effectiveFrom: r.store.getCurrentPeriod() });
  });
  step(R, r => {
    const h = r.doc().households.find(x => x.unit === '101-8F');
    const tx = r.doc().bankTransactions.find(t => t.matchedHouseholdId === h.id && t.amount === 57276);
    return r.store.applyBulkDiscount(tx.id, 'annual');
  });

  // 同一份銀行明細再匯入一次：兩邊都要擋下
  const dup = step(R, r => r.store.importBankRows(r.read(DEMO('demo4_bank_11507.xlsx'), REC.bank).rows, 'xlsx', 'demo4_bank_11507.xlsx', r.store.getCurrentPeriod()));
  assert.ok(dup.error && dup.error.includes('已經匯入過了'));

  step(R, r => r.store.listUnpaid());
  step(R, r => r.store.listPrepaid(r.store.getCurrentPeriod()));
  step(R, r => r.store.listCurrentOpeningPaid(r.store.getCurrentPeriod()));
  step(R, r => r.store.incomeDetailForPeriod(r.store.getCurrentPeriod()));
  step(R, r => r.store.periodReceivables(r.store.getCurrentPeriod()));
  step(R, r => r.store.listHouseholds());

  // 復原這次銀行明細匯入，再重新匯入
  const imports = step(R, r => r.store.listBankImports());
  step(R, r => r.store.undoBankImport(imports.ok[0].batchId));
  step(R, r => r.store.listUnpaid());
  step(R, r => r.store.importBankRows(r.read(DEMO('demo4_bank_11507.xlsx'), REC.bank).rows, 'xlsx', 'demo4_bank_11507.xlsx', r.store.getCurrentPeriod()));

  // 期初名單已經不能清除（帳款已產生）
  step(R, r => r.store.clearOpeningUnpaid());

  step(R, r => r.store.closeCurrentPeriod());
  step(R, r => r.store.getPeriodState('2026-08-15'));
  step(R, r => r.store.getSetupStatus());

  assert.notStrictEqual(cur(), '2026-07');
  assert.deepStrictEqual(clean(JSON.parse(JSON.stringify(R[1].doc()))), clean(JSON.parse(JSON.stringify(R[0].doc()))));
});

test('空白社區開帳：住戶匯入、復原、單戶刪除，結果一致', { skip: !HAS_OFFLINE && '找不到離線版原始碼' }, () => {
  const R = makeRunners();
  R.forEach(r => r.init({ blankPeriod: '2026-07' }));

  step(R, r => r.store.saveCommunityInfo({ name: '測試社區' }));
  step(R, r => r.store.savePeriodSettings({ closingDay: 10, currentPeriod: '2026-07' }));
  step(R, r => r.store.saveRateSettings({ categoryRates: { '大樓住宅': 70, '店面': 60 }, publicFundFee: 200, buildingFundPerPing: 10, annualDiscount: 0, semiAnnualDiscount: 0, effectiveFrom: '2026-07' }));
  step(R, r => { const f = r.read(DEMO('demo1_households.xlsx'), REC.households); return r.store.importHouseholdsFromRows(f.rows, f.headerRow, 'demo1_households.xlsx'); });
  const last = step(R, r => r.store.lastHouseholdImport());
  step(R, r => r.store.undoHouseholdImport(last.ok.batchId));
  step(R, r => { const f = r.read(DEMO('demo1_households.xlsx'), REC.households); return r.store.importHouseholdsFromRows(f.rows, f.headerRow, 'demo1_households.xlsx'); });
  step(R, r => r.store.deleteHousehold(r.doc().households[0].id));
  step(R, r => r.store.setSetupNone('unpaid', true));
  step(R, r => r.store.setSetupNone('prepaid', true));
  step(R, r => r.store.getSetupStatus());
  step(R, r => r.store.generatePeriod('2026-07'));
  step(R, r => r.store.periodReceivables('2026-07'));

  assert.deepStrictEqual(clean(JSON.parse(JSON.stringify(R[1].doc()))), clean(JSON.parse(JSON.stringify(R[0].doc()))));
});

test('線上版：會改資料的復原動作會留下「動作之前」的快照', () => {
  const s = require('../server/core/store.js');
  s.newCommunityDoc({ seed: JSON.parse(fs.readFileSync(SEED, 'utf-8')) });
  s.takeSnapshots();
  const before = JSON.stringify(s.takeDoc());
  s.setSetupNone('unpaid', true);
  s.setSetupNone('prepaid', true);
  assert.deepStrictEqual(s.takeSnapshots(), []);
  s.resetStore(JSON.parse(fs.readFileSync(SEED, 'utf-8')));
  const snaps = s.takeSnapshots();
  assert.strictEqual(snaps.length, 1);
  assert.strictEqual(snaps[0].reason, 'before-reset-demo');
  assert.strictEqual(snaps[0].doc.setup.noOpeningUnpaid, true);
  assert.notStrictEqual(JSON.stringify(snaps[0].doc), before);
});
