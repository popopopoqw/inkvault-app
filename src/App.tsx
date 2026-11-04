import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@uiw/react-codemirror';
import { useStore } from './store/app';
import { AuthScreen } from './components/AuthScreen';
import { FileTree } from './components/FileTree';
import { EditorPane } from './components/EditorPane';
import { Preview, TocPanel } from './components/Preview';
import { extractHeadings } from './lib/markdown';
import { Logo, IconEye, IconLogout } from './components/Icons';

type ViewMode = 'edit' | 'preview';

const SAVE_LABEL: Record<string, string> = {
  saving: '保存中…',
  saved: '✓ 已保存',
  error: '⚠ 保存失败',
  conflict: '⟳ 已同步最新',
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
        <p>{bootError ?? '加载中…'}</p>
        {bootError && <button onClick={() => void useStore.getState().boot()}>重试</button>}
      </div>
    );
  }
  if (phase === 'setup' || phase === 'login') return <AuthScreen mode={phase} />;
  return <Workspace />;
}

function Workspace() {
  const docs = useStore((s) => s.docs);
  const activeId = useStore((s) => s.activeId);
  const saveState = useStore((s) => s.saveState);
  const toast = useStore((s) => s.toast);
  const logout = useStore((s) => s.logout);

  const activeDoc = activeId ? docs[activeId] : undefined;
  const [viewMode, setViewMode] = useState<ViewMode>('edit');
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

  // 离开页面前把未保存内容落库
  useEffect(() => {
    const flush = () => void useStore.getState().flush();
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  return (
    <div className="workspace">
      <header className="topbar">
        <span className="app-brand">
          <Logo size={26} />
          <span className="app-name">墨匣</span>
        </span>
        {activeDoc && !activeDoc.isFolder && (
          <span className="doc-title" title={activeDoc.title}>
            {activeDoc.title || '无标题'}
          </span>
        )}
        <span className={`save-state ${saveState}`}>{SAVE_LABEL[saveState] ?? ''}</span>
        <div className="topbar-right">
          <button
            className={`icon-toggle${viewMode === 'preview' ? ' on' : ''}`}
            title={viewMode === 'preview' ? '返回编辑' : '预览'}
            onClick={() => setViewMode(viewMode === 'preview' ? 'edit' : 'preview')}
          >
            <IconEye />
            <span>{viewMode === 'preview' ? '编辑' : '预览'}</span>
          </button>
          <button className="icon-toggle" title="登出" onClick={() => void logout()}>
            <IconLogout />
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
    </div>
  );
}
