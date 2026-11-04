import { syntaxTree } from '@codemirror/language';
import { Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { resolveAssetUrl } from './assets';

/**
 * 所见即所得渲染：基于 markdown 语法树隐藏语法标记并应用渲染样式。
 * 光标所在的行同样保持渲染；仅当光标紧贴某个语法标记（如 #、**）时，
 * 该标记才临时显示源码，便于编辑。整行独占的图片/围栏/任务列表仍按行判断。
 */

const hide = Decoration.replace({});

const lineDeco = (cls: string) => Decoration.line({ class: cls });

const strongDeco = Decoration.mark({ class: 'cm-md-strong' });
const emDeco = Decoration.mark({ class: 'cm-md-em' });
const codeDeco = Decoration.mark({ class: 'cm-md-code' });
const linkDeco = Decoration.mark({ class: 'cm-md-link' });

class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('disabled', '');
    if (this.checked) input.setAttribute('checked', '');
    return input;
  }
  ignoreEvent() {
    return false;
  }
}

// 整行独占的附件图片：直接渲染解密后的图
class ImageWidget extends WidgetType {
  constructor(private assetId: string, private alt: string) {
    super();
  }
  eq(other: ImageWidget) {
    return other.assetId === this.assetId && other.alt === this.alt;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image';
    const img = document.createElement('img');
    img.alt = this.alt;
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; // 1px 占位，保持布局
    wrap.appendChild(img);
    void resolveAssetUrl(this.assetId)
      .then((url) => {
        img.src = url;
      })
      .catch(() => {
        wrap.textContent = `🖼 ${this.alt}（加载失败）`;
      });
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function selectionLines(state: EditorView['state']): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) lines.add(state.doc.lineAt(range.head).number);
  return lines;
}

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const cursorLines = selectionLines(state);
  const ranges: Range<Decoration>[] = [];

  // 行内语法标记：光标紧邻或处于标记内时显示源码，否则隐藏（保持渲染态）
  const hideIfNoCursor = (from: number, to: number) => {
    const nearCursor = state.selection.ranges.some((r) => r.head >= from - 1 && r.head <= to + 1);
    if (!nearCursor && to > from) ranges.push(hide.range(from, to));
  };

  syntaxTree(state).iterate({
    enter(node) {
      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const level = Number(node.name.slice(-1));
          const line = state.doc.lineAt(node.from);
          if (line.from === node.from) ranges.push(lineDeco(`cm-md-h${level}`).range(line.from));
          const mark = node.node.firstChild;
          if (mark && mark.name === 'HeaderMark') {
            // 连同 # 后的空格一起隐藏，避免渲染态标题前残留空白
            const markEnd = state.sliceDoc(mark.to, mark.to + 1) === ' ' ? mark.to + 1 : mark.to;
            hideIfNoCursor(mark.from, markEnd);
          }
          break;
        }
        case 'StrongEmphasis':
        case 'Emphasis': {
          const first = node.node.firstChild;
          const last = node.node.lastChild;
          if (!first || !last || first === last) break; // 空内容或异常结构
          hideIfNoCursor(first.from, first.to);
          hideIfNoCursor(last.from, last.to);
          const style = node.name === 'StrongEmphasis' ? strongDeco : emDeco;
          ranges.push(style.range(first.to, last.from));
          break;
        }
        case 'InlineCode': {
          const first = node.node.firstChild;
          const last = node.node.lastChild;
          if (!first || !last || first === last) break;
          hideIfNoCursor(first.from, first.to);
          hideIfNoCursor(last.from, last.to);
          ranges.push(codeDeco.range(first.to, last.from));
          break;
        }
        case 'FencedCode': {
          // 围栏行（``` 与语言标记）隐藏，内容行加代码样式
          const marks: { from: number; to: number }[] = [];
          let codeText: { from: number; to: number } | null = null;
          for (const child of node.node.getChildren('CodeMark')) marks.push({ from: child.from, to: child.to });
          const info = node.node.getChild('CodeInfo');
          for (const child of node.node.getChildren('CodeText')) codeText = { from: child.from, to: child.to };
          if (marks.length >= 1) {
            const firstMark = marks[0];
            const fenceEnd = info ? info.to : firstMark.to;
            const fenceLine = state.doc.lineAt(firstMark.from);
            if (!cursorLines.has(fenceLine.number)) {
              hideIfNoCursor(firstMark.from, fenceEnd);
              ranges.push(lineDeco('cm-md-fence').range(fenceLine.from));
            }
          }
          if (marks.length >= 2) {
            const last = marks[marks.length - 1];
            const lastLine = state.doc.lineAt(last.from);
            if (!cursorLines.has(lastLine.number)) {
              hideIfNoCursor(last.from, last.to);
              ranges.push(lineDeco('cm-md-fence').range(lastLine.from));
            }
          }
          if (codeText) {
            const firstLine = state.doc.lineAt(codeText.from).number;
            const lastLine = state.doc.lineAt(codeText.to).number;
            for (let n = firstLine; n <= lastLine; n++) {
              ranges.push(lineDeco('cm-md-pre').range(state.doc.line(n).from));
            }
          }
          break;
        }
        case 'Blockquote': {
          for (const child of node.node.getChildren('QuoteMark')) hideIfNoCursor(child.from, child.to);
          // 逐行加引用样式
          const firstLine = state.doc.lineAt(node.from).number;
          const lastLine = state.doc.lineAt(node.to).number;
          for (let n = firstLine; n <= lastLine; n++) {
            ranges.push(lineDeco('cm-md-quote').range(state.doc.line(n).from));
          }
          break;
        }
        case 'Link':
        case 'Image': {
          // [text](url) → 显示 text；Image 的 '!' 一并隐藏
          // 注意排除 [x] 这类 shortcut citation（会被解析为 Link），让它走任务列表分支
          const isImage = node.name === 'Image';
          const start = isImage ? node.from + 1 : node.from;
          const text = state.sliceDoc(start, node.to);

          // 整行独占的附件图片：直接显示真图
          if (isImage) {
            const imgMatch = /^!\[([^\]]*)\]\(asset:([a-f0-9]{1,64})\)$/.exec(state.sliceDoc(node.from, node.to));
            if (imgMatch) {
              const line = state.doc.lineAt(node.from);
              if (line.text.trim() === state.sliceDoc(node.from, node.to) && !cursorLines.has(line.number)) {
                ranges.push(
                  Decoration.replace({ widget: new ImageWidget(imgMatch[2], imgMatch[1]) }).range(node.from, node.to)
                );
                break;
              }
            }
          }

          const closeIdx = text.indexOf(']');
          if (!text.startsWith('[') || closeIdx < 0) break;
          if (!/^\]\(/.test(text.slice(closeIdx))) break; // 无 (url) 目标，非行内链接
          const closePos = start + closeIdx;
          if (isImage) hideIfNoCursor(node.from, node.from + 1);
          hideIfNoCursor(start, start + 1);
          hideIfNoCursor(closePos, node.to);
          if (closePos > start + 1) ranges.push(linkDeco.range(start + 1, closePos));
          break;
        }
        case 'ListItem': {
          // 任务列表：把 [x]/[ ] 渲染为 checkbox（ListMark 可能不含尾随空格，正则做兼容）
          const mark = node.node.getChild('ListMark');
          if (!mark) break;
          const after = state.sliceDoc(mark.to, mark.to + 8);
          const m = /^( *)\[([ xX])\] /.exec(after);
          if (!m) break;
          const boxFrom = mark.to + m[1].length;
          const line = state.doc.lineAt(boxFrom);
          if (cursorLines.has(line.number)) break;
          ranges.push(
            Decoration.replace({ widget: new CheckboxWidget(m[2] !== ' ') }).range(boxFrom, boxFrom + 3)
          );
          break;
        }
        default:
          break;
      }
    },
  });

  return Decoration.set(ranges, true);
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);
