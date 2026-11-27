import { useEffect, useRef, useState } from 'react';
import { searchAll } from '../lib/desktop';
import type { SearchHit } from '../lib/desktop';
import { useStore } from '../store/app';
import type { DecryptedDoc } from '../lib/types';

/** 高亮行内匹配片段（转义后按字符拼接，避免注入） */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/** 在单篇文档内本地搜索（与全库结果同构，便于复用跳转） */
function searchInDoc(doc: DecryptedDoc, q: string): SearchHit[] {
  const needle = q.toLowerCase();
  const out: SearchHit[] = [];
  const lines = doc.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) {
      out.push({
        path: doc.id,
        title: doc.title,
        line_no: i + 1,
        line_text: lines[i].trim().slice(0, 80),
      });
    }
  }
  return out;
}

/** 全库搜索：跨所有文档搜内容，点击结果跳到对应文档与行 */
export function SearchPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'doc' | 'all'>('doc'); // 默认搜当前文档
  const activeDoc = useStore((s) => (s.activeId ? s.docs[s.activeId] : undefined));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    if (scope === 'doc') {
      // 当前文档：本地逐行匹配（无网络请求，即时）
      if (!activeDoc || activeDoc.isFolder) {
        setHits(null);
        return;
      }
      setHits(searchInDoc(activeDoc, q));
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      void searchAll(q)
        .then(setHits)
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, scope, activeDoc]);

  // 按文档分组统计
  const grouped = new Map<string, SearchHit[]>();
  for (const h of hits ?? []) {
    const list = grouped.get(h.path) ?? [];
    list.push(h);
    grouped.set(h.path, list);
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-head">
          <div className="search-scope" role="tablist">
            <button
              className={scope === 'doc' ? 'on' : ''}
              onClick={() => setScope('doc')}
              disabled={!activeDoc || activeDoc.isFolder}
              title={activeDoc && !activeDoc.isFolder ? `搜索「${activeDoc.title}」` : '未打开文档'}
            >
              当前文档
            </button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')} title="搜索全部文档内容">
              全部文档
            </button>
          </div>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder={scope === 'doc' ? '在当前文档中搜索…' : '搜索全部文档内容…'}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <span className="search-count">
            {busy ? '搜索中…' : hits ? `${hits.length} 处匹配${scope === 'all' ? ` / ${grouped.size} 个文档` : ''}` : ''}
          </span>
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="search-results">
          {hits === null ? (
            <p className="toc-empty">输入关键词搜索{scope === 'doc' ? '当前文档' : '全部笔记'}</p>
          ) : hits.length === 0 ? (
            <p className="toc-empty">没有匹配结果</p>
          ) : (
            [...grouped.entries()].map(([path, list]) => (
              <div key={path} className="search-group">
                <div className="sg-title">
                  {list[0].title} <span className="sg-count">{list.length}</span>
                </div>
                {list.slice(0, 20).map((h) => (
                  <div
                    key={`${h.line_no}-${h.line_text}`}
                    className="search-hit"
                    onClick={() => {
                      useStore.getState().openSearchHit(h.path, h.line_no);
                      onClose();
                    }}
                  >
                    <span className="sh-line">{h.line_no}</span>
                    <span className="sh-text">
                      <Highlight text={h.line_text} query={query.trim()} />
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
