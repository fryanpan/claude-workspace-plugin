/**
 * A chart drawn as SVG, one user unit per CSS pixel, from the props
 * `mdx-chart-props.ts` read. What it draws follows the published site's own
 * chart component: a band is a shaded x-range spanning the plot's full height,
 * each line carries its name and last value at its own end inside the plot
 * rather than in a legend below, an indexed chart's reference line is drawn
 * and labelled on the plot, and each dated event is a dashed rule labelled
 * above the plot. Bars are `mdx-chart-bars.ts`.
 *
 * Every string reaches the page as an SVG text node or `textContent`.
 */

import { drawBars } from './mdx-chart-bars.ts';
import type { ChartPoint, LineChart, MdxChart } from './mdx-chart-props.ts';
import {
  CH,
  clip,
  el,
  fmt,
  frame,
  isSymbolUnit,
  niceTicks,
  seriesColor,
  text,
  tip,
} from './mdx-chart-svg.ts';

export type { ChartPoint, LineSeries, LineChart, BarChart, MdxChart } from './mdx-chart-props.ts';
export { chartOf } from './mdx-chart-props.ts';
export { niceTicks, seriesColor } from './mdx-chart-svg.ts';

const MAX_TIPS = 400;
/** Rough width of an 11px event label's glyph, as the site measures it. */
const EVENT_CH = 5.9;
/** The height of one row of event labels above the plot. */
const EVENT_ROW = 14;

/** The chart as an SVG, one user unit per CSS pixel: the width the chart's own
 *  `width` prop asked for, else `width`. */
export function drawChart(chart: MdxChart, width: number): SVGSVGElement {
  const w = Math.max(240, Math.round(chart.width ?? width));
  return chart.type === 'line' ? drawLines(chart, w) : drawBars(chart, w);
}

/** The name and last value each labelled line carries at its own end. Two that
 *  would land on each other are pushed apart, as the site's chart does. */
const END_GAP = 28;

