import { EditorView } from '@uiw/react-codemirror';
import { api } from './api';
import { currentKey, decryptValue, encryptValue, fromBase64, randomHex, toBase64 } from './crypto';
import { useStore } from '../store/app';

/**
 * 图片附件：客户端压缩 → 加密上传 D1 → markdown 以 `![alt](asset:<id>)` 引用。
 * 加载时按需拉取密文、解密成 blob URL（带缓存）。
 */

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;
const MAX_RAW_BYTES = 8 * 1024 * 1024; // 原图上限 8MB

interface AssetPayload {
  mime: string;
  data: string; // base64 原始字节
}

export async function compressImage(file: File): Promise<AssetPayload> {
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

export async function uploadAsset(payload: AssetPayload): Promise<string> {
  const key = currentKey();
  if (!key) throw new Error('未解锁');
  const id = randomHex(16);
  const { cipher, nonce } = await encryptValue(key, payload);
  await api(`/assets/${id}`, { method: 'PUT', body: { cipher, nonce } });
  return id;
}

// asset id → blob URL 缓存（同一图片多处引用只解密一次）
const urlCache = new Map<string, string>();

export async function resolveAssetUrl(id: string): Promise<string> {
  if (!/^[a-f0-9]{1,64}$/.test(id)) throw new Error('bad id');
  const cached = urlCache.get(id);
  if (cached) return cached;
  const key = currentKey();
  if (!key) throw new Error('未解锁');
  const { cipher, nonce } = await api<{ cipher: string; nonce: string }>(`/assets/${id}`);
  const payload = await decryptValue<AssetPayload>(key, cipher, nonce);
  const blob = new Blob([fromBase64(payload.data)], { type: payload.mime });
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

// 处理并插入图片到编辑器（工具栏 / 粘贴 / 拖拽共用）
export async function insertImageFile(view: EditorView, file: File): Promise<void> {
  const store = useStore.getState();
  store.showToast('图片处理中…');
  try {
    const payload = await compressImage(file);
    const id = await uploadAsset(payload);
    const name = (file.name || '图片').replace(/\.[^.]*$/, '').slice(0, 40) || '图片';
    const insert = `\n\n![${name}](asset:${id})\n\n`;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert },
      selection: { anchor: pos + insert.length },
    });
    view.focus();
    store.showToast('图片已插入');
  } catch (e) {
    const msg = (e as Error).message?.includes('8MB') ? '图片超过 8MB，已跳过' : '图片插入失败（格式不支持或网络错误）';
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
