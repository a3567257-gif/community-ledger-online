// 後台管理 API
//   super_admin（樓管家）：管理物業公司、社區（含授權期別）、所有帳號
//   company_admin（物業公司）：看自己公司所有社區的狀況，管理自己公司的社區經理／秘書帳號
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db.js');
const { ROLES, requireRole, hashPassword, validateNewPassword, audit } = require('../auth.js');
const ledger = require('../ledger.js');
const P = require('../core/period.js');

const router = express.Router();
router.use(express.json({ limit: '100kb' }));
router.use(requireRole('super_admin', 'company_admin'));

const isSuper = req => req.user.role === 'super_admin';
const q = (t, p) => db().query(t, p);
const DEMO_SEED = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'demo_seed.json'), 'utf-8'));

function wrap(fn) {
  return async (req, res) => {
    try { res.json(await fn(req, res)); } catch (e) { res.json({ ok: false, error: e.message }); }
  };
}

function scopeCompany(req, companyId) {
  if (isSuper(req)) return Number(companyId);
  return req.user.company_id;
}

// ---------- 總覽 ----------
router.get('/overview', wrap(async req => {
  const companies = isSuper(req)
    ? (await q('SELECT id, name, status FROM companies ORDER BY name')).rows
    : (await q('SELECT id, name, status FROM companies WHERE id = $1', [req.user.company_id])).rows;
  const commRows = isSuper(req)
    ? (await q('SELECT c.*, d.doc, d.updated_at FROM communities c JOIN community_data d ON d.community_id = c.id ORDER BY c.company_id, c.name')).rows
    : (await q('SELECT c.*, d.doc, d.updated_at FROM communities c JOIN community_data d ON d.community_id = c.id WHERE c.company_id = $1 ORDER BY c.name', [req.user.company_id])).rows;

  const store = require('../core/store.js');
  const communities = commRows.map(c => {
    store.useDoc(ledger.parseDoc(c.doc));
    const ps = store.getPeriodState();
    const unpaid = store.listUnpaid();
    const lic = ledger.licenseStatusFor(c, ps);
    return {
      id: c.id, companyId: c.company_id, name: c.name, edition: c.edition, active: c.active,
      licenseUntil: c.license_until, licenseActive: lic.active, licenseMessage: lic.message,
      currentPeriod: ps.currentPeriod, generated: ps.generated, behind: ps.behind,
      households: store.listHouseholds().length,
      unpaidHouseholds: new Set(unpaid.map(r => r.householdId)).size,
      unpaidAmount: unpaid.reduce((s, r) => s + r.amountOwed, 0),
      updatedAt: c.updated_at,
    };
  });

  const userRows = isSuper(req)
    ? (await q('SELECT id, login, display_name, role, company_id, active, last_login_at FROM users ORDER BY role, login')).rows
    : (await q("SELECT id, login, display_name, role, company_id, active, last_login_at FROM users WHERE company_id = $1 ORDER BY role, login", [req.user.company_id])).rows;
  const members = (await q('SELECT user_id, community_id FROM community_members')).rows;
  const users = userRows.map(u => ({
    id: u.id, login: u.login, displayName: u.display_name, role: u.role, roleLabel: ROLES[u.role], companyId: u.company_id,
    active: u.active, lastLoginAt: u.last_login_at,
    communityIds: members.filter(m => m.user_id === u.id).map(m => m.community_id),
  }));
  return { ok: true, isSuper: isSuper(req), today: P.todayISO(), companies, communities, users };
}));

