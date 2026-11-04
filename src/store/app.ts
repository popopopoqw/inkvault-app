import { create } from 'zustand';
import { api, setSessionToken, setUnauthorizedHandler } from '../lib/api';
import {
  currentKey,
  decryptDoc,
  deriveAuthHash,
  deriveEncKey,
  dropKey,
  encryptDoc,
  holdKey,
  randomHex,
} from '../lib/crypto';
import type { DecryptedDoc, EncryptedDoc } from '../lib/types';

export type Phase = 'boot' | 'setup' | 'login' | 'ready';
export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

const AUTOSAVE_DELAY_MS = 1500;

interface AuthInfo {
  initialized: boolean;
  authSalt?: string;
  encSalt?: string;
}

interface AppState {
  phase: Phase;
  bootError: string | null;
  authBusy: boolean;
  authError: string | null;
  docs: Record<string, DecryptedDoc>;
  activeId: string | null;
  expanded: Record<string, boolean>;
  saveState: SaveState;
  toast: string | null;

  boot: () => Promise<void>;
  setup: (password: string) => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectDoc: (id: string) => void;
  toggleFolder: (id: string) => void;
  createNode: (parentId: string | null, isFolder: boolean, initialContent?: string) => Promise<void>;
  renameNode: (id: string, title: string) => Promise<void>;
  moveNode: (id: string, parentId: string | null, sortKey: number) => Promise<void>;
  deleteNode: (id: string) => Promise<void>;
  updateContent: (id: string, content: string) => void;
  flush: () => Promise<void>;
  showToast: (msg: string) => void;
  dismissToast: () => void;
}

const dirty = new Set<string>();
const pendingDeletes = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let authInfo: AuthInfo = { initialized: false };
let flushing = false;
let flushQueued = false;

export function childrenOf(docs: Record<string, DecryptedDoc>, parentId: string | null): DecryptedDoc[] {
  return Object.values(docs)
    .filter((d) => d.parentId === parentId)
    .sort((a, b) => a.sortKey - b.sortKey || a.id.localeCompare(b.id));
}

export function collectSubtree(docs: Record<string, DecryptedDoc>, rootId: string): string[] {
  const out = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const d of Object.values(docs)) {
      if (d.parentId === cur && !out.includes(d.id)) {
        out.push(d.id);
        queue.push(d.id);
      }
    }
  }
  return out;
}

export function isDescendant(docs: Record<string, DecryptedDoc>, ancestorId: string, nodeId: string): boolean {
  let cur: string | null = nodeId;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = docs[cur]?.parentId ?? null;
  }
  return false;
}

// 计算插入到 before/after 两个兄弟之间（任一可为 null）的 sortKey
export function sortKeyBetween(docs: Record<string, DecryptedDoc>, parentId: string | null, before: string | null, after: string | null): number {
  const siblings = childrenOf(docs, parentId);
  const prev = before ? siblings.find((d) => d.id === before)?.sortKey : null;
  const next = after ? siblings.find((d) => d.id === after)?.sortKey : null;
  if (prev != null && next != null) return (prev + next) / 2;
  if (prev != null) return prev + 1;
  if (next != null) return next - 1;
  return siblings.length ? Math.max(...siblings.map((d) => d.sortKey)) + 1 : 1;
}

function scheduleAutosave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void useStore.getState().flush();
  }, AUTOSAVE_DELAY_MS);
}

async function applyServerRows(rows: EncryptedDoc[]): Promise<Record<string, DecryptedDoc>> {
  const key = currentKey();
  if (!key) throw new Error('no_key');
  const out: Record<string, DecryptedDoc> = {};
  for (const row of rows) {
    try {
      const payload = await decryptDoc(key, row.cipher, row.nonce);
      out[row.id] = {
        id: row.id,
        parentId: row.parentId,
        isFolder: !!row.isFolder, // D1 返回 0/1，转为布尔，避免 JSX 渲染出 "0" 且上传时被校验拒绝
        sortKey: row.sortKey,
        version: row.version,
        updatedAt: row.updatedAt,
        title: payload.title,
        content: payload.content,
      };
    } catch {
      // 单篇解密失败（如旧密钥残留）跳过，不让整个应用不可用
    }
  }
  return out;
}

