import { EditorView } from '@uiw/react-codemirror';
import { desktopAssetUrl, desktopSaveAsset } from './desktop';
import { fromBase64, toBase64 } from './base64';
import { useStore } from '../store/app';

/**
 * 图片附件：粘贴/拖拽/工具栏插入 → 客户端压缩 → 写入本地 .assets/ 文件夹。
 * markdown 以 ![alt](asset:<id>) 引用，渲染时经 asset 协议直接读本地文件。
 */

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;
const MAX_RAW_BYTES = 8 * 1024 * 1024; // 原图上限 8MB

interface CompressedImage {
  mime: string;
  data: string; // base64 原始字节
}

export async function compressImage(file: File): Promise<CompressedImage> {
  if (file.size > MAX_RAW_BYTES) throw new Error('图片超过 8MB');

  // SVG / GIF 保留原样（避免破坏矢量与动画），小体积直存
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    return { mime: file.type, data };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法处理图片');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('压缩失败');
  return { mime: 'image/jpeg', data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
}

// asset id → asset:// URL（本地文件）
const urlCache = new Map<string, string>();

export async function resolveAssetUrl(id: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('bad id');
  const cached = urlCache.get(id);
  if (cached) return cached;
  const url = await desktopAssetUrl(id);
  urlCache.set(id, url);
  return url;
}

// 处理并插入图片到编辑器（工具栏 / 粘贴 / 拖拽共用）
export async function insertImageFile(view: EditorView, file: File): Promise<void> {
  const store = useStore.getState();
  store.showToast('图片处理中…');
  try {
    const payload = await compressImage(file);
    const ext = payload.mime.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';
    const assetId = await desktopSaveAsset(fromBase64(payload.data), ext);
    const name = (file.name || '图片').replace(/\.[^.]*$/, '').slice(0, 40) || '图片';
    const insert = `\n\n![${name}](asset:${assetId})\n\n`;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert },
      selection: { anchor: pos + insert.length },
    });
    view.focus();
    store.showToast('图片已插入');
  } catch (e) {
    const msg = (e as Error).message?.includes('8MB') ? '图片超过 8MB，已跳过' : '图片插入失败（格式不支持或写入失败）';
    useStore.getState().showToast(msg);
  }
}

export function findImageFile(source: DataTransfer | null): File | null {
  if (!source) return null;
  if (source.files?.length) {
    const file = Array.from(source.files).find((f) => f.type.startsWith('image/'));
    if (file) return file;
  }
  for (const item of Array.from(source.items ?? [])) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}
