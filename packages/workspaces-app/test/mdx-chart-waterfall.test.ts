import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { wrap } from '../src/mdx-chart-waterfall.ts';
import type { WaterfallChart } from '../src/mdx-chart.ts';
import { summarizeMdx } from '../src/mdx-preview.ts';
import { WATERFALL } from './fixtures/mdx-charts.ts';

/**
 * A waterfall (`mdx-chart-waterfall.ts`): the props read into running totals,
 * and the drawing's bars spanning them on the page.
 */

const waterfall = (src: string): WaterfallChart | undefined => {
  const chart = summarizeMdx(src).chart;
  return chart?.type === 'waterfall' ? chart : undefined;
};
const ranges = (c: WaterfallChart | undefined) =>
  c?.bars.map((b) => [b.kind, Number(b.from.toFixed(6)), Number(b.to.toFixed(6))]);

describe('reading a waterfall', () => {
  it('floats each step from the running total before it to the one after', () => {
    const c = waterfall(WATERFALL);
    expect(c?.unit).toBe('%');
    expect(c?.baseline).toBe(30);
    expect(c?.baselineLabel).toBe('Goal');
    expect(c?.ignored).toEqual([]);
    expect(ranges(c)).toEqual([
      ['start', 0, 48.6],
      ['step', 48.6, 44.4],
      ['step', 44.4, 41.3],
      ['step', 41.3, 36.3],
      ['step', 36.3, 37.8],
      ['step', 37.8, 35],
      ['step', 35, 31],
      // The end's given value is drawn as written.
      ['end', 0, 31],
    ]);
  });

  it('draws an end with no value at the running total, and a given one as written', () => {
    const rows = (end: string) =>
      `<Chart type="waterfall" data={[{ label: "Riverbend", value: 10, kind: "start" }, { label: "Bob", value: -3, kind: "step" }, ${end}, { label: "Alice", value: 2, kind: "step" }]} />`;
    expect(ranges(waterfall(rows('{ label: "After", kind: "end" }')))).toEqual([
      ['start', 0, 10],
      ['step', 10, 7],
      ['end', 0, 7],
      ['step', 7, 9],
    ]);
    // A stated end that disagrees with the steps wins, and later steps run from it.
    expect(ranges(waterfall(rows('{ label: "After", value: 8, kind: "end" }')))?.slice(2)).toEqual([
      ['end', 0, 8],
      ['step', 8, 10],
    ]);
  });

  it("is read by its rows' kind alone, and names a prop or key it does not draw", () => {
    const c = waterfall(
      '<Chart colour="red" data={[{ label: "Saltmarsh", value: 5, kind: "start", note: "x" }, { label: "Up", value: 1, kind: "step" }]} />',
    );
    expect(ranges(c)).toEqual([
      ['start', 0, 5],
      ['step', 5, 6],
    ]);
    expect(c?.ignored.sort()).toEqual(['colour', 'data[].note']);
  });

  it('draws nothing for a malformed waterfall, rather than bars from zero', () => {
    for (const data of [
      '[{ label: "A", value: 5, kind: "start" }, { label: "B", kind: "step" }]',
      '[{ label: "A", value: 5, kind: "start" }, { label: "B", value: 1, kind: "middle" }]',
      '[{ label: "A", value: 5, kind: "start" }, { label: "B", value: 1 }]',
      '[{ value: 5, kind: "start" }]',
      '[{ label: "A", value: n, kind: "start" }]',
      '[]',
    ]) {
      expect(summarizeMdx(`<Chart type="waterfall" data={${data}} />`).chart).toBeUndefined();
    }
    // Its title still shows, as for any chart the preview cannot draw.
    expect(summarizeMdx('<Chart type="waterfall" title="Riverbend" data={rows} />').title).toBe(
      'Riverbend',
    );
  });

  it('wraps a long name at spaces and never cuts it, however many lines it takes', () => {
    expect(wrap('Lever one shifts the Riverbend crossings onto the morning ferry', 24)).toEqual([
      'Lever one shifts the',
      'Riverbend crossings onto',
      'the morning ferry',
    ]);
    const ten = 'one two three four five six seven eight nine ten';
    const lines = wrap(ten, 9);
    expect(lines.join(' ')).toBe(ten);
    expect(lines.some((l) => l.includes('…'))).toBe(false);
    // A word wider than a line is split across lines, not clipped.
    expect(wrap('Harborlight-Riverbend-Saltmarsh', 12).join('')).toBe(
      'Harborlight-Riverbend-Saltmarsh',
    );
  });
});

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

