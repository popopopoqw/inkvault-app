import { useEffect, useRef } from 'react';

const TEXT_COLORS = ['#dc2626', '#ea580c', '#d97706', '#16a34a', '#2563eb', '#7c3aed', '#6b7280', '#111827'];
const BG_COLORS = ['#fef08a', '#bbf7d0', '#fecaca', '#bfdbfe', '#fbcfe8', '#a5f3fc'];

/** 文字颜色 / 背景色色板（工具栏弹出） */
export function ColorPicker({
  kind,
  onPick,
  onClose,
}: {
  kind: 'color' | 'background-color';
  onPick: (hex: string | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const colors = kind === 'color' ? TEXT_COLORS : BG_COLORS;
  const label = kind === 'color' ? '文字颜色' : '背景颜色';

  return (
    <div className="color-picker" ref={ref}>
      <div className="cp-title">{label}</div>
      <div className="cp-grid">
        {colors.map((c) => (
          <button
            key={c}
            title={c}
            className="cp-swatch"
            style={kind === 'color' ? { color: c, background: '#f4f4f8' } : { background: c }}
            onClick={() => onPick(c)}
          >
            A
          </button>
        ))}
      </div>
      <button className="cp-clear" onClick={() => onPick(null)}>
        清除颜色
      </button>
    </div>
  );
}
