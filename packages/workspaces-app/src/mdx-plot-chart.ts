/**
 * A `<PlotChart>` in a bound `.mdx`: an Observable Plot chart drawn from the
 * component's literal props by `buildPlot` (core `plot-spec.mjs`, the copy
 * other repos take verbatim), with its `subtitle` and `note` as text around it.
 *
 * Plot and `buildPlot` are fetched the first time a doc shows a
 * `<PlotChart>`, never before.
 * Not an `import('@observablehq/plot')`: the doc bundle is built with
 * splitting off, which inlines a dynamic import, so every page load would
 * carry it. `scripts/build.ts` builds `plot-entry.ts` to `/app/plot/plot.js`
 * and this module asks for that URL by value, as `math-katex.ts` does.
 *
 * A spec that names anything outside the allowlists, or a prop that is not a
 * literal, draws an error box in the chart's place and calls no Plot function.
 */

import { UNREADABLE } from './mdx-chart-props.ts';
import type { drawPlotSpec } from './plot-entry.ts';

/** What `/app/plot/plot.js` exports. */
export interface PlotChunk {
  drawPlotSpec: typeof drawPlotSpec;
}

/** Where the build puts Plot. */
export const PLOT_URL = '/app/plot/plot.js';

export interface PlotChartSummary {
  subtitle?: string;
  note?: string;
  data?: unknown;
  options?: unknown;
  marks?: unknown;
  /** The props that were not literals, so the box can name them. */
  unreadable: string[];
}

const SPEC_PROPS = ['data', 'options', 'marks'] as const;

/** The `<PlotChart>` props, as the literal parser read them. */
export function plotChartOf(props: Map<string, unknown>): PlotChartSummary {
  const out: PlotChartSummary = { unreadable: [] };
  const subtitle = props.get('subtitle');
  if (typeof subtitle === 'string') out.subtitle = subtitle;
  const note = props.get('note');
  if (typeof note === 'string') out.note = note;
  for (const key of SPEC_PROPS) {
    const v = props.get(key);
    if (v === UNREADABLE) out.unreadable.push(key);
    else if (v !== undefined) out[key] = v;
  }
  return out;
}

let ready: PlotChunk | null = null;
let loading: Promise<PlotChunk | null> | null = null;

function fetchFromApp(): Promise<PlotChunk | null> {
  // Built at runtime so the bundler cannot fold it into a literal it might
  // try to resolve and inline.
  const url = new URL(PLOT_URL, location.href).href;
  return (import(url) as Promise<PlotChunk>).then(
    (m) => m,
    () => null,
  );
}

let fetchPlot: () => Promise<PlotChunk | null> = fetchFromApp;

/** How a test swaps in its own Plot, or its own fetch of one. The page never
 *  calls it. */
export function setPlotForTest(
  api: PlotChunk | null,
  fetcher: (() => Promise<PlotChunk | null>) | null = null,
): void {
  ready = api;
  loading = api ? Promise.resolve(api) : null;
  fetchPlot = fetcher ?? fetchFromApp;
}

/** Plot, fetching it the first time. Null when the fetch fails; a later call
 *  tries again. */
export function loadPlot(): Promise<PlotChunk | null> {
  if (loading) return loading;
  const pending = fetchPlot().then((api) => {
    if (api) ready = api;
    else if (loading === pending) loading = null;
    return api;
  });
  loading = pending;
  return pending;
}

function errorBox(slot: HTMLElement, message: string): void {
  const box = document.createElement('div');
  box.className = 'mdx-plot-error';
  box.setAttribute('role', 'alert');
  box.textContent = message;
  slot.replaceChildren(box);
}

function draw(chunk: PlotChunk, slot: HTMLElement, chart: PlotChartSummary): void {
  if (chart.unreadable.length > 0) {
    errorBox(slot, `Not a literal, so not drawn: ${chart.unreadable.join(', ')}`);
    return;
  }
  const drawn = chunk.drawPlotSpec({
    data: chart.data as Record<string, unknown> | undefined,
    options: chart.options as Record<string, unknown> | undefined,
    marks: chart.marks,
  });
  if ('figure' in drawn) slot.replaceChildren(drawn.figure);
  else errorBox(slot, drawn.error);
}

/** Append the chart, its subtitle above and its note below, to `host`. Until
 *  Plot has arrived the chart's slot is empty and holds its height. */
export function renderPlotChart(host: HTMLElement, chart: PlotChartSummary): void {
  if (chart.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'mdx-subtitle';
    sub.textContent = chart.subtitle;
    host.appendChild(sub);
  }
  const slot = document.createElement('div');
  slot.className = 'mdx-plot';
  // A tap on the chart moves its tip; it does not open the source. A tap on
  // an error box still does, since the source is what the reader fixes.
  slot.addEventListener('click', (e) => {
    if (slot.querySelector('svg')) e.stopPropagation();
  });
  host.appendChild(slot);
  if (chart.note) {
    const note = document.createElement('div');
    note.className = 'mdx-chart-note mdx-plot-note';
    note.textContent = chart.note;
    host.appendChild(note);
  }
  if (ready) {
    draw(ready, slot, chart);
    return;
  }
  slot.classList.add('is-pending');
  const opts = chart.options as { width?: unknown; height?: unknown } | undefined;
  if (typeof opts?.width === 'number' && typeof opts.height === 'number') {
    slot.style.aspectRatio = `${opts.width} / ${opts.height}`;
    slot.style.maxWidth = `${opts.width}px`;
  }
  void loadPlot().then((chunk) => {
    // Re-rendered while the fetch was in flight: that render won.
    if (!slot.isConnected) return;
    slot.classList.remove('is-pending');
    slot.style.removeProperty('aspect-ratio');
    slot.style.removeProperty('max-width');
    if (chunk) draw(chunk, slot, chart);
    else errorBox(slot, 'Plot could not be loaded');
  });
}
