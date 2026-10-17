// API 測試：用記憶體資料庫（PGlite）啟動整個伺服器，走真正的 HTTP 請求。
// 重點：不同公司看不到彼此的社區、授權到期進入唯讀、上傳／下載、快照還原、操作紀錄不可修改。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.TZ = 'Asia/Taipei';
process.env.ADMIN_LOGIN = 'boss';
process.env.ADMIN_PASSWORD = 'test-password-123';
delete process.env.NODE_ENV;

const dbm = require('../server/db.js');
const { bootstrap } = require('../server/db/bootstrap.js');
const { createApp } = require('../server/index.js');

const DEMO = f => path.join(__dirname, '..', 'assets', 'demo-files', f);
let server, base;

// 簡單的 cookie 罐：每個 client 各自保持登入
function client() {
  let cookie = '';
  async function call(method, url, body, isForm) {
    const headers = { cookie };
    let payload;
    if (isForm) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
    return res;
  }
  return {
    get: async url => call('GET', url),
    json: async (method, url, body) => (await call(method, url, body)).json(),
    async upload(url, file, name) {
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(file)]), name || path.basename(file));
      return (await call('POST', url, fd, true)).json();
    },
    async login(login, password) { return this.json('POST', '/api/auth/login', { login, password }); },
  };
}

const rpc = (c, cid, ch, args = {}) => c.json('POST', `/api/c/${cid}/rpc/${ch}`, args);

test.before(async () => {
  await dbm.connect('memory://');
  await dbm.migrate();
  await bootstrap();
  const app = createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await dbm.close();
});

