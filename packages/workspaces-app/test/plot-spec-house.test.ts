import {
  HOUSE,
  PlotSpecError,
  buildPlot,
  hasPointer,
  plotFormat,
  renderPlot,
} from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';
import { MARKS, PRESET_SPEC, ROWS, SPEC } from './fixtures/plot-chart.ts';

/**
 * The house style `plot-spec.mjs` applies to every chart so no renderer adds
 * its own, the named formats a spec uses in place of functions, and
 * `renderPlot`, the one call the sites and the board both make. Asserted on
 * the SVG real Plot draws. Whether the CSS variables resolve is a browser's
 * question, measured in the PR rather than here: happy-dom computes no SVG
 * paint.
 */

const svgOf = (spec: Parameters<typeof buildPlot>[1]) => buildPlot(Plot, spec) as SVGSVGElement;
const attrs = (root: Element, sel: string, name: string) =>
  [...root.querySelectorAll(sel)].map((n) => n.getAttribute(name));

describe('the house style', () => {
  const svg = svgOf({ data: { rows: ROWS }, marks: MARKS.slice(0, 3) });

  it('sets the chart in the house font at 13px, over the paper colour', () => {
    expect(svg.style.fontFamily).toBe(
      'var(--chart-font, system-ui, -apple-system, "Segoe UI", sans-serif)',
    );
    expect(svg.style.fontSize).toBe('13px');
    expect(svg.style.getPropertyValue('--plot-background')).toBe(HOUSE.paper);
  });

  it('draws a dashed y grid in the rule colour under a solid zero line', () => {
    const grid = svg.querySelector('[aria-label="y-grid"]');
    expect(grid?.getAttribute('stroke')).toBe(HOUSE.rule);
    expect(grid?.getAttribute('stroke-dasharray')).toBe('2 4');
    // The zero line is the rule in the rule colour; the spec's own goal is ink.
    const zero = svg.querySelector(`[aria-label="rule"] [stroke="${HOUSE.rule}"]`);
    expect(zero).not.toBeNull();
    expect(zero?.getAttribute('stroke-dasharray')).toBeNull();
    expect(zero?.closest('[aria-label="rule"]')?.getAttribute('clip-path')).toMatch(/^url\(/);
  });

  it('draws no tick marks and no axis labels, only the values', () => {
    expect(svg.querySelector('[aria-label="y-axis tick"]')).toBeNull();
    expect(svg.querySelector('[aria-label="x-axis tick"]')).toBeNull();
    expect(svg.querySelector('[aria-label="y-axis label"]')).toBeNull();
    expect(svg.querySelector('[aria-label="x-axis label"]')).toBeNull();
    expect(svg.querySelectorAll('[aria-label="y-axis tick label"] text').length).toBeGreaterThan(2);
  });

  it('haloes text in the paper colour, three wide', () => {
    const text = svg.querySelector('[aria-label="text"]');
    expect(text?.getAttribute('stroke')).toBe(HOUSE.paper);
    expect(text?.getAttribute('stroke-width')).toBe('3');
    expect(text?.getAttribute('fill')).toBe(HOUSE.ink);
  });

  it('colours series from the house palette, as CSS variables', () => {
    const fills = attrs(svg, '[aria-label="area"] path', 'fill');
    expect(fills.sort()).toEqual([HOUSE.seq2, HOUSE.seq3].sort());
    expect(HOUSE.seq3).toBe('var(--seq-3, #2f7d76)');
  });

  it('gives way to the spec: its own palette, font size, grid and a tick format', () => {
    const own = svgOf({
      ...SPEC,
      options: { ...SPEC.options, style: { fontSize: '16px' }, grid: true },
    });
    expect(own.style.fontSize).toBe('16px');
    expect(attrs(own, '[aria-label="area"] path', 'fill')).toEqual(['#2f7d76', '#c8a25e']);
    // Plot's own grid, not the house's dashed one.
    expect(own.querySelector('[aria-label="y-grid"]')?.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('keeps one fixed size, scaled by CSS', () => {
    expect(svg.getAttribute('width')).toBe('640');
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 400');
  });
});

describe('named formats', () => {
  it.each([
    ['int', 2005.6, '2006'],
    ['int', 12000, '12000'],
    ['comma', 12345.678, '12,345.68'],
    ['pct', 43, '43%'],
    ['pct', 12.25, '12.3%'],
    ['usd', 1200, '$1,200'],
    ['usd', 12.5, '$12.50'],
    ['schoolYear', 2005, '2005-06'],
    ['schoolYear', 2099, '2099-00'],
  ])('%s formats %s as %s', (name, v, want) => {
    expect(plotFormat(name)(v)).toBe(want);
  });

  it('formats an axis by name', () => {
    const svg = svgOf({ ...SPEC, options: { ...SPEC.options, x: { tickFormat: 'schoolYear' } } });
    const ticks = [...svg.querySelectorAll('[aria-label="x-axis tick label"] text')].map(
      (t) => t.textContent,
    );
    expect(ticks).toContain('2010-11');
  });

  it.each([
    ['an unknown axis format', { ...SPEC, options: { x: { tickFormat: '.2f' } } }],
    [
      'an unknown tip format',
      { ...SPEC, marks: [{ mark: 'tip', data: 'rows', options: { format: { y: 'hex' } } }] },
    ],
  ])('refuses %s, calling no Plot function', (_label, spec) => {
    let called = 0;
    const counting = new Proxy(Plot as unknown as Record<string, unknown>, {
      get: (t, k) => {
        const v = t[k as string];
        return typeof v === 'function'
          ? (...a: unknown[]) => {
              called++;
              return (v as (...x: unknown[]) => unknown)(...a);
            }
          : v;
      },
    });
    expect(() => buildPlot(counting, spec)).toThrow(PlotSpecError);
    try {
      buildPlot(counting, spec);
    } catch (err) {
      expect((err as PlotSpecError).code).toBe('unknown-format');
    }
    expect(called).toBe(0);
  });
});

describe('renderPlot, the call every page makes', () => {
  it('replaces what the element held with the chart', () => {
    const host = document.createElement('div');
    host.textContent = 'old';
    const fig = renderPlot(Plot, host, SPEC);
    expect(host.firstElementChild).toBe(fig);
    expect(host.textContent).toContain('Safe Routes goal, 16 a year');
    expect(host.textContent).not.toContain('old');
  });

  it('draws the error box in the chart’s place for a spec it refuses', () => {
    const host = document.createElement('div');
    renderPlot(Plot, host, SPEC);
    expect(renderPlot(Plot, host, { ...SPEC, marks: [{ mark: 'geo', data: 'rows' }] })).toBeNull();
    const box = host.querySelector('.plot-spec-error');
    expect(box?.getAttribute('role')).toBe('alert');
    expect(box?.textContent).toBe('Mark 1: unknown mark "geo"');
    expect(host.querySelector('svg')).toBeNull();
  });

  it('says which charts need the page to run: a pointer mark, or a preset with a tip', () => {
    expect(hasPointer(SPEC)).toBe(true);
    expect(hasPointer({ ...SPEC, marks: MARKS.slice(0, 3) })).toBe(false);
    expect(hasPointer(PRESET_SPEC)).toBe(true);
    expect(hasPointer({ preset: { type: 'barsH' } })).toBe(false);
  });
});
