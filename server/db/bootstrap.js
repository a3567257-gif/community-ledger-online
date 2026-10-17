// 第一次啟動：資料庫裡還沒有任何帳號時，用環境變數 ADMIN_LOGIN / ADMIN_PASSWORD 建立樓管家最高管理者帳號，
// 並建立「樓管家（示範）」公司與一個示範社區（幸福花園社區，36 戶虛構資料），方便馬上展示給物業公司看。
// 之後再啟動不會重複建立，也不會改到既有資料。
const fs = require('fs');
const path = require('path');
const { db } = require('../db.js');
const { hashPassword, validateNewPassword, audit } = require('../auth.js');
const ledger = require('../ledger.js');

async function bootstrap() {
  const n = await db().query('SELECT count(*)::int AS n FROM users');
  if (n.rows[0].n > 0) return;
  const login = process.env.ADMIN_LOGIN;
  const password = process.env.ADMIN_PASSWORD;
  if (!login || !password) {
    console.warn('尚未建立任何帳號：請設定環境變數 ADMIN_LOGIN 與 ADMIN_PASSWORD 後重新啟動，系統會自動建立最高管理者帳號。');
    return;
  }
  validateNewPassword(password);
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'demo_seed.json'), 'utf-8'));
  await db().tx(async q => {
    const u = await q("INSERT INTO users (login, password_hash, display_name, role) VALUES ($1, $2, '樓管家', 'super_admin') RETURNING id", [login, hashPassword(password)]);
    const co = await q("INSERT INTO companies (name) VALUES ('樓管家（示範）') RETURNING id");
    const doc = ledger.newDocFor({ edition: 'demo', seed });
    const c = await q("INSERT INTO communities (company_id, name, edition, license_until) VALUES ($1, '幸福花園社區（示範）', 'demo', '2099-12') RETURNING id", [co.rows[0].id]);
    await q('INSERT INTO community_data (community_id, doc) VALUES ($1, $2)', [c.rows[0].id, JSON.stringify(doc)]);
    await audit(q, { userId: u.rows[0].id, action: '系統初始化：建立最高管理者與示範社區' });
  });
  console.log(`已建立最高管理者帳號「${login}」與示範社區。`);
}

module.exports = { bootstrap };
