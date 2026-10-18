// 社區帳務 API。離線版 main.js 的每一個 IPC 頻道，在這裡都有同名的對應：
//   一般動作：POST /api/c/:cid/rpc/:channel        （JSON 參數）
//   上傳檔案：POST /api/c/:cid/upload/:channel     （multipart，欄位名稱 file）
//   下載檔案：GET  /api/c/:cid/download/...
// 回傳格式跟離線版 IPC 相同，前端 app.js 幾乎不用改。
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db.js');
const { requireLogin, canAccessCommunity, audit } = require('../auth.js');
const ledger = require('../ledger.js');
const P = require('../core/period.js');
const { readWithHeaderDetect, hasUnitColumn, hasBankColumns } = require('../core/excel-read.js');
const { buildMonthlyReportWorkbook } = require('../core/report.js');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const DEMO_SEED = () => JSON.parse(fs.readFileSync(path.join(ASSETS, 'demo_seed.json'), 'utf-8'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

// 會改到資料的動作：授權無效（唯讀）時一律擋下來——不只是畫面上把按鈕停用。
// 「匯出月結報表」「下載備份」不在這裡：授權到期後社區仍然可以取得自己的帳務資料。（跟離線版 MUTATING_CHANNELS 相同）
const MUTATING = new Set([
  'households:save', 'households:importFile', 'rates:save', 'ledger:generatePeriod',
  'unpaid:importFile', 'prepaid:importFile', 'bank:pickFile',
  'bank:manualMatch', 'bank:applyDiscount', 'system:resetData', 'system:startBlankCommunity',
  'backup:restoreFromFile', 'backup:restoreFromAuto', 'setup:markNone', 'community:save',
  'period:save', 'period:close',
  'bank:undoImport', 'unpaid:clearOpening', 'prepaid:clearOpening', 'households:delete', 'households:undoImport',
]);

const router = express.Router();

// 每個請求：確認社區存在、使用者有權限進入這個社區
router.use('/:cid', requireLogin, async (req, res, next) => {
  try {
    const cid = Number(req.params.cid);
    if (!Number.isInteger(cid)) return res.status(404).json({ ok: false, error: '找不到這個社區' });
    const community = await ledger.getCommunity(cid);
    if (!community || !(await canAccessCommunity(req.user, community))) {
      return res.status(403).json({ ok: false, error: '沒有權限查看這個社區' });
    }
    req.community = community;
    await ledger.touchLastSeen(cid);
    next();
  } catch (e) { next(e); }
});

async function assertWritable(req, channel) {
  if (!MUTATING.has(channel)) return null;
  const ls = await ledger.licenseStatus(req.community);
  if (!ls.active) {
    return `${ls.message}目前是唯讀模式，可以查看、匯出報表和下載備份，但不能新增或修改帳務。請聯絡系統提供者延長授權。`;
  }
  return null;
}

const isDemo = req => req.community.edition === 'demo';
const cur = s => s.getCurrentPeriod();

// 本期試算與核對畫面用：跟離線版 monthlyChanges 一樣，列出試算月費跟上期不同的住戶，差別是
// 「上期」只拿真正的月費帳款來比，不拿期初未繳名單登記的欠款（那是「還欠多少」，不是月費），
// 而且沒有上期帳款的住戶（第一次使用系統）另外標記 noPrior，畫面上收成一行說明，不跟真正有變動的混在一起。
// 只影響畫面顯示，帳款計算不變。
function changesForReview(s) {
  const period = cur(s);
  return s.monthlyPreview()
    .map(p => {
      const latest = s.ledgerRowsForHousehold(p.householdId)
        .filter(r => r.period < period && r.note !== '未繳名單匯入')
        .sort((a, b) => b.period.localeCompare(a.period))[0] || null;
      if (!latest) return { ...p, lastPeriod: null, lastDue: null, delta: null, noPrior: true };
      return { ...p, lastPeriod: latest.period, lastDue: latest.due, delta: p.estimatedTotal - latest.due, noPrior: false };
    })
    .filter(x => x.noPrior || x.delta !== 0);
}

// ---------- 一般動作 ----------
// read: 只讀；write: 會改資料（action 是寫進操作紀錄的名稱）
const RPC = {
  'households:list': { read: s => s.listHouseholds() },
  'households:save': { write: (s, a) => ({ ok: true, household: s.saveHousehold(a) }), action: '編輯住戶', detail: r => ({ unit: r.household.unit }) },
  'rates:get': { read: s => s.getRateSettings() },
  'rates:save': { write: (s, a) => ({ ok: true, rates: s.saveRateSettings({ ...a, effectiveFrom: cur(s) }) }), action: '儲存費率設定' },
  'rates:history': { read: s => ({ ok: true, versions: s.listRateVersions() }) },
  'ledger:changes': { read: s => changesForReview(s) },
  'ledger:generatePeriod': { write: s => ({ ok: true, ...s.generatePeriod(cur(s)), period: cur(s) }), action: '產生本期應收帳款', detail: r => ({ period: r.period, created: r.created }) },
  'ledger:periodStatus': { read: s => ({ period: cur(s), generated: s.periodAlreadyGenerated(cur(s)) }) },
  'bank:imports': { read: s => ({ ok: true, imports: s.listBankImports() }) },
  'bank:undoImport': { write: (s, a) => ({ ok: true, ...s.undoBankImport(a.batchId) }), action: '復原銀行明細匯入', detail: r => ({ filename: r.filename, count: r.count, amount: r.amount }) },
  'unpaid:clearOpening': { write: s => ({ ok: true, ...s.clearOpeningUnpaid() }), action: '清除期初未繳名單' },
  'prepaid:clearOpening': { write: s => ({ ok: true, ...s.clearOpeningPrepaid() }), action: '清除期初預繳名單' },
  'households:lastImport': { read: s => ({ ok: true, last: s.lastHouseholdImport() }) },
  'households:undoImport': { write: (s, a) => ({ ok: true, ...s.undoHouseholdImport(a.batchId) }), action: '復原住戶匯入', detail: r => ({ count: r.count, filename: r.filename }) },
  'households:delete': { write: (s, a) => ({ ok: true, ...s.deleteHousehold(a.householdId) }), action: '刪除住戶', detail: r => ({ unit: r.unit }) },
  'ledger:receivables': { read: s => ({ ok: true, ...s.periodReceivables(cur(s)) }) },
  'ledger:unpaidList': { read: s => ({ ok: true, rows: s.listUnpaid() }) },
  'ledger:prepaidList': { read: s => ({ ok: true, rows: s.listPrepaid(cur(s)), currentOpening: s.listCurrentOpeningPaid(cur(s)), currentPeriod: cur(s) }) },
  'ledger:incomeDetail': { read: s => ({ ok: true, rows: s.incomeDetailForPeriod(cur(s)) }) },
  'bank:manualMatch': { write: (s, a) => ({ ok: true, result: s.manualMatch(a.transactionId, a.householdId, cur(s)) }), action: '銀行入帳人工指定住戶', detail: r => ({ unit: r.result.household.unit, amount: r.result.amount }) },
  'bank:applyDiscount': { write: (s, a) => ({ ok: true, result: s.applyBulkDiscount(a.transactionId, a.planType) }), action: '套用年繳／半年繳優惠', detail: r => ({ unit: r.result.unit, label: r.result.label }) },
  'system:getRecoveryNotice': { read: s => s.getRecoveryNotice() },
  'period:state': { read: s => ({ ok: true, ...s.getPeriodState() }) },
  'period:close': { write: s => ({ ok: true, ...s.closeCurrentPeriod() }), action: '本期結帳', detail: r => ({ closedPeriod: r.closedPeriod, newPeriod: r.newPeriod }) },
  'setup:status': { read: s => ({ ok: true, ...s.getSetupStatus() }) },
  'setup:markNone': { write: (s, a) => ({ ok: true, ...s.setSetupNone(a.key, a.value) }), action: '開帳清單：標記沒有期初名單' },
  'community:get': { read: s => s.getCommunityInfo() },
  'community:save': { write: (s, a) => ({ ok: true, info: s.saveCommunityInfo(a) }), action: '儲存社區名稱' },
};

// 需要額外檢查的動作
const SPECIAL = {
  async 'app:info'(req) {
    const period = await ledger.runRead(req.community.id, s => cur(s));
    return { edition: req.community.edition, isDemo: isDemo(req), currentPeriod: period, communityId: req.community.id };
  },
  async 'license:status'(req) {
    return { ok: true, ...(await ledger.licenseStatus(req.community)) };
  },
  async 'period:save'(req, a) {
    const ls = await ledger.licenseStatus(req.community);
    if (a && a.currentPeriod && ls.until && a.currentPeriod > ls.until) {
      return { ok: false, error: `授權只到 ${P.rocPeriod(ls.until)} 期，本期不能設定在 ${P.rocPeriod(a.currentPeriod)}。` };
    }
    return ledger.runWrite(req.community.id, req.user, '儲存每月結算日／本期', s => ({ ok: true, ...s.savePeriodSettings(a || {}) }));
  },
  async 'system:resetData'(req) {
    if (!isDemo(req)) return { ok: false, error: '正式版不提供重設資料功能。' };
    const seed = DEMO_SEED();
    return ledger.runWrite(req.community.id, req.user, '還原成示範資料', s => ({ ok: true, ...s.resetStore(seed) }));
  },
  async 'system:startBlankCommunity'(req) {
    if (!isDemo(req)) return { ok: false, error: '正式版不提供清空資料功能。' };
    return ledger.runWrite(req.community.id, req.user, '清空並開始新社區', s => ({ ok: true, ...s.startBlankCommunity(cur(s)) }));
  },
  async 'backup:status'(req) {
    const cid = req.community.id;
    const d = await db().query('SELECT version, updated_at, octet_length(doc::text) AS size FROM community_data WHERE community_id = $1', [cid]);
    const snaps = await db().query('SELECT id, reason, label, size_bytes, created_at FROM snapshots WHERE community_id = $1 ORDER BY created_at DESC, id DESC LIMIT 60', [cid]);
    const row = d.rows[0] || {};
    return {
      ok: true,
      status: {
        version: row.version, dataSize: Number(row.size) || 0, updatedAt: row.updated_at,
        backups: snaps.rows.map(r => ({ id: r.id, reason: r.reason, label: r.label, size: r.size_bytes, createdAt: r.created_at })),
      },
    };
  },
  async 'backup:restoreFromAuto'(req, a) {
    const r = await db().query('SELECT doc, label FROM snapshots WHERE id = $1 AND community_id = $2', [Number(a && a.snapshotId), req.community.id]);
    if (!r.rows.length) return { ok: false, error: '找不到這份備份' };
    const snap = ledger.parseDoc(r.rows[0].doc);
    const label = r.rows[0].label;
    return ledger.runWrite(req.community.id, req.user, '從備份還原', s => ({ ok: true, restoredFrom: label, ...s.restoreFromDoc(snap) }), () => ({ from: label }));
  },
};

router.post('/:cid/rpc/:channel', express.json({ limit: '1mb' }), async (req, res) => {
  const channel = req.params.channel;
  const args = req.body || {};
  try {
    const blocked = await assertWritable(req, channel);
    if (blocked) return res.json({ ok: false, error: blocked });
    if (SPECIAL[channel]) return res.json(await SPECIAL[channel](req, args));
    const def = RPC[channel];
    if (!def) return res.status(404).json({ ok: false, error: '不支援的動作' });
    if (def.read) return res.json(await ledger.runRead(req.community.id, s => def.read(s, args)));
    return res.json(await ledger.runWrite(req.community.id, req.user, def.action || channel, s => def.write(s, args), def.detail));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- 上傳檔案 ----------
const UPLOADS = {
  'households:importFile': {
    action: '匯入住戶資料',
    run(s, file) {
      const found = readWithHeaderDetect(file.buffer, file.originalname, rows => s.householdHeadersRecognized(rows));
      if (!found) throw new Error('在檔案前 5 列找不到「戶號」和「虛擬帳號」這兩個欄位名稱，請確認是用住戶資料範本填寫。沒有匯入任何資料。');
      const { created, skipped, warnings } = s.importHouseholdsFromRows(found.rows, found.headerRow, file.originalname);
      return { ok: true, createdCount: created.length, skipped, warnings, headerRow: found.headerRow };
    },
    detail: r => ({ createdCount: r.createdCount }),
  },
  'unpaid:importFile': {
    action: '匯入期初未繳名單',
    run(s, file) {
      const found = readWithHeaderDetect(file.buffer, file.originalname, hasUnitColumn);
      if (!found) throw new Error('在檔案前 5 列找不到「戶號」欄位，請確認是用未繳名單範本填寫。沒有匯入任何資料。');
      const { created, skipped, warnings } = s.importUnpaidList(found.rows, found.headerRow);
      return { ok: true, createdCount: created.length, created, skipped, warnings };
    },
    detail: r => ({ createdCount: r.createdCount }),
  },
  'prepaid:importFile': {
    action: '匯入期初預繳名單',
    run(s, file) {
      const found = readWithHeaderDetect(file.buffer, file.originalname, hasUnitColumn);
      if (!found) throw new Error('在檔案前 5 列找不到「戶號」欄位，請確認是用預繳名單範本填寫。沒有匯入任何資料。');
      const { created, skipped, warnings } = s.importPrepaidList(found.rows, cur(s), found.headerRow);
      return { ok: true, createdCount: created.length, created, skipped, warnings, currentPeriod: cur(s) };
    },
    detail: r => ({ createdCount: r.createdCount }),
  },
  'bank:pickFile': {
    action: '匯入銀行明細',
    run(s, file) {
      const found = readWithHeaderDetect(file.buffer, file.originalname, hasBankColumns);
      if (!found) throw new Error('在檔案前 5 列找不到「虛擬帳號」和「存入金額」欄位，請確認是銀行明細。沒有匯入任何資料。');
      return { ok: true, ...s.importBankRows(found.rows, 'xlsx', file.originalname, cur(s)) };
    },
    detail: r => ({ results: r.results.length, unmatched: r.unmatched.length }),
  },
};

router.post('/:cid/upload/:channel', (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? '檔案太大（上限 5 MB）。' : err.message });
    next();
  });
}, async (req, res) => {
  const channel = req.params.channel;
  try {
    const blocked = await assertWritable(req, channel);
    if (blocked) return res.json({ ok: false, error: blocked });
    if (!req.file) return res.json({ ok: false, error: '沒有收到檔案' });
    // 瀏覽器上傳的中文檔名是 latin1 編碼，轉回 UTF-8
    req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

    if (channel === 'backup:restoreFromFile') {
      let parsed;
      try { parsed = JSON.parse(req.file.buffer.toString('utf-8')); } catch (e) { return res.json({ ok: false, error: '這個檔案不是有效的 JSON 資料檔，無法還原' }); }
      const name = req.file.originalname;
      return res.json(await ledger.runWrite(req.community.id, req.user, '從備份檔還原', s => ({ ok: true, restoredFrom: name, ...s.restoreFromDoc(parsed) }), () => ({ from: name })));
    }
    const def = UPLOADS[channel];
    if (!def) return res.status(404).json({ ok: false, error: '不支援的動作' });
    res.json(await ledger.runWrite(req.community.id, req.user, def.action, s => def.run(s, req.file), r => ({ file: req.file.originalname, ...(def.detail ? def.detail(r) : {}) })));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- 下載檔案 ----------
function sendXlsx(res, wb, filename) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.attachment(filename);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

router.get('/:cid/download/report', async (req, res) => {
  try {
    const data = await ledger.runRead(req.community.id, s => ({
      period: cur(s),
      incomeRows: s.incomeDetailForPeriod(cur(s)),
      unpaidRows: s.listUnpaid(),
      prepaidRows: s.listPrepaid(cur(s)),
      communityName: s.getCommunityInfo().name,
      range: s.getPeriodState().range,
    }));
    const wb = buildMonthlyReportWorkbook(data.period, data);
    sendXlsx(res, wb, `${Number(data.period.slice(0, 4)) - 1911}年${data.period.slice(5)}月 管理費月結報表.xlsx`);
  } catch (e) {
    res.status(500).type('text').send('匯出失敗：' + e.message);
  }
});

// 下載目前資料（取代離線版「備份到隨身碟」）：授權到期也可以下載，社區永遠拿得到自己的資料
router.get('/:cid/download/backup', async (req, res) => {
  try {
    const r = await db().query('SELECT doc FROM community_data WHERE community_id = $1', [req.community.id]);
    const name = await ledger.runRead(req.community.id, s => s.getCommunityInfo().name || '社區');
    await audit((t, p) => db().query(t, p), { communityId: req.community.id, userId: req.user.id, action: '下載備份檔' });
    res.attachment(`社區帳房備份-${name}-${P.todayISO()}.json`);
    res.type('application/json').send(JSON.stringify(ledger.parseDoc(r.rows[0].doc), null, 2));
  } catch (e) {
    res.status(500).type('text').send('下載失敗：' + e.message);
  }
});

router.get('/:cid/download/snapshot/:sid', async (req, res) => {
  const r = await db().query('SELECT doc, label FROM snapshots WHERE id = $1 AND community_id = $2', [Number(req.params.sid), req.community.id]);
  if (!r.rows.length) return res.status(404).type('text').send('找不到這份備份');
  res.attachment(`${r.rows[0].label}.json`);
  res.type('application/json').send(JSON.stringify(ledger.parseDoc(r.rows[0].doc), null, 2));
});

// 範本檔放在 assets/templates，程式裡的檔名一律用英文，下載給使用者時才用中文檔名
const TEMPLATE_FILES = {
  households: { file: 'households.xlsx', saveAs: '範本1_住戶資料.xlsx' },
  unpaid: { file: 'unpaid.xlsx', saveAs: '範本2_未繳名單.xlsx' },
  prepaid: { file: 'prepaid.xlsx', saveAs: '範本3_預繳名單.xlsx' },
  bank: { file: 'bank.xlsx', saveAs: '範本4_銀行明細.xlsx' },
};
router.get('/:cid/download/template/:kind', (req, res) => {
  const t = TEMPLATE_FILES[req.params.kind];
  if (!t) return res.status(404).type('text').send('找不到這個範本');
  res.download(path.join(ASSETS, 'templates', t.file), t.saveAs);
});

// 示範版：虛構的住戶、未繳、預繳、銀行明細 Excel，教育訓練時直接拿來匯入
const DEMO_FILES = {
  1: ['demo1_households.xlsx', '示範1_住戶資料.xlsx'],
  2: ['demo2_unpaid.xlsx', '示範2_未繳名單.xlsx'],
  3: ['demo3_prepaid.xlsx', '示範3_預繳名單.xlsx'],
  4: ['demo4_bank_11507.xlsx', '示範4_銀行明細_115年07月.xlsx'],
};
router.get('/:cid/download/demo/:n', (req, res) => {
  const f = DEMO_FILES[req.params.n];
  if (!isDemo(req) || !f) return res.status(404).type('text').send('只有示範社區有示範檔案');
  res.download(path.join(ASSETS, 'demo-files', f[0]), f[1]);
});

module.exports = router;
