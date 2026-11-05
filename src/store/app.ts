import { create } from 'zustand';
import {
  desktopCreateNode,
  desktopDelete,
  desktopListDocs,
  desktopMove,
  desktopRename,
  desktopWriteDoc,
  isMdTitle,
} from '../lib/desktop';
import type { DecryptedDoc } from '../lib/types';

export type Phase = 'boot' | 'ready';
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 1500;

interface AppState {
  phase: Phase;
  bootError: string | null;
  docs: Record<string, DecryptedDoc>;
  activeId: string | null;
  expanded: Record<string, boolean>;
  saveState: SaveState;
  toast: string | null;

  boot: () => Promise<void>;
  selectDoc: (id: string) => void;
  toggleFolder: (id: string) => void;
  createNode: (parentId: string | null, isFolder: boolean, initialContent?: string) => Promise<void>;
  createNodeNamed: (parentId: string | null, isFolder: boolean, name: string) => Promise<void>;
  renameNode: (id: string, title: string) => Promise<void>;
  moveNode: (id: string, parentId: string | null) => Promise<void>;
  deleteNode: (id: string) => Promise<void>;
  updateContent: (id: string, content: string) => void;
  flush: () => Promise<void>;
  showToast: (msg: string) => void;
  dismissToast: () => void;
}

const dirty = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let flushQueued = false;

export function childrenOf(docs: Record<string, DecryptedDoc>, parentId: string | null): DecryptedDoc[] {
  // 文件系统没有手动顺序，按名称排序（中文按拼音习惯）
  return Object.values(docs)
    .filter((d) => d.parentId === parentId)
    .sort((a, b) => a.title.localeCompare(b.title, 'zh'));
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

// 目录改名/移动会改变子树所有路径（id），整体重映射
function remapIds(
  state: { docs: Record<string, DecryptedDoc>; activeId: string | null; expanded: Record<string, boolean> },
  oldPrefix: string,
  newPrefix: string,
  newTitle?: string
): { docs: Record<string, DecryptedDoc>; activeId: string | null; expanded: Record<string, boolean> } {
  const docs: Record<string, DecryptedDoc> = {};
  for (const [id, d] of Object.entries(state.docs)) {
    if (id.startsWith(oldPrefix)) {
      const nid = newPrefix + id.slice(oldPrefix.length);
      docs[nid] = {
        ...d,
        id: nid,
        parentId: d.parentId && d.parentId.startsWith(oldPrefix) ? newPrefix + d.parentId.slice(oldPrefix.length) : d.parentId,
        title: id === oldPrefix && newTitle !== undefined ? newTitle : d.title,
      };
    } else {
      docs[id] = d;
    }
  }
  const activeId = state.activeId?.startsWith(oldPrefix)
    ? newPrefix + state.activeId.slice(oldPrefix.length)
    : state.activeId;
  const expanded: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(state.expanded)) {
    expanded[k.startsWith(oldPrefix) ? newPrefix + k.slice(oldPrefix.length) : k] = v;
  }
  return { docs, activeId, expanded };
}

function scheduleAutosave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void useStore.getState().flush();
  }, AUTOSAVE_DELAY_MS);
}

