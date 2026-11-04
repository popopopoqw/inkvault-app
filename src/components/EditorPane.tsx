import { useMemo, useRef } from 'react';
import CodeMirror, { EditorSelection, EditorView, Prec, keymap } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { livePreviewPlugin } from '../lib/livePreview';
import { findImageFile, insertImageFile } from '../lib/assets';
import { useStore } from '../store/app';

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
const CODE_SNIPPET = '```ts\n\n```';

interface Tool {
  label: string;
  title: string;
  run: (view: EditorView) => void;
}

const TOOLS: Tool[] = [
  { label: 'H1', title: '一级标题', run: (v) => toggleLinePrefix(v, '# ') },
  { label: 'H2', title: '二级标题', run: (v) => toggleLinePrefix(v, '## ') },
  { label: 'H3', title: '三级标题', run: (v) => toggleLinePrefix(v, '### ') },
  { label: 'B', title: '粗体 (Cmd/Ctrl+B)', run: (v) => wrapSelection(v, '**', '**') },
  { label: 'I', title: '斜体 (Cmd/Ctrl+I)', run: (v) => wrapSelection(v, '*', '*') },
  { label: '‹/›', title: '行内代码', run: (v) => wrapSelection(v, '`', '`') },
  { label: '🔗', title: '链接 (Cmd/Ctrl+K)', run: (v) => wrapSelection(v, '[', '](https://)') },
  { label: '❝', title: '引用', run: (v) => toggleLinePrefix(v, '> ') },
  { label: '•', title: '无序列表', run: (v) => toggleLinePrefix(v, '- ') },
  { label: '1.', title: '有序列表', run: (v) => toggleLinePrefix(v, '1. ') },
  { label: '☑', title: '任务列表', run: (v) => toggleLinePrefix(v, '- [ ] ') },
  { label: '▦', title: '表格', run: (v) => insertBlock(v, TABLE_SNIPPET) },
  { label: '{ }', title: '代码块', run: (v) => insertBlock(v, CODE_SNIPPET) },
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

  const extensions = useMemo(
    () => [
      markdown({ codeLanguages: languages }),
      livePreviewPlugin,
      EditorView.domEventHandlers({
        // 粘贴截图 / 拖拽图片文件 → 压缩加密上传后插入
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
            {t.label}
          </button>
        ))}
        <button
          title="插入图片（也可直接粘贴截图或拖拽图片文件）"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
        >
          🖼
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
