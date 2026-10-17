// 把「資料庫裡的社區資料」接上「離線版沿用下來的業務邏輯（core/store.js）」。
//
// 讀取：取出 doc → store.useDoc → 執行函式（同步）→ 回傳結果。
// 修改：同一個社區一次只處理一個修改（程式內排隊＋資料庫 SELECT … FOR UPDATE），
//       執行完把 doc 寫回、版本加 1，連同快照、操作紀錄在同一個交易裡寫入；中途出錯整筆取消，資料不會改一半。
const store = require('./core/store.js');
const P = require('./core/period.js');
const L = require('./core/license.js');
const { db } = require('./db.js');
const { audit } = require('./auth.js');

const AUTO_SNAPSHOT_KEEP = 60;

// ---------- 同一個社區的修改排隊執行 ----------
const queues = new Map();
function withCommunityLock(cid, fn) {
  const prev = queues.get(cid) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(cid, tail);
  tail.then(() => { if (queues.get(cid) === tail) queues.delete(cid); });
  return run;
}

async function getCommunity(cid) {
  const r = await db().query('SELECT * FROM communities WHERE id = $1', [cid]);
  return r.rows[0] || null;
}

function parseDoc(doc) {
  return typeof doc === 'string' ? JSON.parse(doc) : doc;
}

async function loadDoc(q, cid, forUpdate) {
  const r = await q(`SELECT doc FROM community_data WHERE community_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [cid]);
  if (!r.rows.length) throw new Error('找不到這個社區的帳務資料');
  return parseDoc(r.rows[0].doc);
}

// 讀取：fn 拿到 store（已載入這個社區的資料），必須是同步函式
async function runRead(cid, fn) {
  const doc = await loadDoc((t, p) => db().query(t, p), cid, false);
  store.useDoc(doc);
  return fn(store);
}

async function insertSnapshot(q, cid, { reason, label, doc }, userId) {
  const json = JSON.stringify(doc);
  await q('INSERT INTO snapshots (community_id, reason, label, snap_date, doc, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [cid, reason, label, P.todayISO(), json, Buffer.byteLength(json), userId || null]);
}

// 修改：fn 必須是同步函式；丟出錯誤時整筆取消
async function runWrite(cid, user, action, fn, detailFn) {
  return withCommunityLock(cid, () => db().tx(async q => {
    const doc = await loadDoc(q, cid, true);
    store.useDoc(doc);
    const result = fn(store);
    const newDoc = JSON.stringify(store.takeDoc());
    const snaps = store.takeSnapshots();

    for (const s of snaps) await insertSnapshot(q, cid, s, user && user.id);
    await q('UPDATE community_data SET doc = $2, version = version + 1, updated_at = now() WHERE community_id = $1', [cid, newDoc]);

    // 每天第一次修改後，自動留一份當天的快照（離線版的「每日自動備份」），最多保留 60 份
    const today = P.todayISO();
    const has = await q("SELECT 1 FROM snapshots WHERE community_id = $1 AND reason = 'auto-daily' AND snap_date = $2", [cid, today]);
    if (!has.rows.length) {
      await insertSnapshot(q, cid, { reason: 'auto-daily', label: `auto-${today}`, doc: JSON.parse(newDoc) }, null);
      await q(`DELETE FROM snapshots WHERE community_id = $1 AND reason = 'auto-daily' AND id NOT IN
        (SELECT id FROM snapshots WHERE community_id = $1 AND reason = 'auto-daily' ORDER BY created_at DESC, id DESC LIMIT ${AUTO_SNAPSHOT_KEEP})`, [cid]);
    }

    await audit(q, { communityId: cid, userId: user && user.id, action, detail: detailFn ? detailFn(result) : null });
    return result;
  }));
}

// 授權狀態：規則跟離線版相同（本期 ≤ 授權期別，且沒超過授權期別結束後 20 天）
function licenseStatusFor(community, periodState) {
  const s = L.evaluate({
    until: community.license_until,
    currentPeriod: periodState.currentPeriod,
    closingDay: periodState.closingDay,
    today: P.todayISO(),
    lastSeen: community.last_seen_date,
  });
  return { ...s, message: L.describe(s), graceDays: L.GRACE_DAYS };
}

async function licenseStatus(community) {
  const ps = await runRead(community.id, s => s.getPeriodState());
  return licenseStatusFor(community, ps);
}

async function touchLastSeen(cid) {
  const today = P.todayISO();
  await db().query('UPDATE communities SET last_seen_date = $2 WHERE id = $1 AND (last_seen_date IS NULL OR last_seen_date < $2)', [cid, today]);
}

// 建立新社區的帳務資料：正式版是空白社區（本期先建議為今天所屬的月份，社區在開帳清單第 1 步確認），示範版載入示範社區
function newDocFor({ edition, name, seed }) {
  const doc = edition === 'demo'
    ? store.newCommunityDoc({ seed })
    : store.newCommunityDoc({ blankPeriod: P.periodContaining(P.todayISO(), 0) });
  if (edition !== 'demo' && name) doc.communityInfo.name = name;
  return JSON.parse(JSON.stringify(doc));
}

module.exports = { getCommunity, runRead, runWrite, licenseStatus, licenseStatusFor, touchLastSeen, newDocFor, parseDoc, insertSnapshot };
