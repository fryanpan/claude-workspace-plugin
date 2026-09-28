/**
 * A bar chart drawn the way the published site's `Chart` component draws it:
 * horizontal rows 44px apart with the name left of the bar and the value
 * right of it, a value axis with a grid, one colour for every bar unless a row
 * names its own, and a percent chart always running 0–100 so a bar's length is
 * not misleading. A row's `sublabel` sits under its name, smaller and muted,
 * and the name and value step up a size so the eye reaches them first.
 *
 * The site draws at 720px and lets the page scale it; this draws one unit per
 * CSS pixel, so where a narrow column cannot hold the site's margins they
 * shrink alike and the plot keeps a floor, and no bar runs past the edge.
 */

import type { BarChart } from './mdx-chart-props.ts';
import { clip, el, frame, niceTicks, text, tip } from './mdx-chart-svg.ts';

/** The site's bar fill. */
export const BAR_FILL = '#5b8def';
/** A horizontal bar chart's narrowest plot, and narrowest row-label column. */
const MIN_PLOT_W = 48;
const MIN_LABEL_W = 24;
/** The site's rough glyph widths: 8px for a row name, 7px for a 13px value. */
const LABEL_CH = 8;
const VALUE_CH = 7.5;

/** The value axis: [0, 100] for percent, else 15% of headroom for the labels. */
function domainOf(chart: BarChart): [number, number] {
  const values = chart.bars.map((b) => b.value);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const pad = chart.unit === '%' ? 1 : 1.15;
  const hi = chart.unit === '%' ? Math.max(100, max) : max * pad;
  const lo = chart.unit === '%' ? min : min * pad;
  return hi === lo ? [lo, lo + 1] : [lo, hi];
}

/** Plot's band scale: rows `step` apart with a tenth of a step of padding. */
function bands(n: number, span: number): { step: number; at: (i: number) => number } {
  const step = span / (n + 0.1);
  return { step, at: (i) => step * (0.1 + i) };
}

export function drawBars(chart: BarChart, w: number): SVGSVGElement {
  const [lo, hi] = domainOf(chart);
  const valueLabels = chart.bars.map((b) => `${b.value}${chart.unit}`);
  const tickLabel = (v: number) => `${Number(v.toFixed(6))}${chart.unit}`;
  const fill = (i: number) => chart.bars[i]?.color ?? BAR_FILL;
  const mark = (g: Element, i: number, attrs: Record<string, number>) => {
    const r = el('rect', { ...attrs, fill: fill(i), class: 'mdx-bar' }, g);
    tip(r, `${chart.bars[i]?.label ?? ''}: ${valueLabels[i] ?? ''}`);
  };
  return chart.orientation === 'horizontal'
    ? drawRows(chart, w, { lo, hi, valueLabels, tickLabel, mark })
    : drawColumns(chart, w, { lo, hi, valueLabels, tickLabel, mark });
}

interface BarKit {
  lo: number;
  hi: number;
  valueLabels: string[];
  tickLabel: (v: number) => string;
  mark: (g: Element, i: number, attrs: Record<string, number>) => void;
}

