-- 社區AI帳房 線上版 資料表
-- 每個社區的帳務資料是一份 JSON 文件（community_data.doc），結構跟離線版的資料檔完全相同，
-- 業務邏輯（server/core/store.js）直接沿用離線版。其他資料表管理公司、社區、帳號、快照與操作紀錄。

CREATE TABLE IF NOT EXISTS companies (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- role：super_admin（樓管家最高管理者）、company_admin（物業公司管理者）、community_user（社區經理／秘書）
CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  login            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  display_name     TEXT NOT NULL DEFAULT '',
  role             TEXT NOT NULL CHECK (role IN ('super_admin', 'company_admin', 'community_user')),
  company_id       INTEGER REFERENCES companies(id),
  active           BOOLEAN NOT NULL DEFAULT true,
  session_version  INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at    TIMESTAMPTZ
);

-- license_until：可使用到哪一期（'YYYY-MM'），由最高管理者設定；last_seen_date：系統看過的最晚日期（只會往後）
CREATE TABLE IF NOT EXISTS communities (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id),
  name            TEXT NOT NULL,
  edition         TEXT NOT NULL DEFAULT 'formal' CHECK (edition IN ('formal', 'demo')),
  license_until   TEXT,
  last_seen_date  TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_members (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, community_id)
);

CREATE TABLE IF NOT EXISTS community_data (
  community_id  INTEGER PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  doc           JSONB NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- reason：auto-daily（每天第一次修改後自動存）、before-close-YYYY-MM、before-undo-bank、before-restore、manual …
CREATE TABLE IF NOT EXISTS snapshots (
  id            SERIAL PRIMARY KEY,
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  label         TEXT NOT NULL,
  snap_date     TEXT NOT NULL,
  doc           JSONB NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snapshots_community_idx ON snapshots (community_id, created_at DESC);

-- 操作紀錄：線上多人使用，要查得到「誰、什麼時候、做了什麼」。只新增，不修改、不刪除。
CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  community_id  INTEGER REFERENCES communities(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  detail        JSONB,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_community_idx ON audit_log (community_id, at DESC);

-- 資料庫層面強制操作紀錄不可修改、不可刪除（不只靠程式防呆）
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '操作紀錄不可修改或刪除';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
