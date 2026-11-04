import { useDeferredValue, useEffect, useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown';
import { resolveAssetUrl } from '../lib/assets';
import type { HeadingInfo } from '../lib/markdown';

export function Preview({
  content,
  scrollRef,
  onHeadingIndexChange,
}: {
  content: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onHeadingIndexChange: (index: number) => void;
}) {
  // 大文档输入时让编辑保持流畅：渲染可以晚一拍
  const deferred = useDeferredValue(content);
  const result = useMemo(() => renderMarkdown(deferred), [deferred]);

  // 附件图片：渲染挂载后在真实 DOM 上把 asset:<id> 换成解密后的 blob URL
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLImageElement>('img[src^="asset:"]').forEach((img) => {
      const id = (img.getAttribute('src') ?? '').slice('asset:'.length);
      if (!/^[a-f0-9]{1,64}$/.test(id)) return;
      void resolveAssetUrl(id)
        .then((url) => {
          img.src = url;
        })
        .catch(() => {
          img.alt = `${img.alt || '图片'}（加载失败）`;
        });
    });
  }, [result.html, scrollRef]);

  // 纯预览模式下，随滚动高亮当前所在标题（按索引与源码大纲对齐）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const recompute = () => {
      raf = requestAnimationFrame(() => {
        const headings = Array.from(el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'));
        let active = 0;
        for (let i = 0; i < headings.length; i++) {
          if (headings[i].offsetTop - el.scrollTop <= 80) active = i;
        }
        onHeadingIndexChange(active);
      });
    };
    el.addEventListener('scroll', recompute, { passive: true });
    recompute();
    return () => {
      el.removeEventListener('scroll', recompute);
      cancelAnimationFrame(raf);
    };
  }, [scrollRef, onHeadingIndexChange, result.html]);

  return (
    <div className="preview-scroll" ref={scrollRef as React.Ref<HTMLDivElement>}>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: result.html }} />
    </div>
  );
}

export function TocPanel({
  headings,
  activeIndex,
  onJump,
}: {
  headings: HeadingInfo[];
  activeIndex: number;
  onJump: (index: number) => void;
}) {
  return (
    <aside className="toc-panel">
      <div className="toc-title">大纲</div>
      <div className="toc-list">
        {headings.length === 0 ? (
          <p className="toc-empty">暂无标题</p>
        ) : (
          headings.map((t, i) => (
            <div
              key={`${t.line}-${t.text}`}
              className={`toc-item toc-level-${t.level}${i === activeIndex ? ' active' : ''}`}
              title={t.text}
              onClick={() => onJump(i)}
            >
              {t.text || '无标题'}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
