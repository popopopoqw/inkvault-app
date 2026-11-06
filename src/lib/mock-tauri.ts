/**
 * 浏览器测试用的 Tauri mock：内存文件系统模拟 Rust 端命令（语义对齐 src-tauri/src/main.rs）。
 * 仅在 MOCK=1 vite dev 时通过 alias 生效，不影响真实构建与 CI。
 */
import type { DecryptedDoc } from './types';

interface FsEntry {
  type: 'dir' | 'file';
  content?: string;
}

const DEFAULT_ROOT = '/users/test/墨匣';
let root: string = DEFAULT_ROOT;
const fs = new Map<string, FsEntry>();
// 版本历史模拟：docPath -> 版本列表
const history = new Map<string, { meta: any; full: string; diff: { kind: string; text: string }[] }[]>();
let idCounter = 0;

const uniqueId = () => Date.now().toString(16) + (idCounter++).toString(16).padStart(4, '0');

function mkdirp(path: string) {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    if (!fs.has(cur)) fs.set(cur, { type: 'dir' });
  }
}
mkdirp(DEFAULT_ROOT);

const sep = (p: string) => p.substring(0, p.lastIndexOf('/'));
const base = (p: string) => p.substring(p.lastIndexOf('/') + 1);

function safePath(p: string): string {
  if (!p.startsWith(root)) throw new Error('path outside vault');
  if (p.split('/').includes('..')) throw new Error('invalid path');
  return p;
}

function validName(name: string): string {
  const t = name.trim();
  if (!t || t.length > 200 || t.startsWith('.') || /[\/\\:]/.test(t)) throw new Error('invalid name');
  return t;
}

function uniqueTarget(dir: string, name: string, isFolder: boolean): string {
  let n = 1;
  for (;;) {
    const file = n === 1 ? (isFolder ? name : `${name}.md`) : isFolder ? `${name} ${n}` : `${name} ${n}.md`;
    if (!fs.has(`${dir}/${file}`)) return `${dir}/${file}`;
    n++;
  }
}

function walk(dir: string, out: { path: string; name: string; is_folder: boolean }[]) {
  const entries = [...fs.entries()].filter(([p]) => sep(p) === dir && p !== dir).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, entry] of entries) {
    const name = base(path);
    if (name.startsWith('.')) continue;
    if (entry.type === 'dir') {
      out.push({ path, name, is_folder: true });
      walk(path, out);
    } else if (name.endsWith('.md')) {
      out.push({ path, name, is_folder: false });
    }
  }
}

