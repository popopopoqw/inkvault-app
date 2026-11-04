// 文档元数据（客户端视角）；cipher/nonce 仅在传输与服务端存储时存在
export interface DocMeta {
  id: string;
  parentId: string | null;
  isFolder: boolean;
  sortKey: number;
  version: number;
  updatedAt?: string;
}

export interface EncryptedDoc extends DocMeta {
  cipher: string;
  nonce: string;
}

export interface DecryptedDoc extends DocMeta {
  title: string;
  content: string;
}

// AES-GCM 加密的明文载荷
export interface DocPayload {
  title: string;
  content: string;
}

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}
