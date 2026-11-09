import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import CodeMirror, { EditorSelection, EditorView, Prec, drawSelection, keymap } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { Table } from '@lezer/markdown';
import { languages } from '@codemirror/language-data';
import { livePreview, lineHasDecoration, posFromClick, resolveVisiblePos } from '../lib/livePreview';
import { findImageFile, insertImageFile } from '../lib/assets';
import { useStore, useStoreReveal } from '../store/app';
import { IconLink, IconQuote, IconList, IconTask, IconTable, IconCode, IconCodeInline, IconImage, IconClock } from './Icons';
import { ColorPicker } from './ColorPicker';

function wrapSelection(view: EditorView, before: string, after: string) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const wrapped = text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length;
      const insert = wrapped ? text.slice(before.length, text.length - after.length) : before + text + after;
      let sel: ReturnType<typeof EditorSelection.range>;
      if (wrapped) {
        sel = EditorSelection.range(range.from, range.from + insert.length);
      } else if (range.empty) {
        sel = EditorSelection.cursor(range.from + before.length);
      } else {
        sel = EditorSelection.range(range.from + before.length, range.from + before.length + text.length);
      }
      return { changes: { from: range.from, to: range.to, insert }, range: sel };
    })
  );
  view.focus();
}

function toggleLinePrefix(view: EditorView, prefix: string) {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const { from, to } of state.selection.ranges) {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      const isHeading = prefix.startsWith('#');
      const headingMatch = /^#{1,6}\s+/.exec(line.text);
      if (isHeading && headingMatch) {
        // 标题之间互相切换 / 再点同级则取消
        changes.push({ from: line.from, to: line.from + headingMatch[0].length, insert: headingMatch[0] === prefix ? '' : prefix });
      } else if (!isHeading && line.text.startsWith(prefix)) {
        changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
      } else {
        changes.push({ from: line.from, to: line.from, insert: prefix });
      }
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

function insertBlock(view: EditorView, text: string) {
  const { state } = view;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.from);
  const prefix = line.text.trim() === '' ? '' : '\n\n';
  const insert = prefix + text;
  view.dispatch({
    changes: { from: main.from, to: main.to, insert },
    selection: { anchor: main.from + insert.length },
  });
  view.focus();
}

const TABLE_SNIPPET = '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';

// 对选区应用文字/背景颜色（生成受白名单保护的 <span style>；null 清除）
function applyColor(view: EditorView, kind: 'color' | 'background-color', hex: string | null) {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  let text = view.state.sliceDoc(sel.from, sel.to);
  text = text.replace(/<\/?(?:span|mark)[^>]*>/gi, '');
  if (hex !== null) {
    text = `<span style="${kind}: ${hex}">${text}</span>`;
  }
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from, head: sel.from + text.length },
  });
  view.focus();
}

// Cmd/Ctrl+Shift+H：切换背景高亮（默认黄；已高亮则清除）
function toggleHighlight(view: EditorView) {
  const sel = view.state.selection.main;
  const text = view.state.sliceDoc(sel.from, sel.to);
  if (/<span style="background-color:[^>]*>/i.test(text)) {
    applyColor(view, 'background-color', null);
  } else {
    applyColor(view, 'background-color', '#fef08a');
  }
}

// 在光标处插入当前日期时间（YYYY-MM-DD HH:mm）
function insertTimestamp(view: EditorView) {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const text = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
  view.focus();
}
const CODE_SNIPPET = '```ts\n\n```';

interface Tool {
  label: string;
  title: string;
  icon?: ReactNode;
  run: (view: EditorView) => void;
}

