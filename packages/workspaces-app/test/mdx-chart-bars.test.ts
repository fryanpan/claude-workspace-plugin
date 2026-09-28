import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { renderMdxSummary, summarizeMdx } from '../src/mdx-preview.ts';
import { BARS } from './fixtures/mdx-charts.ts';

/**
 * A bar chart in a bound `.mdx` draws what the published site's `Chart`
 * component draws (`mdx-chart-bars.ts`), and a prop the preview leaves out is
 * named under the chart. Lines are `mdx-chart.test.ts` beside this.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(md: string): EditorHandle {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable: true });
  open.push(() => handle.destroy());
  return handle;
}

const views = () => [
  ...document.querySelectorAll<HTMLElement>('.ProseMirror .mdx-block .mdx-view'),
];
const texts = (root: Element | null | undefined, sel: string) =>
  [...(root?.querySelectorAll(sel) ?? [])].map((t) => t.textContent);

describe('a bar chart block on the doc page', () => {
  for (const orientation of ['horizontal', 'vertical']) {
    it(`draws ${orientation} bars with labels, values, and every bar one colour as the site does`, () => {
      mount(`${BARS(orientation)}\n`);
      const svg = views()[0]?.querySelector(`svg.mdx-chart[data-chart="bar"]`);
      const bars = [...(svg?.querySelectorAll('rect.mdx-bar') ?? [])];
      expect(bars).toHaveLength(3);
      expect(texts(svg, '.mdx-bar-label')).toEqual(['North pier', 'South pier', 'Ferry slip']);
      expect(texts(svg, '.mdx-bar-value')).toEqual(['42%', '31%', '17%']);
      // A row's own colour wins; the rest wear the site's fill. highlightIndex
      // mutes nothing, because the site's component never reads it.
      expect(bars.map((b) => b.getAttribute('fill'))).toEqual(['#5b8def', '#0b7285', '#5b8def']);
      // Longer bars for larger values, along the chart's own axis.
      const size = orientation === 'horizontal' ? 'width' : 'height';
      const lengths = bars.map((b) => Number(b.getAttribute(size)));
      expect(lengths[0]).toBeGreaterThan(lengths[1] ?? 0);
      expect(lengths[1]).toBeGreaterThan(lengths[2] ?? 0);
      // A percent axis runs 0-100, so 42% fills 42% of the plot, not all of it.
      const ticks = texts(svg, '.mdx-grid text');
      expect(ticks[0]).toBe('0%');
      expect(ticks.at(-1)).toBe('100%');
      const zero = svg?.querySelector('line.mdx-zero');
      const hundred = [...(svg?.querySelectorAll('.mdx-grid line') ?? [])].at(-1);
      const axis = orientation === 'horizontal' ? 'x1' : 'y1';
      const plot = Math.abs(Number(hundred?.getAttribute(axis)) - Number(zero?.getAttribute(axis)));
      expect((lengths[0] ?? 0) / plot).toBeCloseTo(0.42, 2);
    });
  }

  it('draws a Chart with no orientation as horizontal bars, as the site does', () => {
    mount(
      '<Chart data={[{ label: "Harborlight", value: 12 }, { label: "Riverbend", value: 30 }]} />\n',
    );
    const svg = views()[0]?.querySelector('svg.mdx-chart[data-chart="bar"]');
    const [a, b] = [...(svg?.querySelectorAll('rect.mdx-bar') ?? [])];
    // Rows: one bar under the other, the same height, lengths by value.
    expect(Number(b?.getAttribute('y'))).toBeGreaterThan(Number(a?.getAttribute('y')));
    expect(a?.getAttribute('height')).toBe(b?.getAttribute('height'));
    expect(Number(b?.getAttribute('width'))).toBeGreaterThan(Number(a?.getAttribute('width')));
    // No unit prop is percent on the site.
    expect(texts(svg, '.mdx-bar-value')).toEqual(['12%', '30%']);
  });

  it("puts a horizontal bar's sublabel under its name, and says the site drops it on vertical bars", () => {
    const src = (orientation: string) =>
      `<Chart orientation="${orientation}" unit="h" width={600} data={[{ label: "Harborlight", sublabel: "Jan–Mar 2025", value: 12 }, { label: "Saltmarsh", value: 30 }]} />\n`;
    mount(src('horizontal'));
    const svg = views()[0]?.querySelector('svg.mdx-chart[data-chart="bar"]');
    expect(svg?.getAttribute('width')).toBe('600');
    expect(svg?.hasAttribute('data-sublabels')).toBe(true);
    expect(texts(svg, '.mdx-bar-sublabel')).toEqual(['Jan–Mar 2025']);
    expect(texts(svg, '.mdx-bar-value')).toEqual(['12h', '30h']);
    const row = svg?.querySelector('.mdx-bar-row');
    const name = row?.querySelector('.mdx-bar-label');
    const sub = row?.querySelector('.mdx-bar-sublabel');
    const bar = row?.querySelector('rect.mdx-bar');
    // Under the name, right-aligned with it, left of the bar.
    expect(Number(sub?.getAttribute('y'))).toBeGreaterThan(Number(name?.getAttribute('y')));
    expect(sub?.getAttribute('text-anchor')).toBe('end');
    expect(Number(sub?.getAttribute('x'))).toBeLessThan(Number(bar?.getAttribute('x')));
    // Any other unit gives the axis 15% of headroom over the longest bar.
    const ticks = texts(svg, '.mdx-grid text').map((t) => Number.parseFloat(t ?? ''));
    expect(Math.max(...ticks)).toBeLessThanOrEqual(34.5);
    expect(views()[0]?.querySelector('.mdx-chart-note')).toBeNull();

    mount(src('vertical'));
    expect(views()[1]?.querySelector('.mdx-bar-sublabel')).toBeNull();
    expect(texts(views()[1], '.mdx-chart-site-ignores')).toEqual([
      'The site draws nothing for: data[].sublabel',
    ]);
  });

  it('names every prop the preview does not draw, under the chart', () => {
    mount(
      '<Chart legend="right" tone={theme} data={[{ label: "Harborlight", value: 3, note: "x" }, { label: "Kiln", value: 4, color: "url(https://example.invalid/x)" }]} />\n',
    );
    expect(texts(views()[0], '.mdx-chart-ignored')).toEqual([
      'Preview ignores: legend, tone, data[].note, data[].color',
    ]);
    mount(
      '<LineChart yScale="log" smooth events={[{ x: 2, label: "Launch", kind: "release" }]} series={[{ label: "A", colour: "red", values: [{ x: 1, y: 1 }, { x: 3, y: 900 }] }]} />\n',
    );
    expect(texts(views()[1], '.mdx-chart-ignored')).toEqual([
      'Preview ignores: smooth, series[].colour, yScale, events[].kind',
    ]);
  });

  it("keeps a negative vertical bar's value clear of its label", () => {
    mount(
      '<Chart orientation="vertical" data={[{ label: "Up", value: 5 }, { label: "Down", value: -4 }]} />\n',
    );
    const svg = views()[0]?.querySelector('svg.mdx-chart');
    const value = svg?.querySelectorAll('.mdx-bar-value')[1];
    const label = svg?.querySelectorAll('.mdx-bar-label')[1];
    expect(value?.textContent).toBe('-4%');
    // Baselines at least one 12px line apart.
    expect(
      Number(label?.getAttribute('y')) - Number(value?.getAttribute('y')),
    ).toBeGreaterThanOrEqual(14);
  });

  it("puts a negative horizontal bar's value beside its negative end, clear of its label", () => {
    mount(
      '<Chart orientation="horizontal" data={[{ label: "Riverbend", value: 6 }, { label: "Saltmarsh", value: -4 }]} />\n',
    );
    const svg = views()[0]?.querySelector('svg.mdx-chart[data-chart="bar"]');
    const num = (e: Element | undefined, a: string) => Number(e?.getAttribute(a));
    const [upBar, downBar] = [...(svg?.querySelectorAll('rect.mdx-bar') ?? [])];
    const [upValue, downValue] = [...(svg?.querySelectorAll('.mdx-bar-value') ?? [])];
    const downLabel = svg?.querySelectorAll('.mdx-bar-label')[1];
    expect(downValue?.textContent).toBe('-4%');
    // The positive value starts past its bar's right end...
    expect(upValue?.getAttribute('text-anchor') ?? 'start').toBe('start');
    expect(num(upValue, 'x')).toBeGreaterThan(num(upBar, 'x') + num(upBar, 'width'));
    // ...and the negative one ends before its bar's left end, where the bar stops.
    expect(downValue?.getAttribute('text-anchor')).toBe('end');
    expect(num(downValue, 'x')).toBeLessThan(num(downBar, 'x'));
    expect(num(downValue, 'x')).toBeGreaterThan(num(downBar, 'x') - 12);
    // Its two glyphs (about 7px each) still end right of the row's label.
    expect(num(downValue, 'x') - 2 * 7).toBeGreaterThan(num(downLabel, 'x'));
  });

  it('keeps every bar of a narrow horizontal chart inside it, and an all-negative one uses its width', () => {
    const row = (label: string, value: number) => `{ label: "${label}", value: ${value} }`;
    const chart = (unit: string, ...rows: string[]) =>
      `<Chart orientation="horizontal" unit="${unit}" data={[${rows.join(', ')}]} />`;
    const allNegative = chart('crossings', row('Saltmarsh landing', -12000), row('Kiln wharf', -3));
    // Value labels too long for a gutter on each side of a 240px chart.
    const mixed = chart(
      'passenger crossings',
      row('Saltmarsh landing', -12000),
      row('Riverbend pier', 18000),
    );
    for (const [src, width] of [240, 300, 430].flatMap((w) => [
      [allNegative, w] as const,
      [mixed, w] as const,
    ])) {
      const host = document.createElement('div');
      renderMdxSummary(host, summarizeMdx(src), width);
      const bars = [...host.querySelectorAll('rect.mdx-bar')].map((r) => {
        const x = Number(r.getAttribute('x'));
        return { left: x, right: x + Number(r.getAttribute('width')) };
      });
      expect(bars).toHaveLength(2);
      for (const bar of bars) {
        expect(bar.left).toBeGreaterThanOrEqual(0);
        expect(bar.right).toBeLessThanOrEqual(width);
      }
      // ...and the bars still span enough room to tell a long one from a short one.
      const span = Math.max(...bars.map((b) => b.right)) - Math.min(...bars.map((b) => b.left));
      expect(span).toBeGreaterThanOrEqual(40);
      // No value sits right of an all-negative chart, so its bars reach the edge.
      if (src === allNegative) {
        expect(Math.max(...bars.map((b) => b.right))).toBeGreaterThan(width - 8);
      }
    }
  });
});