test('登入、權限隔離、授權唯讀、完整記帳流程', async () => {
  const boss = client();
  assert.strictEqual((await boss.login('boss', 'wrong')).ok, false);
  assert.strictEqual((await boss.login('boss', 'test-password-123')).ok, true);

  const me = await boss.json('GET', '/api/me');
  assert.strictEqual(me.user.role, 'super_admin');
  assert.strictEqual(me.communities.length, 1, '初始化會建立一個示範社區');
  const demoId = me.communities[0].id;

  // 兩家物業公司，各一個正式社區
  const coA = (await boss.json('POST', '/api/admin/companies', { name: 'A 物業' })).id;
  const coB = (await boss.json('POST', '/api/admin/companies', { name: 'B 物業' })).id;
  const a1 = (await boss.json('POST', '/api/admin/communities', { companyId: coA, name: 'A1 社區', edition: 'formal', licenseUntil: '2099-12' })).id;
  const b1 = (await boss.json('POST', '/api/admin/communities', { companyId: coB, name: 'B1 社區', edition: 'formal', licenseUntil: '2099-12' })).id;
  assert.ok(a1 && b1);

  assert.strictEqual((await boss.json('POST', '/api/admin/users', { login: 'a-admin', password: 'password-a-1', role: 'company_admin', companyId: coA })).ok, true);
  assert.strictEqual((await boss.json('POST', '/api/admin/users', { login: 'a1-staff', password: 'password-a1-1', role: 'community_user', companyId: coA, communityIds: [a1] })).ok, true);
  // 不能把 B 公司的社區指派給 A 公司的帳號
  assert.strictEqual((await boss.json('POST', '/api/admin/users', { login: 'bad', password: 'password-bad-1', role: 'community_user', companyId: coA, communityIds: [b1] })).ok, false);

  const aAdmin = client();
  assert.ok((await aAdmin.login('a-admin', 'password-a-1')).ok);
  assert.deepStrictEqual((await aAdmin.json('GET', '/api/me')).communities.map(c => c.id), [a1]);
  assert.strictEqual(Array.isArray(await rpc(aAdmin, a1, 'households:list')), true);
  const denied = await rpc(aAdmin, b1, 'households:list');
  assert.strictEqual(denied.ok, false, 'A 公司管理者不能看 B 社區');
  assert.strictEqual((await rpc(aAdmin, demoId, 'households:list')).ok, false);
  // 物業公司管理者不能新增社區、不能改授權、只能建社區經理帳號
  assert.strictEqual((await aAdmin.json('POST', '/api/admin/communities', { companyId: coA, name: 'x' })).ok, false);
  assert.strictEqual((await aAdmin.json('PATCH', `/api/admin/communities/${a1}`, { licenseUntil: '2199-12' })).ok, false);
  assert.strictEqual((await aAdmin.json('POST', '/api/admin/users', { login: 'a-admin2', password: 'password-a-2', role: 'company_admin' })).ok, false);
  const ov = await aAdmin.json('GET', '/api/admin/overview');
  assert.deepStrictEqual(ov.communities.map(c => c.id), [a1]);

  const staff = client();
  assert.ok((await staff.login('a1-staff', 'password-a1-1')).ok);
  assert.strictEqual((await staff.json('GET', '/api/admin/overview')).ok, false, '社區經理不能進後台');
  assert.strictEqual((await rpc(staff, b1, 'households:list')).ok, false);

  // 正式社區：空白開帳，社區名稱已經帶入
  assert.strictEqual((await rpc(staff, a1, 'community:get')).name, 'A1 社區');
  const info = await rpc(staff, a1, 'app:info');
  assert.strictEqual(info.isDemo, false);
  assert.strictEqual((await rpc(staff, a1, 'system:resetData')).ok, false, '正式社區不能還原示範資料');

  // 示範社區完整流程（用 HTTP 上傳示範 Excel）
  const unpaid = await boss.upload(`/api/c/${demoId}/upload/unpaid:importFile`, DEMO('demo2_unpaid.xlsx'), '示範2_未繳名單.xlsx');
  assert.strictEqual(unpaid.ok, true, unpaid.error);
  assert.ok(unpaid.createdCount > 0);
  const prepaid = await boss.upload(`/api/c/${demoId}/upload/prepaid:importFile`, DEMO('demo3_prepaid.xlsx'));
  assert.strictEqual(prepaid.ok, true, prepaid.error);
  const gen = await rpc(boss, demoId, 'ledger:generatePeriod');
  assert.strictEqual(gen.ok, true, gen.error);
  assert.strictEqual(gen.created, 34);
  const bank = await boss.upload(`/api/c/${demoId}/upload/bank:pickFile`, DEMO('demo4_bank_11507.xlsx'), '示範4_銀行明細_115年07月.xlsx');
  assert.strictEqual(bank.ok, true, bank.error);
  assert.strictEqual(bank.unmatched.length, 1);
  const imports = await rpc(boss, demoId, 'bank:imports');
  assert.strictEqual(imports.imports[0].filename, '示範4_銀行明細_115年07月.xlsx', '中文檔名要正確保存');
  const dup = await boss.upload(`/api/c/${demoId}/upload/bank:pickFile`, DEMO('demo4_bank_11507.xlsx'));
  assert.strictEqual(dup.ok, false);
  assert.match(dup.error, /已經匯入過了/);
  const hh = await rpc(boss, demoId, 'households:list');
  const h6 = hh.find(h => h.unit === '101-6F');
  const mm = await rpc(boss, demoId, 'bank:manualMatch', { transactionId: bank.unmatched[0].transactionId, householdId: h6.id });
  assert.strictEqual(mm.ok, true, mm.error);

  // 月結報表、範本、示範檔、備份下載
  const rep = await boss.get(`/api/c/${demoId}/download/report`);
  assert.strictEqual(rep.status, 200);
  assert.match(rep.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.ok((await rep.arrayBuffer()).byteLength > 1000);
  assert.strictEqual((await boss.get(`/api/c/${demoId}/download/template/bank`)).status, 200);
  assert.strictEqual((await boss.get(`/api/c/${demoId}/download/demo/4`)).status, 200);
  assert.strictEqual((await staff.get(`/api/c/${a1}/download/demo/4`)).status, 404, '正式社區沒有示範檔');
  const bk = await boss.get(`/api/c/${demoId}/download/backup`);
  const backupDoc = await bk.json();
  assert.ok(Array.isArray(backupDoc.households));

  // 快照：每日自動快照、還原前自動快照
  const st = await rpc(boss, demoId, 'backup:status');
  assert.ok(st.status.backups.some(b => b.reason === 'auto-daily'));
  const reset = await rpc(boss, demoId, 'system:resetData');
  assert.strictEqual(reset.ok, true, reset.error);
  assert.match(reset.safetyBackupPath, /^before-reset-demo-/);
  assert.strictEqual((await rpc(boss, demoId, 'ledger:periodStatus')).generated, false);
  const st2 = await rpc(boss, demoId, 'backup:status');
  const snap = st2.status.backups.find(b => b.reason === 'before-reset-demo');
  const restored = await rpc(boss, demoId, 'backup:restoreFromAuto', { snapshotId: snap.id });
  assert.strictEqual(restored.ok, true, restored.error);
  assert.strictEqual((await rpc(boss, demoId, 'ledger:periodStatus')).generated, true, '還原後回到產生帳款之後的狀態');
  // 上傳備份檔還原
  const upRestore = await boss.upload(`/api/c/${demoId}/upload/backup:restoreFromFile`, writeTmp(JSON.stringify(backupDoc)), 'backup.json');
  assert.strictEqual(upRestore.ok, true, upRestore.error);

  // 授權到期 → 唯讀：會改資料的動作被擋，匯出照常
  assert.strictEqual((await boss.json('PATCH', `/api/admin/communities/${a1}`, { licenseUntil: '2020-01' })).ok, true);
  const lic = await rpc(staff, a1, 'license:status');
  assert.strictEqual(lic.active, false);
  const blocked = await rpc(staff, a1, 'community:save', { name: '改名' });
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.error, /唯讀/);
  const blockedUp = await staff.upload(`/api/c/${a1}/upload/households:importFile`, DEMO('demo1_households.xlsx'));
  assert.strictEqual(blockedUp.ok, false);
  assert.strictEqual((await staff.get(`/api/c/${a1}/download/report`)).status, 200);
  assert.strictEqual((await staff.get(`/api/c/${a1}/download/backup`)).status, 200);

  // 停用帳號後，原本的登入立即失效
  const staffId = (await boss.json('GET', '/api/admin/overview')).users.find(u => u.login === 'a1-staff').id;
  await boss.json('PATCH', `/api/admin/users/${staffId}`, { active: false });
  assert.strictEqual((await staff.json('GET', '/api/me')).ok, false);

  // 操作紀錄有記錄，而且資料庫層面不可修改
  const audit = await boss.json('GET', `/api/admin/audit?communityId=${demoId}`);
  assert.ok(audit.rows.some(r => r.action === '匯入銀行明細'));
  await assert.rejects(dbm.db().query("UPDATE audit_log SET action = 'x'"));
  await assert.rejects(dbm.db().query('DELETE FROM audit_log'));
});

test('沒登入不能用任何社區 API；別的網站送來的請求會被擋', async () => {
  const anon = client();
  const r = await anon.json('POST', '/api/c/1/rpc/households:list', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needLogin, true);
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.strictEqual(res.status, 403);
  const page = await anon.get('/');
  assert.strictEqual(page.status, 302);
});

function writeTmp(text) {
  const p = path.join(require('os').tmpdir(), `cl-restore-${Date.now()}.json`);
  fs.writeFileSync(p, text);
  return p;
}
