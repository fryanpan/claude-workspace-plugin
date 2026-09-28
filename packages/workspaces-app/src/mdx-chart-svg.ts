/**
 * The SVG primitives both chart drawings share (`mdx-chart.ts` for lines,
 * `mdx-chart-bars.ts` for bars): element and text builders, round ticks, value
 * formatting and label clipping. Every string reaches the page as an SVG text
 * node or `textContent`.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The reference categorical palette, in its fixed order (light surface). */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7'];
/** Rough width of a 12px sans glyph; no layout is read, so jsdom draws alike. */
export const CH = 6.6;

export const seriesColor = (i: number): string => SERIES[i % SERIES.length] ?? '#2a78d6';

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

export function text(
  parent: Element,
  words: string,
  attrs: Record<string, string | number>,
): SVGTextElement {
  const t = el('text', attrs, parent);
  t.textContent = words;
  return t;
}

export function tip(parent: Element, words: string): void {
  el('title', {}, parent).textContent = words;
}

/** About `count` round ticks covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

export function fmt(v: number, style: 'plain' | 'thousands', unit?: string): string {
  let s: string;
  if (style === 'thousands' && Math.abs(v) >= 1000) {
    s = `${Number((v / 1000).toFixed(1))}k`;
  } else {
    s = Number(v.toFixed(2)).toLocaleString('en-US');
  }
  // A symbol unit rides the number; a word unit captions the axis instead.
  return unit && isSymbolUnit(unit) ? `${s}${unit}` : s;
}

export const isSymbolUnit = (unit: string): boolean => unit.length <= 2;

export function frame(w: number, h: number, type: string): SVGSVGElement {
  const svg = el('svg', {
    class: 'mdx-chart',
    'data-chart': type,
    viewBox: `0 0 ${w} ${h}`,
    width: w,
    height: h,
  });
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/** `s` cut with an ellipsis to fit about `px` pixels of `ch`-wide glyphs. */
export function clip(s: string, px: number, ch = CH): string {
  const n = Math.max(1, Math.floor(px / ch));
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}
