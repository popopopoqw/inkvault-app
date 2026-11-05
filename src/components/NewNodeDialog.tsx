import { useEffect, useMemo, useState } from 'react';
import { childrenOf } from '../store/app';
import type { DecryptedDoc } from '../lib/types';

// 新建文档/文件夹：指定名称与目标目录
export function NewNodeDialog({
  docs,
  isFolder,
  defaultParent,
  onClose,
  onSubmit,
}: {
  docs: Record<string, DecryptedDoc>;
  isFolder: boolean;
  defaultParent: string | null;
  onClose: () => void;
  onSubmit: (parentId: string | null, name: string) => void;
}) {
  const [name, setName] = useState(isFolder ? '新文件夹' : '无标题');
  const [parentId, setParentId] = useState<string>(defaultParent ?? '');

  const options = useMemo(() => {
    const walk = (pid: string | null, prefix: string): { id: string; label: string }[] => {
      const out: { id: string; label: string }[] = [];
      for (const f of childrenOf(docs, pid)) {
        if (!f.isFolder) continue;
        const label = prefix ? `${prefix} / ${f.title}` : f.title;
        out.push({ id: f.id, label });
        out.push(...walk(f.id, label));
      }
      return out;
    };
    return walk(null, '');
  }, [docs]);

  const trimmed = name.trim();
  const invalid = !trimmed || trimmed.length > 100 || /[\/\\:]/.test(trimmed) || trimmed.startsWith('.');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit() {
    if (invalid) return;
    onSubmit(parentId || null, trimmed);
    onClose();
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
        <h2>{isFolder ? '新建文件夹' : '新建文档'}</h2>
        <label className="auth-field">
          <span>名称</span>
          <input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </label>
        <label className="auth-field">
          <span>创建位置</span>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">顶层（{isFolder ? '墨匣' : '~/墨匣'}）</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {invalid && name.length > 0 && <p className="auth-hint error">名称不能包含 / \\ : 或以 . 开头</p>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={invalid} onClick={submit}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