function drawLines(chart: LineChart, w: number): SVGSVGElement {
  const h = w < 520 ? 220 : 280;
  const all = chart.series.flatMap((s) => s.points);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  // The band is an x-range, so it says nothing about the y axis: the extent is
  // the series' own, exactly as the published chart's is.
  if (chart.zeroBaseline) ys.push(0);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (y0 === y1) [y0, y1] = [y0 - 1, y1 + 1];
  const yTicks = niceTicks(y0, y1);
  // A reference line the reader cannot read a number off is just a stripe.
  if (chart.baseline !== undefined && chart.baseline >= y0 && chart.baseline <= y1) {
    if (!yTicks.some((v) => Math.abs(v - chart.baseline!) < 1e-9)) yTicks.push(chart.baseline);
    yTicks.sort((a, b) => a - b);
  }
  y0 = Math.min(y0, yTicks[0] ?? y0);
  y1 = Math.max(y1, yTicks[yTicks.length - 1] ?? y1);
  // Points that share one x sit mid-plot, not against the y axis.
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const [x0, x1] = xLo === xHi ? [xLo - 1, xHi + 1] : [xLo, xHi];

  const unitCaption = chart.unit && !isSymbolUnit(chart.unit) ? chart.unit : undefined;
  const yLabels = yTicks.map((v) => fmt(v, chart.yTickFormat, chart.unit));
  const left = Math.ceil(Math.max(...yLabels.map((l) => l.length)) * CH) + 10;
  const ends = chart.series
    .map((s, i) => {
      const last = [...s.points].sort((a, b) => a.x - b.x).at(-1);
      if (!s.label || !last) return undefined;
      // `showValue={false}` leaves the name alone, as the site does.
      const value = s.showValue ? fmt(last.y, chart.yTickFormat, chart.unit) : '';
      return { label: s.label, value, point: last, i };
    })
    .filter((e): e is { label: string; value: string; point: ChartPoint; i: number } => !!e);
  // Room at the right for those labels, never more than a third of the chart.
  const wanted =
    Math.max(0, ...ends.map((e) => Math.max(e.label.length, e.value.length))) * CH + 14;
  const right = ends.length > 0 ? Math.max(12, Math.min(Math.round(w * 0.34), wanted)) : 12;
  const bottom = 24;
  const pw = w - left - right;
  const events = layoutEvents(chart, pw, x0, x1);
  const eventRows = Math.max(0, ...events.map((e) => e.row + 1));
  // A band's label and the events' labels caption the plot from above, so
  // each takes its own strip.
  const top = (unitCaption ? 22 : 8) + (chart.band?.label ? 14 : 0) + eventRows * EVENT_ROW;
  const ph = h - top - bottom;
  const sx = (x: number) => left + ((x - x0) / (x1 - x0)) * pw;
  const sy = (y: number) => top + ph - ((y - y0) / (y1 - y0)) * ph;

  const svg = frame(w, h, 'line');
  if (unitCaption) text(svg, unitCaption, { class: 'mdx-axis-unit', x: 0, y: 12 });

  // A vertical region over the whole plot: the band names a stretch of x.
  if (chart.band) {
    const g = el('g', { class: 'mdx-band' }, svg);
    const xa = Math.max(left, Math.min(left + pw, sx(chart.band.from)));
    const xb = Math.max(left, Math.min(left + pw, sx(chart.band.to)));
    el('rect', { x: xa, y: top, width: Math.max(1, xb - xa), height: ph }, g);
  }

  const grid = el('g', { class: 'mdx-grid' }, svg);
  yTicks.forEach((v, i) => {
    const y = sy(v);
    el('line', { x1: left, x2: left + pw, y1: y, y2: y }, grid);
    text(grid, yLabels[i] ?? '', { x: left - 6, y: y + 4, 'text-anchor': 'end' });
  });

  // A year is not a quantity, so an x tick never takes a thousands separator,
  // and a short series is ticked at its own points — both as the site does.
  // Every series' x values, not the first one's: a second series can reach
  // past the first, and that stretch of the axis still needs its ticks.
  const own = [...new Set(xs)].sort((a, b) => a - b);
  const xTicks =
    chart.xTickLabels?.filter((t) => t.x >= x0 && t.x <= x1) ??
    (own.length > 1 && own.length <= 8
      ? own
      : niceTicks(x0, x1, Math.max(2, Math.floor(pw / 90)))
          // Whole-number data (years, months, days) gets whole-number ticks.
          .filter((x) => !xs.every(Number.isInteger) || Number.isInteger(x))
    ).map((x) => ({ x, label: String(Number(x.toFixed(2))) }));
  const widest = Math.max(...xTicks.map((t) => t.label.length), 1) * CH + 8;
  const every = Math.max(1, Math.ceil((xTicks.length * widest) / pw));
  const axis = el('g', { class: 'mdx-x-axis' }, svg);
  el('line', { x1: left, x2: left + pw, y1: top + ph, y2: top + ph }, axis);
  xTicks.forEach((t, i) => {
    if (i % every !== 0) return;
    const x = sx(t.x);
    const anchor = x - widest / 2 < 0 ? 'start' : x + widest / 2 > left + pw ? 'end' : 'middle';
    text(axis, t.label, { x, y: h - 6, 'text-anchor': anchor });
  });

  drawBaseline(svg, chart, { sx, sy, x0, x1 });

  // Under the lines, so the data draws over the rules.
  if (events.length > 0) {
    const g = el('g', { class: 'mdx-events' }, svg);
    for (const e of events) {
      const x = sx(e.x);
      el('line', { x1: x, x2: x, y1: top, y2: top + ph }, g);
      // A dot where the rule meets its label ties the label to the rule.
      el('circle', { cx: x, cy: top, r: 3 }, g);
      text(g, e.label, {
        x: x + 6,
        y: top - 4 - (eventRows - 1 - e.row) * EVENT_ROW,
        class: 'mdx-event-label',
      });
    }
  }

  let tips = 0;
  chart.series.forEach((s, i) => {
    const g = el('g', { class: 'mdx-series', 'data-series': i }, svg);
    const pts = [...s.points].sort((a, b) => a.x - b.x);
    const line = el(
      'polyline',
      {
        points: pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: seriesColor(i),
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      },
      g,
    );
    if (s.dashed) line.setAttribute('stroke-dasharray', '6 4');
    // A dot at each end, as the site marks them; one point draws no line, so
    // its dot is all the series shows.
    for (const p of new Set([pts[0], pts.at(-1)])) {
      if (!p) continue;
      el(
        'circle',
        { cx: sx(p.x), cy: sy(p.y), r: 4.5, fill: seriesColor(i), class: 'mdx-marker' },
        g,
      );
    }
    for (const p of pts) {
      if (tips++ >= MAX_TIPS) break;
      const hit = el('circle', { cx: sx(p.x), cy: sy(p.y), r: 8, class: 'mdx-hit' }, g);
      const xLabel =
        chart.xTickLabels?.find((t) => t.x === p.x)?.label ?? String(Number(p.x.toFixed(2)));
      const name = s.label ? `${s.label} · ` : '';
      tip(
        hit,
        `${name}${xLabel}: ${fmt(p.y, 'plain', chart.unit)}${unitCaption ? ` ${unitCaption}` : ''}`,
      );
    }
  });

  // Each line's own name at its end, in its colour: what lets the chart drop
  // the legend the published post does not have.
  const placed = ends.map((e) => ({ ...e, y: sy(e.point.y) })).sort((a, b) => a.y - b.y);
  // Each label is pushed off the one ALREADY placed above it, so a third that
  // crowds a pushed second is pushed clear of where that second ended up.
  for (let k = 1; k < placed.length; k++) {
    const above = placed[k - 1];
    const here = placed[k];
    if (above && here && here.y - above.y < END_GAP) here.y = above.y + END_GAP;
  }
  for (const e of placed) {
    const g = el('g', { class: 'mdx-end-labels' }, svg);
    const x = Math.min(sx(e.point.x) + 8, w - 2);
    const t = text(g, '', { x, y: e.y, class: 'mdx-end-label', fill: seriesColor(e.i) });
    el('tspan', { x, dy: -2 }, t).textContent = clip(e.label, right - 12);
    if (e.value) el('tspan', { x, dy: 13 }, t).textContent = e.value;
  }

  // Over the lines, so its halo keeps it legible where a line crosses it.
  if (chart.band?.label) {
    const mid = Math.max(left, Math.min(left + pw, sx((chart.band.from + chart.band.to) / 2)));
    text(el('g', { class: 'mdx-band' }, svg), chart.band.label, {
      x: mid,
      y: top - 4 - eventRows * EVENT_ROW,
      'text-anchor': 'middle',
      class: 'mdx-band-label',
    });
  }
  return svg;
}

