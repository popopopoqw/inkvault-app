import { useEffect } from 'react';

/** 自绘确认对话框：Tauri WebView 原生 window.confirm 不可用，统一用它替代 */
export function ConfirmDialog({
  message,
  confirmText = '删除',
  danger = true,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-message">{message}</p>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            取消
          </button>
          <button className={danger ? 'danger-btn' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