export const useStore = create<AppState>()((set, get) => ({
  phase: 'boot',
  bootError: null,
  authBusy: false,
  authError: null,
  docs: {},
  activeId: null,
  expanded: {},
  saveState: 'idle',
  toast: null,

  showToast: (msg) => {
    set({ toast: msg });
    setTimeout(() => {
      if (useStore.getState().toast === msg) set({ toast: null });
    }, 4000);
  },
  dismissToast: () => set({ toast: null }),

  boot: async () => {
    try {
      authInfo = await api<AuthInfo>('/auth/info');
      set({ phase: authInfo.initialized ? 'login' : 'setup' });
    } catch {
      set({ phase: 'boot', bootError: '无法连接服务，请刷新重试' });
    }
  },

  setup: async (password) => {
    set({ authBusy: true, authError: null });
    try {
      const authSalt = randomHex(16);
      const encSalt = randomHex(16);
      const authHash = await deriveAuthHash(password, authSalt);
      holdKey(await deriveEncKey(password, encSalt));
      const { token } = await api<{ token: string }>('/auth/setup', { method: 'POST', body: { authHash, authSalt, encSalt } });
      setSessionToken(token);
      const { docs } = await api<{ docs: EncryptedDoc[] }>('/state');
      const decrypted = await applyServerRows(docs);
      set({ phase: 'ready', docs: decrypted, authBusy: false });
      if (Object.keys(decrypted).length === 0) {
        await get().createNode(null, false, WELCOME_CONTENT);
      }
    } catch (e) {
      dropKey();
      setSessionToken(null);
      set({ authBusy: false, authError: errorMessage(e) });
    }
  },

  login: async (password) => {
    set({ authBusy: true, authError: null });
    try {
      if (!authInfo.authSalt || !authInfo.encSalt) throw new Error('服务未初始化');
      const authHash = await deriveAuthHash(password, authInfo.authSalt);
      const { token } = await api<{ token: string }>('/auth/login', { method: 'POST', body: { authHash } });
      holdKey(await deriveEncKey(password, authInfo.encSalt));
      setSessionToken(token);
      const { docs } = await api<{ docs: EncryptedDoc[] }>('/state');
      const decrypted = await applyServerRows(docs);
      const first = childrenOf(decrypted, null).find((d) => !d.isFolder);
      set({ phase: 'ready', docs: decrypted, activeId: first?.id ?? null, authBusy: false });
    } catch (e) {
      dropKey();
      setSessionToken(null);
      set({ authBusy: false, authError: errorMessage(e) });
    }
  },

  logout: async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* 会话已失效也照常登出 */
    }
    dirty.clear();
    pendingDeletes.clear();
    dropKey();
    setSessionToken(null);
    set({ phase: 'login', docs: {}, activeId: null, expanded: {}, saveState: 'idle' });
  },

  selectDoc: (id) => set({ activeId: id }),

  toggleFolder: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),

  createNode: async (parentId, isFolder, initialContent) => {
    const { docs } = get();
    const id = randomHex(16);
    const sortKey = sortKeyBetween(docs, parentId, null, null);
    const node: DecryptedDoc = {
      id,
      parentId,
      isFolder,
      sortKey,
      version: 0,
      title: isFolder ? '新文件夹' : '无标题文档',
      content: initialContent ?? '',
    };
    set((s) => ({
      docs: { ...s.docs, [id]: node },
      activeId: isFolder ? s.activeId : id,
      expanded: parentId ? { ...s.expanded, [parentId]: true } : s.expanded,
    }));
    dirty.add(id);
    await get().flush();
  },

  renameNode: async (id, title) => {
    const doc = get().docs[id];
    if (!doc || doc.title === title) return;
    set((s) => ({ docs: { ...s.docs, [id]: { ...doc, title } } }));
    dirty.add(id);
    await get().flush();
  },

  moveNode: async (id, parentId, sortKey) => {
    const { docs } = get();
    const doc = docs[id];
    if (!doc) return;
    if (parentId && (parentId === id || isDescendant(docs, id, parentId))) {
      get().showToast('不能移动到自身或其子文件夹内');
      return;
    }
    if (doc.parentId === parentId && doc.sortKey === sortKey) return;
    set((s) => ({
      docs: { ...s.docs, [id]: { ...doc, parentId, sortKey } },
      expanded: parentId ? { ...s.expanded, [parentId]: true } : s.expanded,
    }));
    dirty.add(id);
    await get().flush();
  },

  deleteNode: async (id) => {
    const { docs, activeId } = get();
    const ids = collectSubtree(docs, id);
    const remaining: Record<string, DecryptedDoc> = { ...docs };
    for (const i of ids) {
      delete remaining[i];
      pendingDeletes.add(i);
      dirty.delete(i);
    }
    let nextActive = activeId;
    if (activeId && ids.includes(activeId)) {
      const parent = docs[id]?.parentId ?? null;
      nextActive = childrenOf(remaining, parent).find((d) => !d.isFolder)?.id ?? null;
    }
    set({ docs: remaining, activeId: nextActive });
    await get().flush();
  },

  updateContent: (id, content) => {
    const doc = get().docs[id];
    if (!doc || doc.content === content) return;
    set((s) => ({ docs: { ...s.docs, [id]: { ...doc, content } } }));
    dirty.add(id);
    scheduleAutosave();
  },

  flush: async () => {
    if (flushing) {
      flushQueued = true;
      return;
    }
    if (dirty.size === 0 && pendingDeletes.size === 0) {
      set({ saveState: 'idle' });
      return;
    }
    const key = currentKey();
    if (!key) return;
    flushing = true;
    set({ saveState: 'saving' });
    try {
      const docs = get().docs;
      const upserts: EncryptedDoc[] = [];
      for (const id of dirty) {
        const d = docs[id];
        if (!d) continue;
        const { cipher, nonce } = await encryptDoc(key, { title: d.title, content: d.content });
        upserts.push({
          id: d.id,
          parentId: d.parentId,
          isFolder: d.isFolder,
          sortKey: d.sortKey,
          version: d.version,
          cipher,
          nonce,
        });
      }
      const deletes = [...pendingDeletes];
      const res = await api<{ docs: EncryptedDoc[] }>('/docs/sync', { method: 'POST', body: { upserts, deletes } });
      dirty.clear();
      pendingDeletes.clear();
      // 正常保存：仅回填服务端版本号，本地明文就是最新
      set((s) => {
        const versionById = new Map(res.docs.map((r) => [r.id, r.version]));
        const docsCopy = { ...s.docs };
        for (const [id, ver] of versionById) {
          if (docsCopy[id]) docsCopy[id] = { ...docsCopy[id], version: ver };
        }
        return { docs: docsCopy, saveState: 'saved' };
      });
      setTimeout(() => {
        if (useStore.getState().saveState === 'saved') set({ saveState: 'idle' });
      }, 2000);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) {
        // 其他设备已修改：用服务端数据覆盖本地并提示
        const data = (e as { data?: { docs?: EncryptedDoc[] } }).data;
        if (data?.docs) {
          const decrypted = await applyServerRows(data.docs);
          dirty.clear();
          pendingDeletes.clear();
          const first = childrenOf(decrypted, null).find((d) => !d.isFolder);
          set({ docs: decrypted, activeId: first?.id ?? null, saveState: 'conflict' });
          get().showToast('文档已在其他设备修改，已同步为最新版本');
          return;
        }
      }
      set({ saveState: 'error' });
      get().showToast('保存失败，请检查网络（内容仍保留在本地，将自动重试）');
      scheduleAutosave();
    } finally {
      flushing = false;
      if (flushQueued) {
        flushQueued = false;
        scheduleAutosave();
      }
    }
  },
}));