/** The events inside the x range, each on the first of two label rows where it
 *  clears the label before it, as the site lays them out. */
function layoutEvents(
  chart: LineChart,
  pw: number,
  x0: number,
  x1: number,
): Array<{ x: number; label: string; row: number }> {
  const pxPerX = pw / Math.max(1, x1 - x0);
  const rowEnds = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  return (chart.events ?? [])
    .filter((e) => e.x >= x0 && e.x <= x1)
    .map((e) => {
      const start = (e.x - x0) * pxPerX + 6;
      const row = start >= (rowEnds[0] ?? 0) ? 0 : 1;
      rowEnds[row] = start + e.label.length * EVENT_CH;
      return { ...e, row };
    });
}

/** The reference line an indexed chart is read against, labelled at whichever
 *  end of the plot the series leave more room, on the side of the rule they
 *  are not using. */
function drawBaseline(
  svg: SVGSVGElement,
  chart: LineChart,
  scale: { sx: (x: number) => number; sy: (y: number) => number; x0: number; x1: number },
): void {
  const { baseline } = chart;
  if (baseline === undefined) return;
  const g = el('g', { class: 'mdx-baseline' }, svg);
  const y = scale.sy(baseline);
  el('line', { x1: scale.sx(scale.x0), x2: scale.sx(scale.x1), y1: y, y2: y }, g);
  const sorted = chart.series.map((s) => [...s.points].sort((a, b) => a.x - b.x));
  const atStart = startRoom(sorted, baseline);
  const ends = sorted.map((p) => (atStart ? p[0] : p.at(-1)));
  const below = ends.some((p) => (p?.y ?? baseline) > baseline);
  text(g, chart.baselineLabel ?? fmt(baseline, chart.yTickFormat, chart.unit), {
    x: atStart ? scale.sx(scale.x0) + 4 : scale.sx(scale.x1) - 4,
    y: y + (below ? 14 : -6),
    'text-anchor': atStart ? 'start' : 'end',
    class: 'mdx-baseline-label',
  });
}

function startRoom(sorted: ChartPoint[][], baseline: number): boolean {
  const room = (pick: (p: ChartPoint[]) => ChartPoint | undefined) =>
    Math.min(...sorted.map((p) => Math.abs((pick(p)?.y ?? baseline) - baseline)));
  return room((p) => p[0]) >= room((p) => p.at(-1));
}
