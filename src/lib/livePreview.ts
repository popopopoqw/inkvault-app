import { syntaxTree } from '@codemirror/language';
import { EditorState, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { resolveAssetUrl } from './assets';
import { renderMermaidToSvg } from './mermaid';
import { renderHtml } from './markdown';

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

// 表格：整块渲染成 HTML 表格（光标进入显示源码）
class TableWidget extends WidgetType {
  constructor(private src: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.src === this.src;
  }
  get lineBreaks() {
    return Math.max(3, this.src.split('\n').length);
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table';
    wrap.innerHTML = renderHtml(this.src);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

// 整块 mermaid 图表：光标不在块内时直接渲染成图
class MermaidWidget extends WidgetType {
  constructor(private code: string) {
    super();
  }
  eq(other: MermaidWidget) {
    return other.code === this.code;
  }
  get lineBreaks() {
    return Math.max(4, this.code.split('\n').length);
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-mermaid';
    wrap.textContent = '图表渲染中…';
    void renderMermaidToSvg(this.code)
      .then((svg) => {
        wrap.innerHTML = svg;
      })
      .catch((e) => {
        wrap.classList.add('mermaid-error');
        wrap.textContent = `图表渲染失败：${(e as Error)?.message?.split('\n')[0] ?? '语法错误'}`;
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

function buildInlineDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const cursorLines = selectionLines(state);
  const ranges: Range<Decoration>[] = [];

  // 行内语法标记：光标紧邻或处于标记内时显示源码，否则隐藏（保持渲染态）
  const hideIfNoCursor = (from: number, to: number) => {
    const nearCursor = state.selection.ranges.some((r) => r.head >= from - 1 && r.head <= to + 1);
    if (!nearCursor && to > from) ranges.push(hide.range(from, to));
  };

  // 配对语法（** **、` `、围栏、链接的 [ 和 ](...)）必须整对显示/隐藏，
  // 否则光标贴着后半个标记时只显示一半语法，看不出语法结构
  const hidePairIfNoCursor = (first: { from: number; to: number }, ...rest: { from: number; to: number }[]) => {
    const nearCursor = state.selection.ranges.some((r) =>
      [first, ...rest].some((m) => r.head >= m.from - 1 && r.head <= m.to + 1)
    );
    if (nearCursor) return;
    ranges.push(hide.range(first.from, first.to));
    for (const m of rest) ranges.push(hide.range(m.from, m.to));
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
          hidePairIfNoCursor({ from: first.from, to: first.to }, { from: last.from, to: last.to });
          const style = node.name === 'StrongEmphasis' ? strongDeco : emDeco;
          ranges.push(style.range(first.to, last.from));
          break;
        }
        case 'InlineCode': {
          const first = node.node.firstChild;
          const last = node.node.lastChild;
          if (!first || !last || first === last) break;
          hidePairIfNoCursor({ from: first.from, to: first.to }, { from: last.from, to: last.to });
          ranges.push(codeDeco.range(first.to, last.from));
          break;
        }
        case 'FencedCode': {
          // 围栏行（``` 与语言标记）隐藏，内容行加代码样式；两个围栏联动显示
          const marks: { from: number; to: number }[] = [];
          let codeText: { from: number; to: number } | null = null;
          for (const child of node.node.getChildren('CodeMark')) marks.push({ from: child.from, to: child.to });
          const info = node.node.getChild('CodeInfo');
          for (const child of node.node.getChildren('CodeText')) codeText = { from: child.from, to: child.to };

          // mermaid 块：整块装饰由 mermaidBlockField（StateField）负责，行内不处理
          const lang = info && info.to > info.from ? state.sliceDoc(info.from, info.to).trim() : '';
          if (lang === 'mermaid') break;

          const nearAnyFence = marks.some((m) => cursorLines.has(state.doc.lineAt(m.from).number));
          if (marks.length >= 1 && !nearAnyFence) {
            const firstMark = marks[0];
            const fenceEnd = info ? info.to : firstMark.to;
            const fenceLine = state.doc.lineAt(firstMark.from);
            ranges.push(hide.range(firstMark.from, fenceEnd));
            ranges.push(lineDeco('cm-md-fence').range(fenceLine.from));
          }
          if (marks.length >= 2 && !nearAnyFence) {
            const last = marks[marks.length - 1];
            const lastLine = state.doc.lineAt(last.from);
            ranges.push(hide.range(last.from, last.to));
            ranges.push(lineDeco('cm-md-fence').range(lastLine.from));
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
            const imgMatch = /^!\[([^\]]*)\]\(asset:([A-Za-z0-9._-]{1,80})\)$/.exec(state.sliceDoc(node.from, node.to));
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
          // '[' 与 '](url)' 联动：光标贴着任一半就整对显示源码
          if (isImage) {
            hidePairIfNoCursor({ from: node.from, to: node.from + 1 }, { from: start, to: start + 1 }, { from: closePos, to: node.to });
          } else {
            hidePairIfNoCursor({ from: start, to: start + 1 }, { from: closePos, to: node.to });
          }
          if (closePos > start + 1) ranges.push(linkDeco.range(start + 1, closePos));
          break;
        }
        case 'ListItem': {
          // 任务列表：把 [x]/[ ] 渲染为 checkbox；
          // [x] 后的空格可为半角/全角/无空格（含行尾空任务），replace 连空格一并替换
          const mark = node.node.getChild('ListMark');
          if (!mark) break;
          const after = state.sliceDoc(mark.to, mark.to + 12);
          const m = /^( *)\[([ xX])\][ \u3000]*/.exec(after);
          if (!m) break;
          const boxFrom = mark.to + m[1].length;
          const boxLen = m[0].length - m[1].length;
          const line = state.doc.lineAt(boxFrom);
          if (cursorLines.has(line.number)) break;
          ranges.push(
            Decoration.replace({ widget: new CheckboxWidget(m[2] !== ' ') }).range(boxFrom, boxFrom + boxLen)
          );
          break;
        }
        default:
          break;
      }
    },
  });

  // 文字/背景颜色：<span style="color|background-color: #xxx"> 标签隐藏、内容着色（光标行显示源码）
  const spanOpen = /<span style="(color|background-color):\s*(#[0-9a-fA-F]{3,8})\s*;?">/gi;
  const closeTag = '</span>';
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!line.text.includes('<span')) continue;
    if (cursorLines.has(n)) continue;
    spanOpen.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = spanOpen.exec(line.text))) {
      const openFrom = line.from + m.index;
      const openTo = openFrom + m[0].length;
      const closeIdx = line.text.indexOf(closeTag, spanOpen.lastIndex);
      const contentTo = closeIdx === -1 ? line.to : line.from + closeIdx;
      ranges.push(hide.range(openFrom, openTo));
      ranges.push(Decoration.mark({ attributes: { style: `${m[1]}: ${m[2]}` } }).range(openTo, contentTo));
      if (closeIdx !== -1) {
        const closeFrom = line.from + closeIdx;
        ranges.push(hide.range(closeFrom, closeFrom + closeTag.length));
        spanOpen.lastIndex = closeIdx + closeTag.length;
      } else {
        break;
      }
    }
  }

  return Decoration.set(ranges, true);
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInlineDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildInlineDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