const num = (e: Element | null | undefined, a: string) => Number(e?.getAttribute(a));

describe('a waterfall block on the doc page', () => {
  for (const width of [640, 430, 390]) {
    it(`draws each bar across its running totals, every bar valued, the goal at 30 (${width}px)`, () => {
      mount(`${WATERFALL.replace('unit="%"', `unit="%" width={${width}}`)}\n`);
      const svg = document.querySelector(
        '.ProseMirror .mdx-view svg.mdx-chart[data-chart="waterfall"]',
      );
      expect(svg).not.toBeNull();
      const rows = [...(svg?.querySelectorAll('.mdx-bar-row') ?? [])];
      expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual([
        'start',
        'step',
        'step',
        'step',
        'step',
        'step',
        'step',
        'end',
      ]);
      // The value axis, read off the drawing: x at 0 and at the last tick.
      const grid = [...(svg?.querySelectorAll('.mdx-grid line') ?? [])];
      const ticks = [...(svg?.querySelectorAll('.mdx-grid text') ?? [])].map((t) =>
        Number.parseFloat(t.textContent ?? ''),
      );
      const x0 = num(grid[0], 'x1');
      const xN = num(grid.at(-1), 'x1');
      const sx = (v: number) => x0 + (v / (ticks.at(-1) ?? 1)) * (xN - x0);
      expect(ticks[0]).toBe(0);

      const spans = [
        [0, 48.6],
        [44.4, 48.6],
        [41.3, 44.4],
        [36.3, 41.3],
        [36.3, 37.8],
        [35, 37.8],
        [31, 35],
        [0, 31],
      ];
      rows.forEach((row, i) => {
        const rect = row.querySelector('rect.mdx-bar');
        const [a, z] = spans[i] ?? [0, 0];
        expect(num(rect, 'x')).toBeCloseTo(sx(a ?? 0), 1);
        expect(num(rect, 'x') + num(rect, 'width')).toBeCloseTo(sx(z ?? 0), 1);
        // Each row sits below the one before it.
        if (i > 0) {
          const prev = rows[i - 1]?.querySelector('rect.mdx-bar');
          expect(num(rect, 'y')).toBeGreaterThan(num(prev, 'y') + num(prev, 'height'));
        }
        // No value label runs past the chart's own edge.
        expect(sx(z ?? 0) + 6 + 7.5 * 6).toBeLessThanOrEqual(width);
      });
      expect(rows.map((r) => r.querySelector('.mdx-bar-value')?.textContent)).toEqual([
        '48.6%',
        '−4.2%',
        '−3.1%',
        '−5%',
        '+1.5%',
        '−2.8%',
        '−4%',
        '31%',
      ]);
      // Decreases and increases are told apart, totals in the bar chart's fill.
      const fills = rows.map((r) => r.querySelector('rect.mdx-bar')?.getAttribute('fill'));
      expect(new Set([fills[1], fills[2], fills[3], fills[5], fills[6]]).size).toBe(1);
      expect(fills[4]).not.toBe(fills[1]);
      expect(fills[0]).toBe(fills[7]);
      expect(fills[0]).not.toBe(fills[1]);

      const goal = svg?.querySelector('.mdx-baseline line');
      expect(num(goal, 'x1')).toBeCloseTo(sx(30), 1);
      expect(num(goal, 'x2')).toBeCloseTo(sx(30), 1);
      expect(svg?.querySelector('.mdx-baseline-label')?.textContent).toBe('Goal 30%');
      // A ten-word lever wraps on a phone rather than being cut, and keeps
      // one line where the chart is wide enough to hold it.
      const names = rows[1]?.querySelectorAll('.mdx-bar-label tspan') ?? [];
      expect(names.length).toBe(width <= 430 ? 2 : 1);
      expect([...names].map((t) => t.textContent).join(' ')).toBe(
        'Lever one shifts the Riverbend crossings onto the morning ferry',
      );
      // Every name is whole across its lines, at most two of them, never cut.
      const labels = [...WATERFALL.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
      rows.forEach((row, i) => {
        const parts = [...row.querySelectorAll('.mdx-bar-label tspan')].map((t) => t.textContent);
        expect(parts.join(' ')).toBe(labels[i]);
        expect(parts.length).toBeLessThanOrEqual(2);
        expect(parts.join('')).not.toContain('…');
      });
    });
  }
});