function drawRows(chart: BarChart, w: number, kit: BarKit): SVGSVGElement {
  const { lo, hi, valueLabels } = kit;
  const subs = chart.bars.some((b) => b.sublabel);
  const top = 18;
  const bottom = 36;
  const h = Math.max(180, chart.bars.length * 44 + 60);
  const ph = h - top - bottom;
  // The value sits beside its bar's far end: left of a negative bar, right of
  // any other. The site keeps 70px at the right; a longer value gets its room.
  const valueW = Math.max(...valueLabels.map((l) => l.length)) * (subs ? 9.2 : VALUE_CH) + 8;
  const wantLeft = lo < 0 ? valueW : 0;
  const wantRight = chart.bars.some((b) => b.value >= 0) ? Math.max(70, valueW) : 4;
  // Too narrow for both gutters whole, they shrink alike; then row labels
  // give way. The plot keeps its floor, so no bar runs past the edge.
  const fit = Math.min(1, (w - MIN_LABEL_W - MIN_PLOT_W) / (wantLeft + wantRight));
  const leftValueW = wantLeft * fit;
  const rightValueW = wantRight * fit;
  // The column holds the wider of name and sublabel, the sublabel measured at
  // its own smaller size, as the site measures it.
  const longest = Math.max(
    ...chart.bars.map((b) => b.label.length),
    ...chart.bars.map((b) => ((b.sublabel?.length ?? 0) * 11) / 14),
  );
  const labelW = Math.max(
    MIN_LABEL_W,
    Math.min(
      260,
      Math.round(w * 0.38),
      Math.ceil(longest * LABEL_CH) + 20,
      w - leftValueW - rightValueW - MIN_PLOT_W,
    ),
  );
  const pw = w - labelW - leftValueW - rightValueW;
  const x0 = labelW + leftValueW;
  const sx = (v: number) => x0 + ((v - lo) / (hi - lo)) * pw;
  const svg = frame(w, h, 'bar');
  if (subs) svg.setAttribute('data-sublabels', 'true');

  const grid = el('g', { class: 'mdx-grid' }, svg);
  for (const v of niceTicks(lo, hi, Math.max(2, Math.floor(pw / 80)))) {
    el('line', { x1: sx(v), x2: sx(v), y1: top, y2: top + ph }, grid);
    text(grid, kit.tickLabel(v), { x: sx(v), y: top + ph + 18, 'text-anchor': 'middle' });
  }

  const { step, at } = bands(chart.bars.length, ph);
  chart.bars.forEach((b, i) => {
    const g = el('g', { class: 'mdx-bar-row' }, svg);
    const y = top + at(i);
    const mid = y + step * 0.45;
    text(g, clip(b.label, labelW - 12, LABEL_CH), {
      x: labelW - 9,
      y: subs ? mid - 2 : mid + 4,
      'text-anchor': 'end',
      class: 'mdx-bar-label',
    });
    if (subs && b.sublabel) {
      text(g, clip(b.sublabel, labelW - 12, 6), {
        x: labelW - 12,
        y: mid + 15,
        'text-anchor': 'end',
        class: 'mdx-bar-sublabel',
      });
    }
    const a = sx(Math.min(0, b.value));
    const z = sx(Math.max(0, b.value));
    kit.mark(g, i, { x: a, y, width: Math.max(1, z - a), height: step * 0.9 });
    text(g, valueLabels[i] ?? '', {
      x: b.value < 0 ? a - 6 : z + 6,
      y: mid + (subs ? 6 : 4),
      'text-anchor': b.value < 0 ? 'end' : 'start',
      class: 'mdx-bar-value',
    });
  });
  el('line', { x1: sx(0), x2: sx(0), y1: top, y2: top + ph, class: 'mdx-zero' }, svg);
  return svg;
}

function drawColumns(chart: BarChart, w: number, kit: BarKit): SVGSVGElement {
  const { lo, hi, valueLabels } = kit;
  const [top, bottom, left, right] = [18, 64, 50, 30];
  const h = 360;
  const ph = h - top - bottom;
  const pw = w - left - right;
  const sy = (v: number) => top + ph - ((v - lo) / (hi - lo)) * ph;
  const svg = frame(w, h, 'bar');

  const grid = el('g', { class: 'mdx-grid' }, svg);
  for (const v of niceTicks(lo, hi, 7)) {
    el('line', { x1: left, x2: left + pw, y1: sy(v), y2: sy(v) }, grid);
    text(grid, kit.tickLabel(v), { x: left - 9, y: sy(v) + 4, 'text-anchor': 'end' });
  }

  const { step, at } = bands(chart.bars.length, pw);
  chart.bars.forEach((b, i) => {
    const g = el('g', { class: 'mdx-bar-row' }, svg);
    const x = left + at(i);
    const cx = x + step * 0.45;
    const a = sy(Math.max(0, b.value));
    const z = sy(Math.min(0, b.value));
    kit.mark(g, i, { x, y: a, width: step * 0.9, height: Math.max(1, z - a) });
    // A value under a negative bar sits below it, clear of the row labels.
    text(g, valueLabels[i] ?? '', {
      x: cx,
      y: b.value < 0 ? z + 16 : a - 8,
      'text-anchor': 'middle',
      class: 'mdx-bar-value',
    });
    text(g, clip(b.label, step - 4), {
      x: cx,
      y: top + ph + (lo < 0 ? 36 : 18),
      'text-anchor': 'middle',
      class: 'mdx-bar-label',
    });
  });
  el('line', { x1: left, x2: left + pw, y1: sy(0), y2: sy(0), class: 'mdx-zero' }, svg);
  return svg;
}