// 块级装饰（整块 mermaid 图）必须由 StateField 提供，ViewPlugin 会抛
// "Block decorations may not be specified via plugins"
function buildBlockDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      // 表格：光标不在块内时整块渲染成 HTML 表格
      if (node.name === 'Table') {
        const firstLine = state.doc.lineAt(node.from).number;
        const lastLine = state.doc.lineAt(node.to).number;
        const cursorInside = state.selection.ranges.some((r) => {
          const n = state.doc.lineAt(r.head).number;
          return n >= firstLine && n <= lastLine;
        });
        if (!cursorInside) {
          const from = state.doc.lineAt(node.from).from;
          const to = state.doc.lineAt(node.to).to;
          ranges.push(
            Decoration.replace({ widget: new TableWidget(state.sliceDoc(from, to)), block: true }).range(from, to)
          );
        }
        return false;
      }
      if (node.name !== 'FencedCode') return;
      const info = node.node.getChild('CodeInfo');
      const codeText = node.node.getChildren('CodeText')[0];
      if (!codeText) return;
      const lang = info && info.to > info.from ? state.sliceDoc(info.from, info.to).trim() : '';
      if (lang !== 'mermaid') return;
      const firstLine = state.doc.lineAt(node.from).number;
      const lastLine = state.doc.lineAt(node.to).number;
      const cursorInside = state.selection.ranges.some((r) => {
        const n = state.doc.lineAt(r.head).number;
        return n >= firstLine && n <= lastLine;
      });
      if (cursorInside) return; // 光标在块内显示源码
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      ranges.push(
        Decoration.replace({ widget: new MermaidWidget(state.sliceDoc(codeText.from, codeText.to)), block: true }).range(from, to)
      );
    },
  });
  return Decoration.set(ranges, true);
}

