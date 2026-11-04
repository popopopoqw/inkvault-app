-- 单用户认证：两个独立 salt
-- auth_salt: 派生登录校验 hash（hash 存服务端）
-- enc_salt:  派生内容加密密钥（仅存在于浏览器内存，永不传输）
CREATE TABLE IF NOT EXISTS auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auth_hash TEXT NOT NULL,
  auth_salt TEXT NOT NULL,
  enc_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 登录失败限速：按 IP 计数，5 次失败锁 15 分钟
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- 文档树：层级结构（parent_id）明文，标题与内容为 AES-GCM 密文
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  is_folder INTEGER NOT NULL DEFAULT 0,
  cipher TEXT NOT NULL,
  nonce TEXT NOT NULL,
  sort_key REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_parent ON docs(parent_id, sort_key);
