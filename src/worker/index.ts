import { Hono } from 'hono';

interface Env {
  DB: D1Database;
}

// 与前端约定的 PBKDF2 迭代次数（仅文档用途，实际派生在浏览器完成）
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_UPSERTS = 500;
const MAX_CIPHER_CHARS = 3_000_000; // ~2.2MB 密文上限

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nowIso(): string {
  return new Date().toISOString();
}

async function createSession(db: D1Database): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db
    .prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString())
    .run();
  return token;
}

async function requireSession(c: { env: { DB: D1Database }; req: { header(name: string): string | undefined } }): Promise<Response | null> {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tokenHash = await sha256Hex(token);
  const session = await c.env.DB.prepare('SELECT expires_at FROM sessions WHERE token = ?').bind(tokenHash).first<{ expires_at: string }>();
  if (!session || new Date(session.expires_at) <= new Date()) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // 滑动续期，并顺手清理过期会话
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').bind(new Date(Date.now() + SESSION_TTL_MS).toISOString(), tokenHash),
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowIso()),
  ]);
  return null;
}

async function fetchAllDocs(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT id, parent_id AS parentId, is_folder AS isFolder, cipher, nonce,
              sort_key AS sortKey, version, updated_at AS updatedAt
       FROM docs ORDER BY sort_key`
    )
    .all();
  return (results ?? []) as unknown[];
}

interface UpsertDoc {
  id: string;
  parentId: string | null;
  isFolder: boolean;
  cipher: string;
  nonce: string;
  sortKey: number;
  version: number;
}

function validUpsert(u: unknown): u is UpsertDoc {
  if (typeof u !== 'object' || u === null) return false;
  const d = u as Record<string, unknown>;
  return (
    typeof d.id === 'string' && d.id.length <= 64 &&
    (d.parentId === null || (typeof d.parentId === 'string' && d.parentId.length <= 64)) &&
    typeof d.isFolder === 'boolean' &&
    typeof d.cipher === 'string' && d.cipher.length > 0 && d.cipher.length <= MAX_CIPHER_CHARS &&
    typeof d.nonce === 'string' && d.nonce.length <= 64 &&
    typeof d.sortKey === 'number' && Number.isFinite(d.sortKey) &&
    typeof d.version === 'number' && Number.isInteger(d.version) && d.version >= 0
  );
}

const api = new Hono<{ Bindings: Env }>();

api.get('/auth/info', async (c) => {
  const row = await c.env.DB.prepare('SELECT auth_salt, enc_salt FROM auth WHERE id = 1').first<{ auth_salt: string; enc_salt: string }>();
  if (!row) return c.json({ initialized: false });
  return c.json({ initialized: true, authSalt: row.auth_salt, encSalt: row.enc_salt });
});

// 首次设置：客户端生成双 salt，仅上传登录凭证哈希；加密密钥派生材料（encSalt）虽上传但仅用于派生，密码从未离开浏览器
api.post('/auth/setup', async (c) => {
  const body = await c.req.json<{ authHash?: string; authSalt?: string; encSalt?: string }>().catch(() => null);
  if (!body || !body.authHash || !body.authSalt || !body.encSalt) {
    return c.json({ error: 'bad_request' }, 400);
  }
  const existing = await c.env.DB.prepare('SELECT 1 FROM auth WHERE id = 1').first();
  if (existing) return c.json({ error: 'already_initialized' }, 403);
  const stored = await sha256Hex(body.authHash);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO auth (id, auth_hash, auth_salt, enc_salt, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)'
    ).bind(stored, body.authSalt, body.encSalt, nowIso(), nowIso()),
  ]);
  const token = await createSession(c.env.DB);
  return c.json({ token });
});

api.post('/auth/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  const attempt = await c.env.DB
    .prepare('SELECT fail_count, locked_until FROM login_attempts WHERE ip = ?')
    .bind(ip)
    .first<{ fail_count: number; locked_until: string | null }>();
  if (attempt?.locked_until && new Date(attempt.locked_until) > new Date()) {
    return c.json({ error: 'locked', until: attempt.locked_until }, 429);
  }

  const body = await c.req.json<{ authHash?: string }>().catch(() => null);
  if (!body?.authHash) return c.json({ error: 'bad_request' }, 400);

  const row = await c.env.DB.prepare('SELECT auth_hash FROM auth WHERE id = 1').first<{ auth_hash: string }>();
  if (!row) return c.json({ error: 'not_initialized' }, 400);

  const presented = await sha256Hex(body.authHash);
  if (!timingSafeEqual(presented, row.auth_hash)) {
    const fail = (attempt?.fail_count ?? 0) + 1;
    const locked = fail >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    await c.env.DB
      .prepare(
        `INSERT INTO login_attempts (ip, fail_count, locked_until) VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until`
      )
      .bind(ip, fail, locked)
      .run();
    return c.json({ error: 'bad_credentials' }, 401);
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip),
  ]);
  const token = await createSession(c.env.DB);
  return c.json({ token });
});

api.post('/auth/logout', async (c) => {
  const denied = await requireSession(c);
  if (denied) return denied;
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256Hex(token)).run();
  return c.json({ ok: true });
});

api.get('/state', async (c) => {
  const denied = await requireSession(c);
  if (denied) return denied;
  return c.json({ docs: await fetchAllDocs(c.env.DB) });
});

api.post('/docs/sync', async (c) => {
  const denied = await requireSession(c);
  if (denied) return denied;

  const body = await c.req.json<{ upserts?: unknown[]; deletes?: unknown[] }>().catch(() => null);
  if (!body) return c.json({ error: 'bad_request' }, 400);

  const upserts = (body.upserts ?? []).slice(0, MAX_UPSERTS).filter(validUpsert);
  const deletes = (body.deletes ?? []).slice(0, MAX_UPSERTS).filter((id): id is string => typeof id === 'string' && id.length <= 64);
  const db = c.env.DB;

  // 乐观锁：客户端提交的 version 必须与服务端一致（新建节点 version=0）
  const existingVersions = new Map<string, number>();
  if (upserts.length) {
    const ids = upserts.map((u) => u.id);
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await db.prepare(`SELECT id, version FROM docs WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string; version: number }>();
    for (const r of results ?? []) existingVersions.set(r.id, r.version);
  }
  const conflicts = upserts.filter((u) => existingVersions.has(u.id) && existingVersions.get(u.id) !== u.version).map((u) => u.id);
  if (conflicts.length) {
    return c.json({ error: 'conflict', conflicts, docs: await fetchAllDocs(db) }, 409);
  }

  // 递归收集要删除的子孙节点
  const toDelete = new Set<string>(deletes);
  if (toDelete.size) {
    const { results } = await db.prepare('SELECT id, parent_id FROM docs').all<{ id: string; parent_id: string | null }>();
    const childrenOf = new Map<string, string[]>();
    for (const r of results ?? []) {
      if (r.parent_id) {
        const list = childrenOf.get(r.parent_id) ?? [];
        list.push(r.id);
        childrenOf.set(r.parent_id, list);
      }
    }
    const queue = [...toDelete];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (!toDelete.has(child)) {
          toDelete.add(child);
          queue.push(child);
        }
      }
    }
  }

  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const u of upserts) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO docs (id, parent_id, is_folder, cipher, nonce, sort_key, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             parent_id = excluded.parent_id,
             is_folder = excluded.is_folder,
             cipher = excluded.cipher,
             nonce = excluded.nonce,
             sort_key = excluded.sort_key,
             version = excluded.version,
             updated_at = excluded.updated_at`
        )
        .bind(u.id, u.parentId, u.isFolder ? 1 : 0, u.cipher, u.nonce, u.sortKey, u.version + 1, now, now)
    );
  }
  for (const id of toDelete) {
    stmts.push(db.prepare('DELETE FROM docs WHERE id = ?').bind(id));
  }
  if (stmts.length) await db.batch(stmts);

  return c.json({ docs: await fetchAllDocs(db) });
});

const app = new Hono<{ Bindings: Env }>();
app.route('/api', api);
app.notFound((c) => (new URL(c.req.url).pathname.startsWith('/api/') ? c.json({ error: 'not_found' }, 404) : c.notFound()));
app.onError(() => Response.json({ error: 'internal' }, { status: 500 }));

export default app;