const TOOLS: Tool[] = [
  { label: 'H1', title: '一级标题 (Cmd/Ctrl+Shift+1)', run: (v) => toggleLinePrefix(v, '# ') },
  { label: 'H2', title: '二级标题 (Cmd/Ctrl+Shift+2)', run: (v) => toggleLinePrefix(v, '## ') },
  { label: 'H3', title: '三级标题 (Cmd/Ctrl+Shift+3)', run: (v) => toggleLinePrefix(v, '### ') },
  { label: 'B', title: '粗体 (Cmd/Ctrl+B)', run: (v) => wrapSelection(v, '**', '**') },
  { label: 'I', title: '斜体 (Cmd/Ctrl+I)', run: (v) => wrapSelection(v, '*', '*') },
  { label: '', title: '行内代码 (Cmd/Ctrl+E)', icon: <IconCodeInline />, run: (v) => wrapSelection(v, '`', '`') },
  { label: '', title: '链接 (Cmd/Ctrl+K)', icon: <IconLink />, run: (v) => wrapSelection(v, '[', '](https://)') },
  { label: '', title: '引用', icon: <IconQuote />, run: (v) => toggleLinePrefix(v, '> ') },
  { label: '', title: '无序列表 (Cmd/Ctrl+Shift+8)', icon: <IconList />, run: (v) => toggleLinePrefix(v, '- ') },
  { label: '1.', title: '有序列表 (Cmd/Ctrl+Shift+7)', run: (v) => toggleLinePrefix(v, '1. ') },
  { label: '', title: '任务列表 (Cmd/Ctrl+Shift+9)', icon: <IconTask />, run: (v) => toggleLinePrefix(v, '- [ ] ') },
  { label: '', title: '表格', icon: <IconTable />, run: (v) => insertBlock(v, TABLE_SNIPPET) },
  { label: '', title: '代码块', icon: <IconCode />, run: (v) => insertBlock(v, CODE_SNIPPET) },
  { label: '', title: '插入当前日期时间 (Cmd/Ctrl+;)', icon: <IconClock />, run: insertTimestamp },
];

