import {
  PLOT_DEFAULT_HEIGHT,
  buildPlot,
  plotHeight,
  renderPlot,
} from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKS, PRESET_SPEC, ROWS, SPEC } from './fixtures/plot-chart.ts';

/**
 * How big a chart draws, and how its years read. A chart is drawn at its
 * container's width and the spec's height, and drawn again when the width
 * changes, so a narrow column gets a narrower chart with the same 13px text
 * rather than a scaled-down one. The ResizeObserver and the frame are faked:
 * happy-dom lays nothing out.
 */

const svgIn = (el: Element) => el.querySelector('svg') as SVGSVGElement;
const ticks = (svg: Element, axis: 'x' | 'y') =>
  [...svg.querySelectorAll(`[aria-label="${axis}-axis tick label"] text`)].map(
    (t) => t.textContent,
  );

describe('year axes', () => {
  it('ticks whole-number years without a thousands comma, in both forms', () => {
    for (const spec of [SPEC, PRESET_SPEC]) {
      const x = ticks(buildPlot(Plot, spec), 'x');
      expect(x).toContain('2010');
      expect(x.join(' ')).not.toMatch(/\d,\d/);
    }
  });

  it('reads "d" from the spec, and leaves a spec’s own format alone', () => {
    const own = buildPlot(Plot, {
      ...SPEC,
      options: { ...SPEC.options, x: { tickFormat: 'schoolYear' } },
    });
    expect(ticks(own, 'x')).toContain('2010-11');
    const d = buildPlot(Plot, { ...SPEC, options: { ...SPEC.options, x: { tickFormat: 'd' } } });
    expect(ticks(d, 'x')).toContain('2010');
  });

  it('keeps the thousands comma on whole numbers that are not years', () => {
    const rows = [5000, 10000, 20000].map((x, i) => ({ x, y: i }));
    const svg = buildPlot(Plot, {
      data: { rows },
      marks: [{ mark: 'dot', data: 'rows', options: { x: 'x', y: 'y' } }],
    });
    expect(ticks(svg, 'x')).toContain('10,000');
  });
});

describe('plotHeight, known before Plot loads', () => {
  it('is the spec’s height, a row per bar, or the default', () => {
    expect(plotHeight(SPEC)).toBe(380);
    expect(plotHeight({ marks: MARKS })).toBe(PLOT_DEFAULT_HEIGHT);
    const bars = {
      data: { rows: [{ k: 'Riverbend' }, { k: 'Harborlight' }, { k: 'Saltmarsh' }] },
      preset: { type: 'barsH', data: 'rows', label: 'k', value: 'v' },
    };
    expect(plotHeight(bars)).toBe(3 * 36 + 50);
    expect(plotHeight('not a spec')).toBe(PLOT_DEFAULT_HEIGHT);
  });

  it('is the height the chart draws at', () => {
    const bars = {
      data: { rows: [{ k: 'Riverbend', v: 3 }] },
      preset: { type: 'barsH', data: 'rows', label: 'k', value: 'v' },
    };
    for (const spec of [SPEC, { data: { rows: ROWS }, marks: MARKS }, bars]) {
      const svg = svgIn(wrap(buildPlot(Plot, spec)));
      expect(svg.getAttribute('height')).toBe(String(plotHeight(spec)));
      expect(svg.style.height).toBe(`${plotHeight(spec)}px`);
      expect(svg.style.width).toBe('100%');
    }
  });
});

/** The chart's SVG, whether Plot returned it bare or in a figure. */
function wrap(el: Element): Element {
  const box = document.createElement('div');
  box.append(el);
  return box;
}

describe('renderPlot draws at its container’s width', () => {
  let observers: Array<{ cb: () => void; targets: Element[]; live: boolean }>;
  let frames: Array<() => void>;
  const realObserver = window.ResizeObserver;
  const realFrame = window.requestAnimationFrame;

  beforeEach(() => {
    observers = [];
    frames = [];
    window.ResizeObserver = class {
      rec: { cb: () => void; targets: Element[]; live: boolean };
      constructor(cb: () => void) {
        this.rec = { cb, targets: [], live: true };
        observers.push(this.rec);
      }
      observe(el: Element) {
        this.rec.targets.push(el);
      }
      unobserve() {}
      disconnect() {
        this.rec.live = false;
      }
    } as unknown as typeof ResizeObserver;
    window.requestAnimationFrame = ((f: () => void) => {
      frames.push(f);
      return frames.length;
    }) as typeof requestAnimationFrame;
  });
  afterEach(() => {
    window.ResizeObserver = realObserver;
    window.requestAnimationFrame = realFrame;
    document.body.replaceChildren();
  });

  /** A container that reports `width` as its laid-out width. */
  function column(width: number): HTMLElement & { width: number } {
    const el = Object.assign(document.createElement('div'), { width });
    Object.defineProperty(el, 'clientWidth', { get: () => el.width });
    document.body.append(el);
    return el;
  }
  const resize = (el: HTMLElement & { width: number }, width: number) => {
    el.width = width;
    for (const o of observers) if (o.live && o.targets.includes(el)) o.cb();
  };
  const flush = () => {
    const due = frames.splice(0);
    for (const f of due) f();
  };

  it('holds the spec’s height and draws at the column’s width', () => {
    const el = column(430);
    renderPlot(Plot, el, SPEC);
    expect(el.style.height).toBe('380px');
    const svg = svgIn(el);
    expect(svg.getAttribute('width')).toBe('430');
    expect(svg.getAttribute('viewBox')).toBe('0 0 430 380');
    // Narrower, not smaller: the text keeps its size.
    expect(svg.style.fontSize).toBe('13px');
  });

  it('draws again at the new width, once a frame, keeping the height', () => {
    const el = column(820);
    renderPlot(Plot, el, SPEC);
    const first = svgIn(el);
    resize(el, 600);
    resize(el, 500);
    expect(svgIn(el)).toBe(first);
    expect(frames).toHaveLength(1);
    flush();
    const now = svgIn(el);
    expect(now).not.toBe(first);
    expect(now.getAttribute('width')).toBe('500');
    expect(now.getAttribute('height')).toBe('380');
    expect(el.style.height).toBe('380px');
  });

  it('does not draw again when the width did not change', () => {
    const el = column(700);
    renderPlot(Plot, el, SPEC);
    const first = svgIn(el);
    resize(el, 700);
    flush();
    expect(svgIn(el)).toBe(first);
  });

  it('keeps one observer per element, redrawing from the latest spec', () => {
    const el = column(700);
    renderPlot(Plot, el, SPEC);
    renderPlot(Plot, el, { ...SPEC, options: { ...SPEC.options, height: 300 } });
    expect(observers).toHaveLength(1);
    resize(el, 400);
    flush();
    expect(svgIn(el).getAttribute('height')).toBe('300');
    expect(el.style.height).toBe('300px');
  });

  it('stops observing an element once it leaves the page', () => {
    const el = column(700);
    renderPlot(Plot, el, SPEC);
    el.remove();
    resize(el, 300);
    expect(observers[0]?.live).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('lets an error box take its own height', () => {
    const el = column(700);
    renderPlot(Plot, el, SPEC);
    renderPlot(Plot, el, { ...SPEC, marks: [{ mark: 'geo', data: 'rows' }] });
    expect(el.querySelector('.plot-spec-error')).not.toBeNull();
    expect(el.style.height).toBe('');
  });

  it('draws at the spec’s width where the element has no width yet', () => {
    const el = column(0);
    renderPlot(Plot, el, SPEC);
    expect(svgIn(el).getAttribute('width')).toBe('820');
  });
});
