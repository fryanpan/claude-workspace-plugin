import { prose } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';
import { type PlotChunk, setPlotForTest } from '../src/mdx-plot-chart.ts';
import { renderPlotInto } from '../src/plot-entry.ts';
import { MARKS, plotChartPresetSource, plotChartSource } from './fixtures/plot-chart.ts';

/**
 * A `<PlotChart>` in a bound `.mdx` draws the Plot chart its props describe
 * on the doc page, with its title, subtitle and note around it; a spec it
 * refuses draws an error box instead; and a change made in another copy of
 * the doc redraws the chart already on screen.
 *
 * Driven through the real editor over a Yjs fragment parsed the way the
 * server parses an `.mdx` bound file, with the chunk the build serves at
 * `/app/plot/plot.js` swapped in from source.
 */

const CHUNK: PlotChunk = { renderPlotInto };
const open: Array<() => void> = [];
beforeEach(() => setPlotForTest(CHUNK));
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  setPlotForTest(null);
});

/** The editor over `client`, and a `server` copy whose updates reach it. */
function mount(md: string): { server: Y.Doc } {
  const server = new Y.Doc();
  prose.getProseFragment(server).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  server.on('update', (u: Uint8Array) => Y.applyUpdate(client, u));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({
    parent,
    ydoc: client,
    awareness: new Awareness(client),
    editable: true,
  });
  open.push(() => handle.destroy());
  return { server };
}

const view = () => document.querySelector<HTMLElement>('.ProseMirror .mdx-block .mdx-view');
const svg = () => view()?.querySelector('.mdx-plot svg');
const texts = () => [...(svg()?.querySelectorAll('text') ?? [])].map((t) => t.textContent);

/** Replace the server's block `index` with `md`, as an agent's edit would. */
function rewriteBlock(server: Y.Doc, index: number, md: string): void {
  const fragment = prose.getProseFragment(server);
  server.transact(() => {
    fragment.delete(index, 1);
    fragment.insert(index, prose.parseMarkdownBlocks(md, { mdx: true }));
  });
}

describe('a PlotChart block on the doc page', () => {
  it('draws the chart with its title above, its subtitle under that and its note below', () => {
    mount(`Trips fell.\n\n${plotChartSource()}\n`);
    const v = view();
    expect(v?.querySelector('.mdx-title')?.textContent).toBe('Riverbend school trips by mode');
    expect(v?.querySelector('.mdx-name')).toBeNull();
    const order = [...(v?.children ?? [])].map((c) => c.className);
    expect(order).toEqual(['mdx-head', 'mdx-subtitle', 'mdx-plot', 'mdx-chart-note mdx-plot-note']);
    expect(v?.querySelector('.mdx-subtitle')?.textContent).toBe('Trips a year, stacked');
    expect(v?.querySelector('.mdx-plot-note')?.textContent).toBe(
      'Counts from the Harborlight survey.',
    );
    expect(svg()?.getAttribute('width')).toBe('820');
    expect(texts()).toContain('Safe Routes goal, 16 a year');
  });

  it('draws the same chart from the stackedArea preset, labelled at its ends', () => {
    mount(plotChartPresetSource());
    expect(view()?.querySelector('.mdx-title')?.textContent).toBe('Riverbend school trips, preset');
    expect(texts()).toEqual(
      expect.arrayContaining(['Walking 19', 'Biking 8', 'Safe Routes goal, 16 a year']),
    );
  });

  it('draws an error box naming the mark it refused, and no chart', () => {
    mount(plotChartSource({ marks: [...MARKS, { mark: 'geo', data: 'rows' }] }));
    const box = view()?.querySelector('.plot-spec-error');
    expect(box?.textContent).toBe('Mark 5: unknown mark "geo"');
    expect(svg()).toBeFalsy();
  });

  it('opens the source on a tap on the title, not on the chart', () => {
    mount(plotChartSource());
    const block = () => document.querySelector('.ProseMirror .mdx-block');
    svg()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(block()?.classList.contains('is-open')).toBe(false);
    view()
      ?.querySelector('.mdx-title')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(block()?.classList.contains('is-open')).toBe(true);
  });

  it('opens the source from an error box', () => {
    mount(plotChartSource({ marks: [{ mark: 'geo', data: 'rows' }] }));
    view()
      ?.querySelector('.plot-spec-error')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.ProseMirror .mdx-block')?.classList.contains('is-open')).toBe(
      true,
    );
  });

  it('names a prop that is not a literal instead of drawing', () => {
    mount('<PlotChart title="Saltmarsh" data={rows} marks={[]} />');
    expect(view()?.querySelector('.plot-spec-error')?.textContent).toBe(
      'Not a literal, so not drawn: data',
    );
  });

  it('redraws the chart on screen when the doc changes elsewhere', () => {
    const { server } = mount(`Trips fell.\n\n${plotChartSource()}\n`);
    expect(texts()).toContain('Safe Routes goal, 16 a year');
    const relabelled = MARKS.map((m) =>
      m.mark === 'text' ? { ...m, data: [{ x: 2025, y: 16, t: 'New goal, 20 a year' }] } : m,
    );
    rewriteBlock(server, 1, plotChartSource({ title: 'Harborlight trips', marks: relabelled }));
    expect(view()?.querySelector('.mdx-title')?.textContent).toBe('Harborlight trips');
    expect(texts()).toContain('New goal, 20 a year');
    expect(texts()).not.toContain('Safe Routes goal, 16 a year');
  });

  it('holds the chart slot, then draws once Plot arrives', async () => {
    let arrive: (c: PlotChunk) => void = () => {};
    setPlotForTest(
      null,
      () =>
        new Promise<PlotChunk>((resolve) => {
          arrive = resolve;
        }),
    );
    mount(plotChartSource());
    const slot = view()?.querySelector<HTMLElement>('.mdx-plot');
    expect(slot?.classList.contains('is-pending')).toBe(true);
    expect(slot?.style.aspectRatio).toBe('820 / 380');
    arrive(CHUNK);
    await new Promise((r) => setTimeout(r, 0));
    expect(slot?.classList.contains('is-pending')).toBe(false);
    expect(texts()).toContain('Safe Routes goal, 16 a year');
  });
});