export function EditorPane({
  docId,
  content,
  onReady,
}: {
  docId: string;
  content: string;
  onReady: (view: EditorView) => void;
}) {
  const viewRef = useRef<EditorView | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [colorMenu, setColorMenu] = useState<'color' | 'background-color' | null>(null);

  // 新建文档后自动聚焦，光标立即可见（否则焦点留在对话框按钮上，光标延迟出现）
  const focusDoc = useStore((s) => s.focusDoc);
  useEffect(() => {
    if (!focusDoc || focusDoc !== docId || !viewRef.current) return;
    viewRef.current.focus();
    viewRef.current.dispatch({ selection: { anchor: 0 } });
    useStore.getState().clearFocusRequest();
  }, [focusDoc, docId]);

  // 搜索跳转：定位光标到目标行并滚动
  const reveal = useStoreReveal();
  useEffect(() => {
    if (!reveal || reveal.path !== docId || !viewRef.current) return;
    const view = viewRef.current;
    const lineNo = Math.min(reveal.lineNo, view.state.doc.lines);
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    useStore.getState().clearReveal();
  }, [reveal, docId]);

  // 强制同步：store 主动更新内容（恢复版本/外部文件变化）时替换编辑器文档。
  // @uiw/react-codemirror 的受控 value 对外部更新不可靠，必须显式 dispatch。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== content) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
    }
  }, [content]);

  const extensions = useMemo(
    () => [
      // 光标常显不闪烁：默认 1.2s 闪烁周期的隐藏相位会让点击后的光标"延迟出现"
      drawSelection({ cursorBlinkRate: 0 }),
      markdown({ codeLanguages: languages, extensions: [Table] }),
      livePreview,
      EditorView.domEventHandlers({
        // 点击落点：命中被隐藏的语法标记区域时，光标吸附到最近的可见位置
        mousedown(event, view) {
          if (event.button !== 0) return false;
          // 三击快速选中整行（接管行与普通行统一支持）
          if (event.detail >= 3) {
            const pos = posFromClick(view, event.clientX, event.clientY) ?? view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const line = view.state.doc.lineAt(pos);
            view.dispatch({ selection: { anchor: line.from, head: line.to } });
            return true;
          }
          // 纯文本行：交给 CodeMirror 默认处理（保留拖动选择）
          // 带渲染装饰的行：CM 的像素→位置映射不可靠（会落到行尾/别处），接管
          const pos = posFromClick(view, event.clientX, event.clientY);
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          if (!lineHasDecoration(view, line.from, line.to)) return false;
          const target = resolveVisiblePos(view, pos);
          view.dispatch({ selection: { anchor: target } });
          return true;
        },
        // 双击选中文本：选中点击位置所在的连续词语段（字母/数字/汉字，遇标点空白停止）
        dblclick(event, view) {
          // 双击图片 → 大图查看
          const target = event.target as HTMLElement | null;
          const img = target?.closest?.('.cm-md-image img');
          if (img) {
            useStore.getState().openImageViewer((img as HTMLImageElement).src);
            return true;
          }
          const clicked = posFromClick(view, event.clientX, event.clientY);
          if (clicked == null) return false;
          const pos = resolveVisiblePos(view, clicked);
          const line = view.state.doc.lineAt(pos);
          const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
          let from = pos;
          let to = pos;
          while (from > line.from && isWordChar(line.text[from - 1 - line.from])) from--;
          while (to < line.to && isWordChar(line.text[to - line.from])) to++;
          if (from >= to) return false;
          view.dispatch({ selection: { anchor: from, head: to } });
          return true; // 阻止默认双击，避免与隐藏语法标记的选择计算互相干扰
        },
        // 粘贴截图 / 拖拽图片文件 → 压缩后写入本地并插入
        paste(event, view) {
          const file = findImageFile(event.clipboardData);
          if (!file) return false;
          event.preventDefault();
          void insertImageFile(view, file);
          return true;
        },
        drop(event, view) {
          const file = findImageFile(event.dataTransfer);
          if (!file) return false;
          event.preventDefault();
          void insertImageFile(view, file);
          return true;
        },
      }),
      Prec.highest(
        keymap.of([
          { key: 'Mod-b', run: (v) => (wrapSelection(v, '**', '**'), true) },
          { key: 'Mod-i', run: (v) => (wrapSelection(v, '*', '*'), true) },
          { key: 'Mod-k', run: (v) => (wrapSelection(v, '[', '](https://)'), true) },
          { key: 'Mod-;', run: (v) => (insertTimestamp(v), true) },
          { key: 'Mod-Shift-1', run: (v) => (toggleLinePrefix(v, '# '), true) },
          { key: 'Mod-Shift-2', run: (v) => (toggleLinePrefix(v, '## '), true) },
          { key: 'Mod-Shift-3', run: (v) => (toggleLinePrefix(v, '### '), true) },
          { key: 'Mod-Shift-7', run: (v) => (toggleLinePrefix(v, '1. '), true) },
          { key: 'Mod-Shift-8', run: (v) => (toggleLinePrefix(v, '- '), true) },
          { key: 'Mod-Shift-9', run: (v) => (toggleLinePrefix(v, '- [ ] '), true) },
          { key: 'Mod-e', run: (v) => (wrapSelection(v, '`', '`'), true) },
          { key: 'Mod-Shift-h', run: (v) => (toggleHighlight(v), true) },
        ])
      ),
    ],
    []
  );

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        {TOOLS.map((t) => (
          <button key={t.title} title={t.title} onMouseDown={(e) => e.preventDefault()} onClick={() => viewRef.current && t.run(viewRef.current)}>
            {t.icon ?? t.label}
          </button>
        ))}
        <button
          title="插入图片（也可直接粘贴截图或拖拽图片文件）"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
        >
          <IconImage />
        </button>
        <div className="color-tool">
          <button
            title="文字颜色（先选中文字）"
            style={{ color: '#dc2626' }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setColorMenu(colorMenu === 'color' ? null : 'color')}
          >
            A
          </button>
          <button
            title="背景颜色（先选中文字，Cmd/Ctrl+Shift+H 快速高亮）"
            style={{ background: 'linear-gradient(180deg, transparent 55%, #fef08a 55%)' }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setColorMenu(colorMenu === 'background-color' ? null : 'background-color')}
          >
            A
          </button>
          {colorMenu && (
            <ColorPicker
              kind={colorMenu}
              onPick={(hex) => {
                if (viewRef.current) applyColor(viewRef.current, colorMenu, hex);
                setColorMenu(null);
              }}
              onClose={() => setColorMenu(null)}
            />
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file && viewRef.current) void insertImageFile(viewRef.current, file);
          }}
        />
      </div>
      <div className="editor-cm">
        <CodeMirror
          value={content}
          height="100%"
          theme="light"
          extensions={extensions}
          placeholder="开始输入 Markdown…"
          basicSetup={{ lineNumbers: false, highlightActiveLine: false, highlightActiveLineGutter: false, foldGutter: false, highlightSelectionMatches: false }}
          onChange={(value) => useStore.getState().updateContent(docId, value)}
          onCreateEditor={(view) => {
            viewRef.current = view;
            (window as unknown as { __cmView?: EditorView }).__cmView = view; // 调试与自动化测试钩子
            onReady(view);
          }}
        />
      </div>
    </div>
  );
}
