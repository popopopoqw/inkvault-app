import { useEffect, useState } from 'react';
import { useStore } from '../store/app';

/** 双击图片打开的全屏查看器：滚轮缩放，Esc / 点击背景关闭，双击复位 */
export function ImageViewer() {
  const src = useStore((s) => s.imageViewer);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    setScale(1);
  }, [src]);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().closeImageViewer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src]);

  if (!src) return null;
  return (
    <div
      className="image-viewer"
      onClick={() => useStore.getState().closeImageViewer()}
      onWheel={(e) => {
        e.preventDefault();
        setScale((s) => Math.min(6, Math.max(0.2, s * (e.deltaY < 0 ? 1.15 : 0.87))));
      }}
    >
      <img
        src={src}
        alt=""
        style={{ transform: `scale(${scale})` }}
        onClick={(e) => {
          // 双击在适应大小（1x）与放大（2.5x）之间切换
          if (e.detail >= 2) setScale((v) => (v === 1 ? 2.5 : 1));
          e.stopPropagation();
        }}
      />
      <span className="iv-tip">双击放大/缩小 · 滚轮自由缩放 · Esc 关闭</span>
    </div>
  );
}