export const useStore = create<AppState>()((set, get) => ({
  phase: 'boot',
  bootError: null,
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
      const docs = await desktopListDocs();
      const first = childrenOf(docs, null).find((d) => !d.isFolder);
      set({ phase: 'ready', docs, activeId: first?.id ?? null });
      if (Object.keys(docs).length === 0) {
        await get().createNode(null, false, WELCOME_CONTENT);
      }
    } catch {
      set({ phase: 'boot', bootError: '本地笔记库读取失败，请重试' });
    }
  },

  selectDoc: (id) => {
    // 切换文档前把未落盘的内容先写出去，防止防抖窗口内切换导致丢失
    void get().flush();
    set({ activeId: id });
  },

  toggleFolder: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),

  createNode: async (parentId, isFolder, initialContent) => {
    await get().flush(); // 先落盘当前文档，防抖窗口内新建会丢内容
    try {
      const node = await desktopCreateNode(parentId, isFolder);
      if (initialContent && !isFolder) {
        node.content = initialContent;
        await desktopWriteDoc(node.id, initialContent);
      }
      set((s) => ({
        docs: { ...s.docs, [node.id]: node },
        activeId: isFolder ? s.activeId : node.id,
        expanded: parentId ? { ...s.expanded, [parentId]: true } : s.expanded,
      }));
    } catch {
      get().showToast('创建失败');
    }
  },

  createNodeNamed: async (parentId, isFolder, name) => {
    await get().flush();
    try {
      const node = await desktopCreateNode(parentId, isFolder, name);
      set((s) => ({
        docs: { ...s.docs, [node.id]: node },
        activeId: isFolder ? s.activeId : node.id,
        expanded: parentId ? { ...s.expanded, [parentId]: true } : s.expanded,
      }));
    } catch {
      get().showToast('创建失败（名称非法或已存在）');
    }
  },

  renameNode: async (id, title) => {
    await get().flush(); // 先按旧路径写盘，防抖队列里的路径才不会因改名失效
    const doc = get().docs[id];
    if (!doc || doc.title === title) return;
    try {
      const change = await desktopRename(id, title);
      set((s) => remapIds(s, change.old_path, change.new_path, isMdTitle(change.new_path)));
    } catch {
      get().showToast('重命名失败（名称含非法字符或已存在）');
    }
  },

  moveNode: async (id, parentId) => {
    await get().flush(); // 同 rename：先按旧路径落盘
    const { docs } = get();
    const doc = docs[id];
    if (!doc) return;
    if (parentId && (parentId === id || isDescendant(docs, id, parentId))) {
      get().showToast('不能移动到自身或其子文件夹内');
      return;
    }
    if (doc.parentId === parentId) return;
    try {
      const change = await desktopMove(id, parentId);
      set((s) => {
        const remapped = remapIds(s, change.old_path, change.new_path);
        return {
          ...remapped,
          expanded: parentId ? { ...remapped.expanded, [parentId]: true } : remapped.expanded,
        };
      });
    } catch {
      get().showToast('移动失败（目标已存在同名文件）');
    }
  },

  deleteNode: async (id) => {
    await get().flush();
    const { docs, activeId } = get();
    const ids = collectSubtree(docs, id);
    try {
      await desktopDelete(id);
    } catch {
      get().showToast('删除失败');
      return;
    }
    const remaining: Record<string, DecryptedDoc> = { ...docs };
    for (const i of ids) {
      delete remaining[i];
      dirty.delete(i);
    }
    let nextActive = activeId;
    if (activeId && ids.includes(activeId)) {
      nextActive = childrenOf(remaining, docs[id]?.parentId ?? null).find((d) => !d.isFolder)?.id ?? null;
    }
    set({ docs: remaining, activeId: nextActive });
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
    if (dirty.size === 0) {
      set({ saveState: 'idle' });
      return;
    }
    flushing = true;
    set({ saveState: 'saving' });
    try {
      const docsNow = get().docs;
      for (const id of dirty) {
        const d = docsNow[id];
        if (d) await desktopWriteDoc(id, d.content);
      }
      dirty.clear();
      set({ saveState: 'saved' });
      setTimeout(() => {
        if (useStore.getState().saveState === 'saved') set({ saveState: 'idle' });
      }, 2000);
    } catch {
      set({ saveState: 'error' });
      get().showToast('写入本地文件失败，将自动重试');
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

const WELCOME_CONTENT = `# 欢迎使用墨匣

笔记以 Markdown 文件保存在本机 \`墨匣\` 文件夹（用户主目录下），不联网、不上传，文件树就是真实的文件夹结构。

## 常用能力

- 左侧**文件树**：新建 / 重命名 / 删除 / 拖拽归类，重命名会同步改名磁盘文件
- 中间**所见即所得**：输入即渲染，光标贴着语法标记时显示源码
- 右侧**大纲目录**：自动生成，点击跳转；截图可直接粘贴，图片存在 \`.assets\` 文件夹

## 语法示例

\`\`\`ts
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

- [x] 自动保存（停顿 1.5 秒后写入磁盘）
- [ ] 开始写你的第一篇文档
`;
