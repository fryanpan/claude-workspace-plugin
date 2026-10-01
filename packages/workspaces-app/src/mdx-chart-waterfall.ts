/**
 * A waterfall drawn as horizontal rows, top to bottom: a start total, each
 * step floating from the running total before it to the one after, and an end
 * total. Each row's name sits on its own lines above its bar, wrapped to the
 * chart's full width, so a ten-word lever stays readable on a phone; columns
 * would leave each name a column a few words wide. The value axis runs along
 * the bottom, so the reference line is the vertical rule at `baseline`.
 *
 * A total wears the bar chart's fill; a decrease and an increase each take a
 * colour from the series palette. Every string reaches the page as an SVG text
 * node or `textContent`.
 */

import { BAR_FILL } from './mdx-chart-bars.ts';
import type { WaterfallBar, WaterfallChart } from './mdx-chart-props.ts';
import { clip, el, frame, niceTicks, seriesColor, text, tip } from './mdx-chart-svg.ts';

/** A decrease, and an increase: the palette's orange and green. */
export const DECREASE_FILL = seriesColor(1);
export const INCREASE_FILL = seriesColor(2);
/** Rough glyph widths at the 13px the bar chart's names and values use. */
const LABEL_CH = 7;
const VALUE_CH = 7.5;
const LINE_H = 16;
const BAR_H = 18;
const ROW_GAP = 14;
/** A name longer than this many lines is cut with an ellipsis. */
const MAX_LINES = 3;

export function drawWaterfall(chart: WaterfallChart, w: number): SVGSVGElement {
  const valueLabels = chart.bars.map((b) => valueLabel(b, chart.unit));
  const left = 4;
  const right = Math.max(...valueLabels.map((l) => l.length)) * VALUE_CH + 12;
  const pw = Math.max(48, w - left - right);
  const { lo, hi, ticks } = domainOf(chart, pw);
  const sx = (v: number) => left + ((v - lo) / (hi - lo)) * pw;
  const top = chart.baseline !== undefined ? 22 : 8;
  const lines = chart.bars.map((b) => wrap(b.label, Math.floor((w - left - 4) / LABEL_CH)));
  const rowH = (i: number) => (lines[i]?.length ?? 1) * LINE_H + BAR_H + ROW_GAP;
  const bottom = top + chart.bars.reduce((sum, _, i) => sum + rowH(i), 0);
  const h = bottom + 28;
  const svg = frame(w, h, 'waterfall');

  const grid = el('g', { class: 'mdx-grid' }, svg);
  for (const v of ticks) {
    el('line', { x1: sx(v), x2: sx(v), y1: top, y2: bottom }, grid);
    text(grid, `${Number(v.toFixed(6))}${chart.unit}`, {
      x: sx(v),
      y: bottom + 18,
      'text-anchor': 'middle',
    });
  }

  let y = top;
  chart.bars.forEach((b, i) => {
    const g = el('g', { class: 'mdx-bar-row', 'data-kind': b.kind }, svg);
    const name = text(g, '', { x: left, y: y + 12, class: 'mdx-bar-label' });
    (lines[i] ?? []).forEach((line, k) => {
      el('tspan', { x: left, dy: k === 0 ? 0 : LINE_H }, name).textContent = line;
    });
    const barY = y + (lines[i]?.length ?? 1) * LINE_H;
    const a = sx(Math.min(b.from, b.to));
    const z = sx(Math.max(b.from, b.to));
    const r = el(
      'rect',
      {
        x: a,
        y: barY,
        width: Math.max(1, z - a),
        height: BAR_H,
        fill: fillOf(b),
        class: 'mdx-bar',
      },
      g,
    );
    tip(r, `${b.label}: ${valueLabels[i] ?? ''}`);
    text(g, valueLabels[i] ?? '', {
      x: z + 6,
      y: barY + BAR_H / 2 + 4,
      class: 'mdx-bar-value',
    });
    y += rowH(i);
  });
  el('line', { x1: sx(0), x2: sx(0), y1: top, y2: bottom, class: 'mdx-zero' }, svg);

  if (chart.baseline !== undefined) {
    const g = el('g', { class: 'mdx-baseline' }, svg);
    const x = sx(chart.baseline);
    el('line', { x1: x, x2: x, y1: top - 4, y2: bottom }, g);
    const words = `${chart.baselineLabel ? `${chart.baselineLabel} ` : ''}${Number(chart.baseline.toFixed(2))}${chart.unit}`;
    const half = (words.length * 6) / 2;
    const anchor = x - half < 0 ? 'start' : x + half > w ? 'end' : 'middle';
    text(g, words, { x, y: top - 8, 'text-anchor': anchor, class: 'mdx-baseline-label' });
  }
  return svg;
}

/** A step's signed change with a true minus sign; a total as written. */
function valueLabel(b: WaterfallBar, unit: string): string {
  const n = Number(Math.abs(b.value).toFixed(2));
  if (b.kind !== 'step') return `${b.value < 0 ? '−' : ''}${n}${unit}`;
  return `${b.value < 0 ? '−' : '+'}${n}${unit}`;
}

function fillOf(b: WaterfallBar): string {
  if (b.kind !== 'step') return BAR_FILL;
  return b.value < 0 ? DECREASE_FILL : INCREASE_FILL;
}

/** Round ticks over every bar end, zero and the baseline, the axis widened to
 *  the ticks either side so no bar reaches past the last one. */
function domainOf(chart: WaterfallChart, pw: number): { lo: number; hi: number; ticks: number[] } {
  const ends = chart.bars.flatMap((b) => [b.from, b.to]);
  if (chart.baseline !== undefined) ends.push(chart.baseline);
  let lo = Math.min(0, ...ends);
  let hi = Math.max(0, ...ends);
  if (lo === hi) hi = lo + 1;
  const rough = niceTicks(lo, hi, Math.max(2, Math.floor(pw / 80)));
  const step = (rough[1] ?? hi) - (rough[0] ?? lo) || hi - lo;
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo, hi, ticks };
}

/** `s` broken at spaces into lines of about `n` characters, at most
 *  `MAX_LINES` of them, the last cut with an ellipsis when words remain. */
export function wrap(s: string, n: number): string[] {
  const width = Math.max(4, n);
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  if (out.length === 0) return [''];
  if (out.length <= MAX_LINES) return out.map((l) => clip(l, width, 1));
  const kept = out.slice(0, MAX_LINES);
  const last = kept[MAX_LINES - 1] ?? '';
  kept[MAX_LINES - 1] = `${last.length < width ? last : last.slice(0, width - 1)}…`;
  return kept.map((l, i) => (i < MAX_LINES - 1 ? clip(l, width, 1) : l));
}
