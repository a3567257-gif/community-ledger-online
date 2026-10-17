// 帳號登入與權限。
// 登入狀態存在加簽章的 cookie（cookie-session）：只放 user id 跟 session_version，
// 每次請求都回資料庫確認帳號還在、沒被停用；改密碼或被停用時 session_version 加 1，其他裝置的登入立即失效。
const crypto = require('crypto');
const { db } = require('./db.js');

const ROLES = { super_admin: '樓管家管理者', company_admin: '物業公司管理者', community_user: '社區經理／秘書' };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function validateNewPassword(pw) {
  if (String(pw || '').length < 8) throw new Error('密碼至少要 8 個字元');
}

// 每個請求：從 cookie 找出登入的使用者
async function loadUser(req, res, next) {
  req.user = null;
  const s = req.session;
  if (s && s.uid) {
    try {
      const r = await db().query('SELECT id, login, display_name, role, company_id, active, session_version FROM users WHERE id = $1', [s.uid]);
      const u = r.rows[0];
      if (u && u.active && u.session_version === s.sv) req.user = u;
      else req.session = null;
    } catch (e) {
      return next(e);
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: '請先登入', needLogin: true });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: '請先登入', needLogin: true });
    if (!roles.includes(req.user.role)) return res.status(403).json({ ok: false, error: '沒有權限' });
    next();
  };
}

// 這個使用者可以進入哪些社區
async function accessibleCommunities(user) {
  const cols = 'c.id, c.name, c.edition, c.license_until, c.company_id, co.name AS company_name';
  let r;
  if (user.role === 'super_admin') {
    r = await db().query(`SELECT ${cols} FROM communities c JOIN companies co ON co.id = c.company_id WHERE c.active ORDER BY co.name, c.name`);
  } else if (user.role === 'company_admin') {
    r = await db().query(`SELECT ${cols} FROM communities c JOIN companies co ON co.id = c.company_id WHERE c.active AND c.company_id = $1 ORDER BY c.name`, [user.company_id]);
  } else {
    r = await db().query(`SELECT ${cols} FROM communities c JOIN companies co ON co.id = c.company_id JOIN community_members m ON m.community_id = c.id
      WHERE c.active AND m.user_id = $1 ORDER BY c.name`, [user.id]);
  }
  return r.rows;
}

async function canAccessCommunity(user, community) {
  if (!user || !community || !community.active) return false;
  if (user.role === 'super_admin') return true;
  if (user.role === 'company_admin') return community.company_id === user.company_id;
  const r = await db().query('SELECT 1 FROM community_members WHERE user_id = $1 AND community_id = $2', [user.id, community.id]);
  return r.rows.length > 0;
}

async function audit(q, { communityId = null, userId = null, action, detail = null }) {
  await q('INSERT INTO audit_log (community_id, user_id, action, detail) VALUES ($1, $2, $3, $4)',
    [communityId, userId, action, detail ? JSON.stringify(detail) : null]);
}

module.exports = {
  ROLES, hashPassword, verifyPassword, validateNewPassword, loadUser, requireLogin, requireRole,
  accessibleCommunities, canAccessCommunity, audit,
};