function invokeMock<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      switch (cmd) {
        case 'vault_root_path':
          resolve(root as T);
          return;
        case 'list_tree': {
          const out: unknown[] = [];
          walk(root, out as { path: string; name: string; is_folder: boolean }[]);
          resolve(out as T);
          return;
        }
        case 'read_doc': {
          const p = safePath(args.path as string);
          const e = fs.get(p);
          if (!e || e.type !== 'file') throw new Error('not found');
          resolve((e.content ?? '') as T);
          return;
        }
        case 'write_doc': {
          const p = safePath(args.path as string);
          const oldContent = fs.get(p)?.content ?? '';
          const newContent = args.content as string;
          fs.set(p, { type: 'file', content: newContent });
          // 模拟快照（跳过间隔节流，测试用）
          const list = history.get(p) ?? [];
          const oldLines = oldContent.split('\n');
          const newLines = newContent.split('\n');
          const added = newLines.filter((l) => !oldLines.includes(l)).length;
          const removed = oldLines.filter((l) => !newLines.includes(l)).length;
          if (list.length === 0) {
            list.push({ meta: { seq: 0, time_ms: Date.now(), added: 0, removed: 0, is_full: true }, full: oldContent, diff: [] });
          }
          list.push({
            meta: { seq: list[list.length - 1].meta.seq + 1, time_ms: Date.now(), added, removed, is_full: false },
            full: newContent,
            diff: [
              ...newLines.filter((l) => !oldLines.includes(l)).map((text) => ({ kind: 'add', text })),
              ...oldLines.filter((l) => !newLines.includes(l)).map((text) => ({ kind: 'del', text })),
            ],
          });
          history.set(p, list);
          resolve(undefined as T);
          return;
        }
        case 'create_node': {
          const parent = (args.parent as string | null) ?? root;
          if (!fs.get(parent) || fs.get(parent)!.type !== 'dir') throw new Error('parent is not a folder');
          const name = validName(args.name as string);
          const isFolder = args.isFolder as boolean;
          const target = uniqueTarget(parent, name, isFolder);
          fs.set(target, isFolder ? { type: 'dir' } : { type: 'file', content: '' });
          resolve({ path: target, name: base(target), is_folder: isFolder } as T);
          return;
        }
        case 'rename_node': {
          const old = safePath(args.path as string);
          if (!fs.has(old)) throw new Error('not found');
          const name = validName(args.newName as string);
          const isFolder = fs.get(old)!.type === 'dir';
          const target = uniqueTarget(sep(old), name, isFolder);
          if (target !== old) {
            for (const [p, e] of [...fs.entries()]) {
              if (p === old || p.startsWith(old + '/')) fs.set(target + p.slice(old.length), e);
            }
            for (const [p] of [...fs.entries()]) {
              if (p === old || p.startsWith(old + '/')) fs.delete(p);
            }
          }
          resolve({ old_path: old, new_path: target } as T);
          return;
        }
        case 'move_node': {
          const old = safePath(args.path as string);
          if (!fs.has(old)) throw new Error('not found');
          const parent = args.newParent ? safePath(args.newParent as string) : root;
          if (parent === old || parent.startsWith(old + '/')) throw new Error('cannot move into itself');
          const stem = base(old).replace(/\.md$/i, '');
          const isFolder = fs.get(old)!.type === 'dir';
          const target = uniqueTarget(parent, stem, isFolder);
          for (const [p, e] of [...fs.entries()]) {
            if (p === old || p.startsWith(old + '/')) fs.set(target + p.slice(old.length), e);
          }
          for (const [p] of [...fs.entries()]) {
            if (p === old || p.startsWith(old + '/')) fs.delete(p);
          }
          resolve({ old_path: old, new_path: target } as T);
          return;
        }
        case 'delete_node': {
          const p = safePath(args.path as string);
          if (p === root) throw new Error('cannot delete vault root');
          for (const key of [...fs.keys()]) {
            if (key === p || key.startsWith(p + '/')) fs.delete(key);
          }
          resolve(undefined as T);
          return;
        }
        case 'save_asset': {
          mkdirp(root + '/.assets');
          const ext = String(args.ext ?? 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8);
          const id = `${uniqueId()}.${ext}`;
          // 存 data URL，mock 的 convertFileSrc 直接返回（可被 <img> 真实渲染）
          const bytes = (args.data as number[]) ?? [];
          let binary = '';
          for (const b of bytes) binary += String.fromCharCode(b);
          const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
          fs.set(`${root}/.assets/${id}`, { type: 'file', content: `data:image/${mime};base64,` + btoa(binary) });
          resolve(id as T);
          return;
        }
        case 'open_path': {
          const p = args.path as string;
          let target = p;
          let select: string | null = null;
          if (fs.has(p) && fs.get(p)!.type === 'dir') {
            target = p;
          } else if (fs.has(p)) {
            const ext = base(p).split('.').pop()?.toLowerCase();
            if (ext !== 'md' && ext !== 'markdown') throw new Error('只支持打开 Markdown（.md）文件');
            target = sep(p);
            select = p;
          } else {
            throw new Error('路径不存在');
          }
          root = target;
          mkdirp(root);
          mkdirp(root + '/.assets');
          resolve({ root, select_path: select } as T);
          return;
        }
        case 'search_all': {
          const q = String(args.query ?? '').trim().toLowerCase();
          if (!q) { resolve([] as T); return; }
          const hits = [];
          for (const [path, e] of fs.entries()) {
            if (e.type !== 'file' || !path.endsWith('.md')) continue;
            if (base(path).startsWith('.')) continue;
            for (const [i, line] of (e.content ?? '').split('\n').entries()) {
              if (line.toLowerCase().includes(q)) {
                hits.push({ path, title: base(path).replace(/\.md$/i, ''), line_no: i + 1, line_text: line.trim().slice(0, 80) });
              }
            }
          }
          resolve(hits as T);
          return;
        }
        case 'list_versions': {
          const list = history.get(args.path as string) ?? [];
          resolve(list.map((v) => ({ ...v.meta })) as T);
          return;
        }
        case 'read_version_diff': {
          const list = history.get(args.path as string) ?? [];
          const v = list.find((x) => x.meta.seq === args.seq);
          resolve((v?.diff ?? []) as T);
          return;
        }
        case 'read_version': {
          const list = history.get(args.path as string) ?? [];
          const v = list.find((x) => x.meta.seq === args.seq);
          if (!v) throw new Error('version not found');
          resolve(v.full as T);
          return;
        }
        case 'restore_version': {
          const p = safePath(args.path as string);
          const list = history.get(p) ?? [];
          const v = list.find((x) => x.meta.seq === args.seq);
          if (!v) throw new Error('version not found');
          // 恢复前把当前内容入历史（同 write_doc 的模拟逻辑）
          const cur = fs.get(p)?.content ?? '';
          const curLines = cur.split('\n');
          const vLines = v.full.split('\n');
          list.push({
            meta: { seq: list[list.length - 1].meta.seq + 1, time_ms: Date.now(), is_full: false,
              added: vLines.filter((l) => !curLines.includes(l)).length,
              removed: curLines.filter((l) => !vLines.includes(l)).length },
            full: v.full,
            diff: [
              ...vLines.filter((l) => !curLines.includes(l)).map((text) => ({ kind: 'add', text })),
              ...curLines.filter((l) => !vLines.includes(l)).map((text) => ({ kind: 'del', text })),
            ],
          });
          fs.set(p, { type: 'file', content: v.full });
          resolve(v.full as T);
          return;
        }
        default:
          reject(new Error(`mock 未实现命令: ${cmd}`));
      }
    } catch (e) {
      reject(e);
    }
  });
}

