import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@uiw/react-codemirror';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useStore } from './store/app';
import { FileTree } from './components/FileTree';
import { EditorPane } from './components/EditorPane';
import { Preview, TocPanel } from './components/Preview';
import { extractHeadings } from './lib/markdown';
import { Logo, IconEye, IconHistory } from './components/Icons';
import { HistoryPanel } from './components/HistoryPanel';

type ViewMode = 'edit' | 'preview';

const SAVE_LABEL: Record<string, string> = {
  saving: '保存中…',
  saved: '✓ 已保存',
  error: '⚠ 保存失败',
};

export default function App() {
  const phase = useStore((s) => s.phase);
  const bootError = useStore((s) => s.bootError);

  useEffect(() => {
    void useStore.getState().boot();
  }, []);

  if (phase === 'boot') {
    return (
      <div className="screen-center">
        <Logo size={48} />
        <p>{bootError ?? '加载中…'}</p>
        {bootError && <button onClick={() => void useStore.getState().boot()}>重试</button>}
      </div>
    );
  }
  return <Workspace />;
}

function Workspace() {
  const docs = useStore((s) => s.docs);
  const activeId = useStore((s) => s.activeId);
  const saveState = useStore((s) => s.saveState);
  const toast = useStore((s) => s.toast);

  const activeDoc = activeId ? docs[activeId] : undefined;
  const [viewMode, setViewMode] = useState<ViewMode>('edit');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const headings = useMemo(() => (activeDoc && !activeDoc.isFolder ? extractHeadings(activeDoc.content) : []), [activeDoc]);
  const [activeHeading, setActiveHeading] = useState(0);
  const [editorScrollEl, setEditorScrollEl] = useState<HTMLElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);

  const handleEditorReady = useCallback((view: EditorView) => {
    editorViewRef.current = view;
    setEditorScrollEl(view.scrollDOM);
  }, []);

  const handlePreviewHeading = useCallback((index: number) => setActiveHeading(index), []);

  // 大纲跳转：编辑模式定位到源码行；预览模式滚动到对应标题
  const jumpTo = useCallback(
    (index: number) => {
      const h = headings[index];
      if (!h) return;
      if (viewMode === 'preview') {
        const container = previewScrollRef.current;
        if (!container) return;
        const els = Array.from(container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'));
        els[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const view = editorViewRef.current;
      if (!view) return;
      const pos = view.state.doc.line(h.line + 1).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 60 }) });
    },
    [viewMode, headings]
  );

  // 编辑模式：随编辑区滚动高亮当前标题
  useEffect(() => {
    if (viewMode === 'preview') return;
    const view = editorViewRef.current;
    const el = editorScrollEl;
    if (!view || !el || headings.length === 0) return;
    let raf = 0;
    const recompute = () => {
      raf = requestAnimationFrame(() => {
        const scrollTop = el.scrollTop;
        let active = 0;
        for (let i = 0; i < headings.length; i++) {
          const lineNo = Math.min(headings[i].line + 1, view.state.doc.lines);
          const pos = view.state.doc.line(lineNo).from;
          if (view.lineBlockAt(pos).top - scrollTop <= 60) active = i;
        }
        setActiveHeading(active);
      });
    };
    el.addEventListener('scroll', recompute, { passive: true });
    recompute();
    return () => {
      el.removeEventListener('scroll', recompute);
      cancelAnimationFrame(raf);
    };
  }, [editorScrollEl, headings, viewMode, activeId]);

  // 离开页面前把未保存内容落盘
  useEffect(() => {
    const flush = () => void useStore.getState().flush();
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  // Tauri 关窗钩子：beforeunload 的异步写盘来不及完成，必须拦截关闭、写完再关。
  // destroy 需要在 capabilities 授权 core:window:allow-destroy；失败时兜底 close 放行。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let closing = false;
    const win = getCurrentWindow();
    void win
      .onCloseRequested(async (event) => {
        if (closing) return; // 兜底 close 触发的第二次请求：直接放行关闭
        closing = true;
        event.preventDefault();
        try {
          await useStore.getState().flush();
        } catch {
          /* 写盘失败也允许关闭，避免窗口永远关不掉 */
        }
        try {
          await win.destroy();
        } catch {
          await win.close();
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="workspace">
      <header className="topbar">
        <span className="app-brand">
          <Logo size={26} />
          <span className="app-name">墨匣</span>
        </span>
        {activeDoc && !activeDoc.isFolder && (
          editingTitle ? (
            <input
              className="doc-title-input"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => {
                setEditingTitle(false);
                const name = titleDraft.trim();
                if (name && name !== activeDoc.title) void useStore.getState().renameNode(activeDoc.id, name);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  setTitleDraft(activeDoc.title);
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <span
              className="doc-title editable"
              title="点击重命名"
              onClick={() => {
                setTitleDraft(activeDoc.title);
                setEditingTitle(true);
              }}
            >
              {activeDoc.title || '无标题'}
            </span>
          )
        )}
        <span className={`save-state ${saveState}`}>{SAVE_LABEL[saveState] ?? ''}</span>
        <div className="topbar-right">
          {activeDoc && !activeDoc.isFolder && (
            <button
              className="icon-toggle"
              title="文档历史"
              onClick={() => setShowHistory(true)}
            >
              <IconHistory />
              <span>文档历史</span>
            </button>
          )}
          <button
            className={`icon-toggle${viewMode === 'preview' ? ' on' : ''}`}
            title={viewMode === 'preview' ? '返回编辑' : '预览'}
            onClick={() => setViewMode(viewMode === 'preview' ? 'edit' : 'preview')}
          >
            <IconEye />
            <span>{viewMode === 'preview' ? '编辑' : '预览'}</span>
          </button>
        </div>
      </header>

      <div className="main-area">
        <FileTree />
        <section className={`editor-area mode-${viewMode}`}>
          {activeDoc && !activeDoc.isFolder ? (
            <>
              {viewMode === 'edit' && <EditorPane docId={activeDoc.id} content={activeDoc.content} onReady={handleEditorReady} />}
              {viewMode === 'preview' && (
                <Preview content={activeDoc.content} scrollRef={previewScrollRef} onHeadingIndexChange={handlePreviewHeading} />
              )}
            </>
          ) : (
            <div className="empty-state">
              <Logo size={56} />
              <p>从左侧选择一篇文档，或新建一篇开始写作</p>
            </div>
          )}
        </section>
        {activeDoc && !activeDoc.isFolder && <TocPanel headings={headings} activeIndex={activeHeading} onJump={jumpTo} />}
      </div>

      {toast && (
        <div className="toast" onClick={() => useStore.getState().dismissToast()}>
          {toast}
        </div>
      )}

      {showHistory && activeDoc && !activeDoc.isFolder && (
        <HistoryPanel docId={activeDoc.id} onClose={() => setShowHistory(false)} />
      )}
    </div>
  );
}
