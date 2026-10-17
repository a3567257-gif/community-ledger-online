// 資料庫連線。
// 有設定 DATABASE_URL（雲端，例如 Neon）→ 用正式的 PostgreSQL；
// 沒有設定 → 用 PGlite（內嵌在程式裡的 PostgreSQL），資料存在 LOCAL_DB_DIR（預設 ./local-data），
// 在自己電腦上開發、測試不用安裝或註冊任何資料庫。DATABASE_URL=memory:// 代表只存在記憶體（測試用）。
const fs = require('fs');
const path = require('path');

let impl = null;

// 從 Neon 畫面複製時常多帶東西：前面的「psql」、前後的引號或空白。只取出 postgresql://… 那一段。
function cleanDatabaseUrl(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/postgres(ql)?:\/\/[^\s'"]+/);
  return m ? m[0] : s;
}

async function connect(rawUrl = process.env.DATABASE_URL) {
  if (impl) return impl;
  const url = cleanDatabaseUrl(rawUrl);
  // 雲端正式環境一定要用正式資料庫：內建的 PGlite 很吃記憶體（免費主機 512MB 會爆），而且主機重開資料就會不見
  if (process.env.NODE_ENV === 'production' && !/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(rawUrl
      ? 'DATABASE_URL 的格式不正確：應該是 postgresql:// 開頭的網址（從 Neon 的 Connection string 複製）。請到主機的 Environment 設定檢查。'
      : '沒有設定 DATABASE_URL：請到主機的 Environment 設定貼上 Neon 的 Connection string（postgresql:// 開頭）。');
  }
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { Pool } = require('pg');
    // 加密連線由網址裡的 sslmode=require 決定（Neon 提供的連線網址本來就有）
    const pool = new Pool({ connectionString: url, max: 5 });
    impl = {
      kind: 'postgres',
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn((text, params) => client.query(text, params));
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    let dataDir;
    if (url === 'memory://') dataDir = undefined;
    else {
      dataDir = path.resolve(process.env.LOCAL_DB_DIR || path.join(__dirname, '..', 'local-data'));
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const db = new PGlite(dataDir);
    await db.waitReady;
    impl = {
      kind: 'pglite',
      query: (text, params) => db.query(text, params),
      exec: (text) => db.exec(text),
      tx: (fn) => db.transaction(t => fn((text, params) => t.query(text, params))),
      close: () => db.close(),
    };
  }
  return impl;
}

function db() {
  if (!impl) throw new Error('資料庫還沒連線');
  return impl;
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf-8');
  await db().exec(sql);
}

async function close() {
  if (impl) await impl.close();
  impl = null;
}

module.exports = { connect, db, migrate, close, cleanDatabaseUrl };
