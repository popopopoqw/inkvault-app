import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { DecryptedDoc } from './types';

/**
 * 桌面端（Tauri）本地文件后端：文档是 ~/墨匣 下的 .md 文件，
 * 文件树即目录结构，图片在 .assets/ 下。无网络请求。
 * doc.id 就是文件绝对路径。
 */

interface FsNode {
  path: string;
  name: string;
  is_folder: boolean;
}

interface PathChange {
  old_path: string;
  new_path: string;
}

let rootCache: string | null = null;

export async function desktopRoot(): Promise<string> {
  if (!rootCache) rootCache = await invoke<string>('vault_root_path');
  return rootCache;
}

function parentOf(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  const idx = path.lastIndexOf(sep);
  return idx > 0 ? path.slice(0, idx) : path;
}

function baseName(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  return path.slice(path.lastIndexOf(sep) + 1);
}

export function isMdTitle(path: string): string {
  return baseName(path).replace(/\.md$/i, '');
}

export async function desktopListDocs(): Promise<Record<string, DecryptedDoc>> {
  const [nodes, root] = await Promise.all([invoke<FsNode[]>('list_tree'), desktopRoot()]);
  const docs: Record<string, DecryptedDoc> = {};
  for (const n of nodes) {
    const content = n.is_folder ? '' : await invoke<string>('read_doc', { path: n.path });
    docs[n.path] = {
      id: n.path,
      parentId: parentOf(n.path) === root ? null : parentOf(n.path),
      isFolder: n.is_folder,
      title: n.is_folder ? baseName(n.path) : isMdTitle(n.path),
      content,
    };
  }
  return docs;
}

export async function desktopCreateNode(parentId: string | null, isFolder: boolean): Promise<DecryptedDoc> {
  const node = await invoke<FsNode>('create_node', {
    parent: parentId,
    name: isFolder ? '新文件夹' : '无标题',
    isFolder,
  });
  return {
    id: node.path,
    parentId: parentOf(node.path),
    isFolder: node.is_folder,
    title: node.is_folder ? baseName(node.path) : isMdTitle(node.path),
    content: '',
  };
}

export async function desktopWriteDoc(path: string, content: string): Promise<void> {
  await invoke('write_doc', { path, content });
}

export async function desktopRename(id: string, newName: string): Promise<PathChange> {
  return invoke<PathChange>('rename_node', { path: id, newName });
}

export async function desktopMove(id: string, newParent: string | null): Promise<PathChange> {
  return invoke<PathChange>('move_node', { path: id, newParent });
}

export async function desktopDelete(id: string): Promise<void> {
  await invoke('delete_node', { path: id });
}

// 图片：写入 .assets/<id>.<ext>，返回 asset 引用 id
export async function desktopSaveAsset(data: Uint8Array, ext: string): Promise<string> {
  return invoke<string>('save_asset', { ext, data: Array.from(data) });
}

export async function desktopAssetUrl(id: string): Promise<string> {
  if (!/^[a-f0-9]{6,64}\.[a-z0-9]{1,8}$/i.test(id)) throw new Error('bad asset id');
  const root = await desktopRoot();
  const sep = root.includes('\\') ? '\\' : '/';
  return convertFileSrc(`${root}${sep}.assets${sep}${id}`);
}
