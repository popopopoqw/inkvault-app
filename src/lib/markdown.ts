import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
// common 子集含 ~40 种常用语言，比全量 190+ 语言小得多
import hljs from 'highlight.js/lib/common';
import type { TocEntry } from './types';

const md = new MarkdownIt({
  // 允许内嵌 HTML 仅为支持 <span style="color/background-color"> 文字着色；
  // 渲染结果经 DOMPurify 严格白名单清洗（见 sanitizeHtml），其余 HTML 一律移除
  html: true,
  linkify: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* 回退到默认转义 */
      }
    }
    return '';
  },
});

// 只放行安全协议 + 自定义附件协议 asset:<id>（密文图片），其余（javascript: 等）拒绝
md.validateLink = (url: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? /^(https?:|mailto:|asset:)/.test(url) : true;

// ```mermaid 代码块输出为占位容器（内容由 mermaid 异步渲染成 SVG），其余走默认代码高亮
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === 'mermaid') {
    return `<div class="mermaid-block">${md.utils.escapeHtml(token.content)}</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

export interface RenderResult {
  html: string;
  toc: TocEntry[];
}

/**
 * XSS 防线：html:true 开启后所有内嵌 HTML 经此清洗。
 * 只放行 <span> 的 color / background-color 两个内联样式，其余标签属性全部移除。
 */
let purifyHooked = false;
function ensureHook() {
  if (purifyHooked) return;
  purifyHooked = true;
  // style 值内容过滤：HTML 节点只放行颜色与对齐（mermaid SVG 内部样式放行）
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName !== 'style') return;
    const inSvg = node.namespaceURI?.includes('svg');
    if (inSvg) return;
    const v = (data.attrValue ?? '').trim();
    const ok = /^(color|background-color):\s*#[0-9a-fA-F]{3,8}\s*;?$/i.test(v);
    if (!ok) data.keepAttr = false;
  });
}

export function sanitizeHtml(html: string): string {
  ensureHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['span', 'br', 'b', 'strong', 'i', 'em', 'code', 'del', 's', 'mark', 'a', 'img', 'input', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'hr', 'svg', 'path', 'rect', 'circle', 'g', 'text', 'span', 'tspan', 'polygon', 'line'],
    ALLOWED_ATTR: ['style', 'href', 'title', 'target', 'rel', 'src', 'alt', 'class', 'id', 'd', 'fill', 'stroke', 'stroke-width', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'transform', 'aria-hidden', 'checked', 'disabled', 'type', 'font-family', 'font-size', 'text-anchor', 'xmlns'],
    ALLOW_DATA_ATTR: false,
    // 放行 blob:（本地图片）与 asset:（附件协议）图片地址
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|blob|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
}

/** 直接把 markdown 源码渲染成 HTML 片段（块级 widget 复用） */
export function renderHtml(src: string): string {
  return sanitizeHtml(md.render(src));
}

// 从 markdown 源码提取标题（含行号），供所见即所得模式的大纲定位使用
export interface HeadingInfo {
  level: number;
  text: string;
  line: number; // 0-based 行号（CodeMirror dispatch 用）
}

export function extractHeadings(src: string): HeadingInfo[] {
  const tokens = md.parse(src, {});
  const out: HeadingInfo[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open' && t.map) {
      out.push({ level: Number(t.tag.slice(1)), text: tokens[i + 1]?.content ?? '', line: t.map[0] });
    }
  }
  return out;
}

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 64);

// 渲染 + 注入标题锚点 + 生成大纲。中文标题直接保留在锚点 id 中（HTML5 允许）。
export function renderMarkdown(source: string): RenderResult {
  const container = document.createElement('div');
  container.innerHTML = md.render(source);

  const toc: TocEntry[] = [];
  const used = new Set<string>();
  container.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
    const level = Number(el.tagName.slice(1));
    const text = el.textContent?.trim() ?? '';
    const base = slugify(text) || 'h';
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    el.id = id;
    toc.push({ id, text, level });
  });

  // GFM 任务列表：把 "[x] " / "[ ] " 前缀替换为只读 checkbox
  container.querySelectorAll('li').forEach((li) => {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const m = /^ *\[( |x|X)\][ \u3000]*/.exec(node.nodeValue ?? '');
      if (!m) continue;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('disabled', '');
      if (m[1] !== ' ') checkbox.setAttribute('checked', ''); // 用 attribute 才能在 innerHTML 序列化后保留
      node.nodeValue = (node.nodeValue ?? '').slice(m[0].length);
      (node.parentElement ?? li).insertBefore(checkbox, node);
      break;
    }
  });

  container.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });

  return { html: sanitizeHtml(container.innerHTML), toc };
}