// ---------- 物業公司（只有 super_admin）----------
router.post('/companies', wrap(async req => {
  if (!isSuper(req)) throw new Error('沒有權限');
  const name = String(req.body.name || '').trim();
  if (!name) throw new Error('請輸入公司名稱');
  const r = await q('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name]);
  await audit(q, { userId: req.user.id, action: '新增物業公司', detail: { name } });
  return { ok: true, id: r.rows[0].id };
}));

router.patch('/companies/:id', wrap(async req => {
  if (!isSuper(req)) throw new Error('沒有權限');
  const name = String(req.body.name || '').trim();
  if (!name) throw new Error('請輸入公司名稱');
  await q('UPDATE companies SET name = $2 WHERE id = $1', [Number(req.params.id), name]);
  await audit(q, { userId: req.user.id, action: '修改物業公司名稱', detail: { id: Number(req.params.id), name } });
  return { ok: true };
}));

// ---------- 社區（新增、授權只有 super_admin）----------
function checkPeriod(p) {
  if (p === null || p === '' || p === undefined) return null;
  if (!/^\d{4}-\d{2}$/.test(p)) throw new Error('授權期別格式不正確（例如 2026-12）');
  return p;
}

router.post('/communities', wrap(async req => {
  if (!isSuper(req)) throw new Error('沒有權限');
  const companyId = Number(req.body.companyId);
  const name = String(req.body.name || '').trim();
  const edition = req.body.edition === 'demo' ? 'demo' : 'formal';
  const licenseUntil = checkPeriod(req.body.licenseUntil);
  if (!name) throw new Error('請輸入社區名稱');
  const co = await q('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!co.rows.length) throw new Error('請選擇物業公司');
  const doc = ledger.newDocFor({ edition, name, seed: edition === 'demo' ? DEMO_SEED() : null });
  const id = await db().tx(async t => {
    const r = await t('INSERT INTO communities (company_id, name, edition, license_until) VALUES ($1, $2, $3, $4) RETURNING id', [companyId, name, edition, licenseUntil]);
    const cid = r.rows[0].id;
    await t('INSERT INTO community_data (community_id, doc) VALUES ($1, $2)', [cid, JSON.stringify(doc)]);
    await audit(t, { communityId: cid, userId: req.user.id, action: '新增社區', detail: { name, edition, licenseUntil } });
    return cid;
  });
  return { ok: true, id };
}));

router.patch('/communities/:id', wrap(async req => {
  if (!isSuper(req)) throw new Error('沒有權限');
  const id = Number(req.params.id);
  const c = await ledger.getCommunity(id);
  if (!c) throw new Error('找不到這個社區');
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : c.name;
  if (!name) throw new Error('社區名稱不能空白');
  const licenseUntil = b.licenseUntil !== undefined ? checkPeriod(b.licenseUntil) : c.license_until;
  const active = b.active !== undefined ? !!b.active : c.active;
  await q('UPDATE communities SET name = $2, license_until = $3, active = $4 WHERE id = $1', [id, name, licenseUntil, active]);
  await audit(q, { communityId: id, userId: req.user.id, action: '修改社區設定', detail: { name, licenseUntil, active } });
  return { ok: true };
}));

// ---------- 帳號 ----------
async function assertCommunitiesInCompany(ids, companyId) {
  if (!ids.length) return;
  const r = await q('SELECT id FROM communities WHERE company_id = $1', [companyId]);
  const allowed = new Set(r.rows.map(x => x.id));
  if (ids.some(id => !allowed.has(id))) throw new Error('只能指派同一家物業公司的社區');
}

router.post('/users', wrap(async req => {
  const b = req.body || {};
  const login = String(b.login || '').trim();
  const role = b.role;
  if (!/^[A-Za-z0-9._@-]{3,60}$/.test(login)) throw new Error('帳號只能用英文字母、數字和 . _ @ -，3～60 個字');
  if (!ROLES[role]) throw new Error('請選擇身分');
  if (!isSuper(req) && role !== 'community_user') throw new Error('物業公司管理者只能新增社區經理／秘書帳號');
  validateNewPassword(b.password);
  const companyId = role === 'super_admin' ? null : scopeCompany(req, b.companyId);
  if (role !== 'super_admin') {
    const co = await q('SELECT id FROM companies WHERE id = $1', [companyId]);
    if (!co.rows.length) throw new Error('請選擇物業公司');
  }
  const communityIds = role === 'community_user' ? (b.communityIds || []).map(Number) : [];
  if (role === 'community_user') await assertCommunitiesInCompany(communityIds, companyId);
  const dup = await q('SELECT 1 FROM users WHERE login = $1', [login]);
  if (dup.rows.length) throw new Error('這個帳號已經有人使用');

  const id = await db().tx(async t => {
    const r = await t('INSERT INTO users (login, password_hash, display_name, role, company_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [login, hashPassword(b.password), String(b.displayName || '').trim(), role, companyId]);
    const uid = r.rows[0].id;
    for (const cid of communityIds) await t('INSERT INTO community_members (user_id, community_id) VALUES ($1, $2)', [uid, cid]);
    await audit(t, { userId: req.user.id, action: '新增帳號', detail: { login, role, companyId, communityIds } });
    return uid;
  });
  return { ok: true, id };
}));

router.patch('/users/:id', wrap(async req => {
  const id = Number(req.params.id);
  const r = await q('SELECT * FROM users WHERE id = $1', [id]);
  const u = r.rows[0];
  if (!u) throw new Error('找不到這個帳號');
  if (!isSuper(req) && (u.company_id !== req.user.company_id || u.role !== 'community_user')) throw new Error('沒有權限');
  const b = req.body || {};
  if (u.id === req.user.id && b.active === false) throw new Error('不能停用自己的帳號');

  await db().tx(async t => {
    const changes = {};
    if (b.displayName !== undefined) {
      await t('UPDATE users SET display_name = $2 WHERE id = $1', [id, String(b.displayName).trim()]);
      changes.displayName = String(b.displayName).trim();
    }
    if (b.active !== undefined) {
      await t('UPDATE users SET active = $2, session_version = session_version + 1 WHERE id = $1', [id, !!b.active]);
      changes.active = !!b.active;
    }
    if (b.password) {
      validateNewPassword(b.password);
      await t('UPDATE users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1', [id, hashPassword(b.password)]);
      changes.passwordReset = true;
    }
    if (Array.isArray(b.communityIds) && u.role === 'community_user') {
      const ids = b.communityIds.map(Number);
      await assertCommunitiesInCompany(ids, u.company_id);
      await t('DELETE FROM community_members WHERE user_id = $1', [id]);
      for (const cid of ids) await t('INSERT INTO community_members (user_id, community_id) VALUES ($1, $2)', [id, cid]);
      changes.communityIds = ids;
    }
    await audit(t, { userId: req.user.id, action: '修改帳號', detail: { login: u.login, ...changes } });
  });
  return { ok: true };
}));

// ---------- 操作紀錄 ----------
router.get('/audit', wrap(async req => {
  const cid = req.query.communityId ? Number(req.query.communityId) : null;
  const params = [];
  let where = '1=1';
  if (!isSuper(req)) {
    params.push(req.user.company_id);
    where += ` AND (c.company_id = $${params.length} OR (a.community_id IS NULL AND u.company_id = $${params.length}))`;
  }
  if (cid) { params.push(cid); where += ` AND a.community_id = $${params.length}`; }
  const r = await q(`SELECT a.id, a.at, a.action, a.detail, a.community_id, c.name AS community_name, u.login, u.display_name
    FROM audit_log a LEFT JOIN communities c ON c.id = a.community_id LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where} ORDER BY a.at DESC, a.id DESC LIMIT 300`, params);
  return { ok: true, rows: r.rows };
}));

module.exports = router;
