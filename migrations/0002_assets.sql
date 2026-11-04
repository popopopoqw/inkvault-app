-- 图片等附件：与文档同样只存密文（客户端加密 {mime, data}）
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  cipher TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL
);