const mermaidBlockField = StateField.define<DecorationSet>({
  create: buildBlockDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection) return buildBlockDecorations(tr.state);
    return value;
  },
});

/** 编辑器即时渲染扩展（行内 ViewPlugin + 块级 StateField） */
export const livePreview = [
  livePreviewPlugin,
  mermaidBlockField,
  EditorView.decorations.compute([mermaidBlockField], (state) => state.field(mermaidBlockField)),
] as const;

/**
 * 点击定位（像素 → 文档位置）。
 * CodeMirror 的 posAtCoords 在「隐藏标记 + 行内样式装饰」混合的行上会失效（落到行尾），
 * 而 coordsAtPos（正向）始终准确——因此先用 posAtCoords 粗定位行，再在该行内
 * 用正向坐标搜索离点击像素最近的位置。
 */
/**
 * 该行是否带即时渲染装饰（隐藏标记/行内样式/行级样式）。
 * CodeMirror 默认的像素→位置映射在这些行上不可靠（会落到行尾），点击需要接管。
 * 通过 state facet 读取装饰（跨模块实例安全）。
 */
export function lineHasDecoration(view: EditorView, lineFrom: number, lineTo: number): boolean {
  for (const val of view.state.facet(EditorView.decorations)) {
    const set = typeof val === 'function' ? val(view) : val;
    const iter = set.iter(lineFrom);
    while (iter.value) {
      if (iter.from > lineTo) break; // 已越过该行
      // line 装饰是行首的点区间（from==to==行首），replace/mark 装饰跨字符
      if (iter.to > lineFrom || iter.from === lineFrom) return true;
      iter.next();
    }
  }
  return false;
}

export function posFromClick(view: EditorView, x: number, y: number): number | null {
  // 不经过行定位（块高度表在装饰行上同样有偏差），直接在可视区内
  // 对 y 命中该行的所有位置做正向坐标搜索，取离点击 x 最近的位置
  let best: number | null = null;
  let bestDist = Infinity;
  const from = view.state.doc.lineAt(view.viewport.from).from;
  const toLine = view.state.doc.lineAt(view.viewport.to);
  const to = toLine.to;
  for (let p = from; p <= to; p++) {
    const c = view.coordsAtPos(p);
    if (!c) continue;
    if (y < c.top - 6 || y > c.bottom + 6) continue;
    const d = Math.abs((c.left + c.right) / 2 - x);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/**
 * 点击定位：若位置落在被隐藏的语法标记（replace 装饰）内，
 * 吸附到该隐藏区间的最近边界，保证"点哪儿光标就在哪儿"。
 */
export function resolveVisiblePos(view: EditorView, pos: number): number {
  // 先查块级（mermaid 整块替换）
  const blockDecos = view.state.field(mermaidBlockField, false);
  if (blockDecos) {
    const bi = blockDecos.iter(pos);
    if (bi.value && bi.from <= pos && pos < bi.to) {
      return pos - bi.from <= bi.to - pos ? bi.from : bi.to;
    }
  }
  for (const val of view.state.facet(EditorView.decorations)) {
    const set = typeof val === 'function' ? val(view) : val;
    const iter = set.iter(pos);
    if (iter.value && iter.from <= pos && pos < iter.to) {
      // 无 class 的是 replace（隐藏）装饰；mark/line 装饰都带 class
      if (!iter.value.spec.class) {
        return pos - iter.from <= iter.to - pos ? iter.from : iter.to;
      }
    }
  }
  return pos;
}
