// 登入、登出、我的帳號
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db.js');
const { ROLES, verifyPassword, hashPassword, validateNewPassword, requireLogin, accessibleCommunities, audit } = require('../auth.js');

const router = express.Router();
router.use(express.json({ limit: '100kb' }));

// 同一個 IP 15 分鐘內最多嘗試登入 20 次，防止有人一直猜密碼
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: '登入嘗試次數太多，請 15 分鐘後再試。' },
});

router.post('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const login = String((req.body && req.body.login) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const r = await db().query('SELECT * FROM users WHERE login = $1', [login]);
    const u = r.rows[0];
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
      return res.json({ ok: false, error: '帳號或密碼不正確' });
    }
    await db().query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    await audit((t, p) => db().query(t, p), { userId: u.id, action: '登入' });
    req.session = { uid: u.id, sv: u.session_version };
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', requireLogin, async (req, res, next) => {
  try {
    const u = req.user;
    const communities = await accessibleCommunities(u);
    let companyName = null;
    if (u.company_id) {
      const c = await db().query('SELECT name FROM companies WHERE id = $1', [u.company_id]);
      companyName = c.rows[0] ? c.rows[0].name : null;
    }
    res.json({
      ok: true,
      user: { id: u.id, login: u.login, displayName: u.display_name, role: u.role, roleLabel: ROLES[u.role], companyName },
      communities: communities.map(c => ({ id: c.id, name: c.name, edition: c.edition, companyName: c.company_name })),
    });
  } catch (e) { next(e); }
});

// 變更自己的密碼：一定要先輸入目前密碼。改完後其他裝置上的登入全部失效。
router.post('/me/password', requireLogin, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const r = await db().query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!verifyPassword(currentPassword, r.rows[0].password_hash)) return res.json({ ok: false, error: '目前的密碼不正確' });
    try { validateNewPassword(newPassword); } catch (e) { return res.json({ ok: false, error: e.message }); }
    const u = await db().query('UPDATE users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING session_version', [req.user.id, hashPassword(newPassword)]);
    await audit((t, p) => db().query(t, p), { userId: req.user.id, action: '變更自己的密碼' });
    req.session = { uid: req.user.id, sv: u.rows[0].session_version };
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
