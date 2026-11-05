import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import CodeMirror, { EditorSelection, EditorView, Prec, keymap } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { livePreview, resolveVisiblePos } from '../lib/livePreview';
import { findImageFile, insertImageFile } from '../lib/assets';
import { useStore } from '../store/app';
import { IconLink, IconQuote, IconList, IconTask, IconTable, IconCode, IconCodeInline, IconImage, IconClock } from './Icons';

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
  { label: 'H1', title: '一级标题', run: (v) => toggleLinePrefix(v, '# ') },
  { label: 'H2', title: '二级标题', run: (v) => toggleLinePrefix(v, '## ') },
  { label: 'H3', title: '三级标题', run: (v) => toggleLinePrefix(v, '### ') },
  { label: 'B', title: '粗体 (Cmd/Ctrl+B)', run: (v) => wrapSelection(v, '**', '**') },
  { label: 'I', title: '斜体 (Cmd/Ctrl+I)', run: (v) => wrapSelection(v, '*', '*') },
  { label: '', title: '行内代码', icon: <IconCodeInline />, run: (v) => wrapSelection(v, '`', '`') },
  { label: '', title: '链接 (Cmd/Ctrl+K)', icon: <IconLink />, run: (v) => wrapSelection(v, '[', '](https://)') },
  { label: '', title: '引用', icon: <IconQuote />, run: (v) => toggleLinePrefix(v, '> ') },
  { label: '', title: '无序列表', icon: <IconList />, run: (v) => toggleLinePrefix(v, '- ') },
  { label: '1.', title: '有序列表', run: (v) => toggleLinePrefix(v, '1. ') },
  { label: '', title: '任务列表', icon: <IconTask />, run: (v) => toggleLinePrefix(v, '- [ ] ') },
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
      markdown({ codeLanguages: languages }),
      livePreview,
      EditorView.domEventHandlers({
        // 点击落点：命中被隐藏的语法标记区域时，光标吸附到最近的可见位置
        mousedown(event, view) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const target = resolveVisiblePos(view, pos);
          if (target === pos) return false; // 正常可见位置，交给 CodeMirror 默认处理（保留拖选）
          view.dispatch({ selection: { anchor: target } });
          return true;
        },
        // 双击选中文本：选中点击位置所在的连续词语段（字母/数字/汉字，遇标点空白停止）
        dblclick(event, view) {
          const clicked = view.posAtCoords({ x: event.clientX, y: event.clientY });
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
