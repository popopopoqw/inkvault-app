/**
 * Mermaid 图表渲染：动态加载、结果缓存、strict 安全模式（标签内容转义）。
 * 主题配色与墨匣（靛蓝）一致。
 */

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
const svgCache = new Map<string, string>();
let counter = 0;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          primaryColor: '#eef0fe',
          primaryBorderColor: '#4f46e5',
          primaryTextColor: '#26263a',
          secondaryColor: '#fdf3e7',
          secondaryBorderColor: '#d97706',
          secondaryTextColor: '#26263a',
          tertiaryColor: '#ecfdf5',
          tertiaryBorderColor: '#059669',
          tertiaryTextColor: '#26263a',
          lineColor: '#77778e',
          textColor: '#26263a',
          fontSize: '14px',
        },
        flowchart: { curve: 'basis', useMaxWidth: true },
        sequence: { useMaxWidth: true },
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

/** 把 mermaid 源码渲染成 SVG 字符串；语法错误时抛出可读信息 */
export async function renderMermaidToSvg(code: string): Promise<string> {
  const key = code.trim();
  if (!key) throw new Error('空图表');
  const cached = svgCache.get(key);
  if (cached) return cached;
  const mermaid = await loadMermaid();
  const id = `inkvault-mmd-${counter++}`;
  const { svg } = await mermaid.render(id, key);
  if (svgCache.size > 200) svgCache.clear(); // 防无限增长
  svgCache.set(key, svg);
  return svg;
}