function errorMessage(e: unknown): string {
  const status = (e as { status?: number })?.status;
  if (status === 401) return '密码错误';
  if (status === 429) return '尝试次数过多，已锁定 15 分钟';
  if (status === 403) return '已初始化，请直接登录';
  return '请求失败，请重试';
}

// 会话过期（7 天）或被顶替时，回到登录页
setUnauthorizedHandler(() => {
  dirty.clear();
  pendingDeletes.clear();
  dropKey();
  setSessionToken(null);
  useStore.setState({ phase: 'login', docs: {}, activeId: null, saveState: 'idle' });
});

const WELCOME_CONTENT = `# 欢迎使用 Markdown 编辑器

所有内容在**浏览器内加密**后才上传，服务器只保存密文。

## 常用能力

- 左侧**文件树**：新建 / 重命名 / 删除 / 拖拽整理文档与文件夹
- 中间**双栏实时预览**：输入即渲染，支持编辑 / 分屏 / 预览三种模式
- 右侧**大纲目录**：自动生成，点击跳转

## 语法示例

行内代码 \`const x = 1\`，以及代码块：

\`\`\`ts
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

> 引用、任务列表、表格都支持：

| 功能 | 状态 |
| --- | --- |
| 实时渲染 | ✅ |
| 端到端加密 | ✅ |

- [x] 自动保存（停顿 1.5 秒后加密上传）
- [ ] 开始写你的第一篇文档

---

⚠️ 提醒：密码**无法找回**（端到端加密，服务器没有密码），请务必记牢。
`;