// ---- @tauri-apps/api/core mock ----
export const invoke = invokeMock;
export function convertFileSrc(path: string): string {
  const content = fs.get(path)?.content;
  if (typeof content === 'string' && content.startsWith('data:')) return content;
  return 'mock-asset://' + encodeURIComponent(path);
}

// ---- @tauri-apps/api/window mock ----
export function getCurrentWindow() {
  return {
    onCloseRequested: async () => () => {},
    destroy: async () => {},
  };
}

// ---- @tauri-apps/api/event mock（fs-change 用于测试外部文件变化） ----
const fsChangeHandlers: Array<(payload: string[]) => void> = [];
export async function listen(event: string, handler: (e: { payload: string[] }) => void): Promise<() => void> {
  if (event === 'fs-change') {
    const fn = (payload: string[]) => handler({ payload });
    fsChangeHandlers.push(fn);
    return () => {
      const i = fsChangeHandlers.indexOf(fn);
      if (i >= 0) fsChangeHandlers.splice(i, 1);
    };
  }
  return () => {};
}

// ---- @tauri-apps/plugin-dialog mock：路径由测试注入 ----
declare global {
  interface Window {
    __MOCK_PICK__?: string | null;
  }
}
export async function open(): Promise<string | null> {
  return window.__MOCK_PICK__ ?? null;
}

// ---- 测试辅助：检查/操作内存文件系统 ----
declare global {
  interface Window {
    __mockFs?: {
      dump: () => Record<string, string>;
      readFile: (path: string) => string | undefined;
      root: () => string;
      seedDir: (path: string) => void;
      seedFile: (path: string, content: string) => void;
    };
  }
}
declare global {
  interface Window {
    __mockEmitFsChange?: (paths: string[]) => void;
  }
}
if (typeof window !== 'undefined') {
  window.__mockEmitFsChange = (paths) => fsChangeHandlers.forEach((fn) => fn(paths));
  window.__mockFs = {
    dump: () => Object.fromEntries([...fs.entries()].map(([p, e]) => [p, e.type === 'file' ? (e.content ?? '') : '<dir>'])),
    readFile: (path) => fs.get(path)?.content,
    root: () => root,
    seedDir: mkdirp,
    seedFile: (path, content) => {
      mkdirp(sep(path));
      fs.set(path, { type: 'file', content });
    },
  };
}

// 保留类型引用避免 TS 报 unused
export type _KeepDoc = DecryptedDoc;
