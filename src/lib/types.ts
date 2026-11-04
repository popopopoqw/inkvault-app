// 桌面版文档模型：id 即文件绝对路径，title 即文件名（去 .md）
export interface DecryptedDoc {
  id: string;
  parentId: string | null;
  isFolder: boolean;
  title: string;
  content: string;
}

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}
