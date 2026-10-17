// 社區AI帳房 線上版：伺服器進入點
// 所有日期一律用台灣時間（雲端主機預設是 UTC，不設定的話「今天」「本期」會差 8 小時）
process.env.TZ = process.env.TZ || 'Asia/Taipei';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 本機開發：讀取專案根目錄的 .env（雲端主機上用主機的環境變數設定，不放 .env）
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') process.loadEnvFile(ENV_FILE);

const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const dbm = require('./db.js');
const { loadUser } = require('./auth.js');
const { bootstrap } = require('./db/bootstrap.js');

const IS_PROD = process.env.NODE_ENV === 'production';

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render 等主機前面有一層 HTTPS 代理
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: IS_PROD ? [] : null,
      },
    },
  }));

  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (IS_PROD) throw new Error('正式環境必須設定 SESSION_SECRET 環境變數');
    secret = crypto.randomBytes(32).toString('hex'); // 本機開發：每次重開伺服器都要重新登入
  }
  app.use(cookieSession({
    name: 'cl_session', keys: [secret], httpOnly: true, sameSite: 'lax', secure: IS_PROD,
    maxAge: 12 * 60 * 60 * 1000, // 12 小時沒操作就要重新登入
  }));
  // 有在使用就延長登入時間
  app.use((req, res, next) => { if (req.session && req.session.uid) req.session.t = Math.floor(Date.now() / 60000); next(); });
  app.use(loadUser);

  // 會改資料的 API 一律要求 JSON 或上傳表單，並檢查來源網站，防止別的網站冒用登入狀態送出請求
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ ok: false, error: '來源不正確' });
    next();
  });

  app.use('/api', require('./routes/account.js'));
  app.use('/api/admin', require('./routes/admin.js'));
  app.use('/api/c', require('./routes/community.js'));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '找不到這個功能' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
  const page = f => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', f));
  app.get('/login', page('login.html'));
  app.get('/admin', (req, res, next) => (req.user ? next() : res.redirect('/login')), page('admin.html'));
  app.get('/', (req, res, next) => (req.user ? next() : res.redirect('/login')), page('index.html'));

  app.use((err, req, res, next) => {
    console.error(err);
    if (req.path.startsWith('/api')) return res.status(500).json({ ok: false, error: '伺服器發生錯誤，請稍後再試。' });
    res.status(500).send('伺服器發生錯誤，請稍後再試。');
  });
  return app;
}

async function start() {
  await dbm.connect();
  await dbm.migrate();
  await bootstrap();
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`社區AI帳房 線上版已啟動：http://localhost:${port}（資料庫：${dbm.db().kind}）`);
  });
}

if (require.main === module) {
  start().catch(e => { console.error('啟動失敗：' + e.message); if (process.env.NODE_ENV !== 'production') console.error(e); process.exit(1); });
}

module.exports = { createApp };
