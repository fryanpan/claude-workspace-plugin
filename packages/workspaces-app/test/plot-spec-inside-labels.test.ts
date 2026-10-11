import { HOUSE, buildPlot } from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';
import { PRESET, PRESET_SPEC } from './fixtures/plot-chart.ts';

/**
 * Under 600px a stackedArea chart labels each series inside its own band and
 * the goal above its rule at the left, so the right margin goes back to the
 * data. Every assertion reads the SVG real Plot draws at 430px.
 */

type Pt = [number, number];
type Box = { text: string; a: number; b: number; top: number; bottom: number; anchor: string };

const CH = 7.5;
const LINE = 13;

const at = (spec: Parameters<typeof buildPlot>[1], width = 430) =>
  buildPlot(Plot, spec, { width }) as SVGSVGElement;

const translate = (el: Element | null): Pt => {
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(el?.getAttribute('transform') ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

/** Each area's top and bottom edges, bottom band first. */
const bands = (svg: Element) =>
  [...svg.querySelectorAll('[aria-label="area"] path')]
    .map((p) => {
      const pts = [...(p.getAttribute('d') ?? '').matchAll(/([\d.]+),([\d.]+)/g)].map(
        (m): Pt => [Number(m[1]), Number(m[2])],
      );
      const n = pts.length / 2;
      return { top: pts.slice(0, n), bottom: pts.slice(n).reverse() };
    })
    .sort((m, n) => (n.bottom[0]?.[1] ?? 0) - (m.bottom[0]?.[1] ?? 0));

/** A straight-segment edge's y at x. */
const edgeAt = (pts: Pt[], x: number) => {
  const k = Math.max(
    1,
    pts.findIndex(([px]) => px >= x),
  );
  const [x0, y0] = pts[k - 1] as Pt;
  const [x1, y1] = pts[k] as Pt;
  return x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
};

/** Every drawn text label's box: its estimated width, a line high. */
const boxes = (svg: Element): Box[] =>
  [...svg.querySelectorAll('[aria-label="text"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    const anchor = g.getAttribute('text-anchor') ?? 'start';
    return [...g.querySelectorAll('text')].map((t) => {
      const [x, y] = translate(t);
      const text = t.firstChild?.textContent ?? '';
      const w = text.length * CH;
      const a = anchor === 'end' ? x + dx - w : x + dx;
      return { text, a, b: a + w, top: y + dy - LINE / 2, bottom: y + dy + LINE / 2, anchor };
    });
  });

/** The labels that leave their own band anywhere along their width. */
const outsideBand = (svg: Element, order: string[]) => {
  const all = bands(svg);
  return boxes(svg)
    .filter((l) => order.includes(l.text))
    .filter((l) => {
      const band = all[order.indexOf(l.text)];
      if (!band) return true;
      const xs = [l.a, l.b, ...band.top.map(([x]) => x).filter((x) => x > l.a && x < l.b)];
      return xs.some((x) => edgeAt(band.top, x) > l.top || edgeAt(band.bottom, x) < l.bottom);
    })
    .map((l) => l.text);
};

/** Every pair of labels whose boxes share any area. */
const overlaps = (all: Box[]) =>
  all.flatMap((m, i) =>
    all
      .slice(i + 1)
      .filter((n) => m.a < n.b && n.a < m.b && m.top < n.bottom && n.top < m.bottom)
      .map((n) => [m.text, n.text]),
  );

const goalY = (svg: Element) =>
  Number(svg.querySelector('[aria-label="rule"] line')?.getAttribute('y1'));

/** Five modes, cars at the bottom and a thin "Other" band on top. */
const MODES: Record<string, number[]> = {
  Car: [52, 50, 47, 45, 41],
  Bus: [14, 15, 17, 18, 20],
  Walking: [20, 18, 16, 15, 14],
  Biking: [4, 6, 8, 10, 12],
  Other: [1, 1, 1, 1, 1],
};
const FIVE_ORDER = Object.keys(MODES);
const FIVE = {
  data: {
    rows: [2005, 2010, 2015, 2020, 2025].flatMap((year, i) =>
      FIVE_ORDER.map((mode) => ({ year, mode, n: MODES[mode]?.[i] ?? 0 })),
    ),
  },
  options: { height: 380 },
  preset: {
    type: 'stackedArea',
    data: 'rows',
    x: 'year',
    y: 'n',
    series: 'mode',
    order: FIVE_ORDER,
  },
};

const TWO_ORDER = ['Walking', 'Biking'];

describe('a stackedArea chart at 430px', () => {
  it('names each series inside its own band, on one line with no value', () => {
    const svg = at(PRESET_SPEC);
    const names = boxes(svg).map((l) => l.text);
    expect(names).toEqual(expect.arrayContaining(TWO_ORDER));
    expect(svg.querySelectorAll('[aria-label="text"] tspan')).toHaveLength(0);
    expect(outsideBand(svg, TWO_ORDER)).toEqual([]);
    expect(overlaps(boxes(svg))).toEqual([]);
  });

  it('puts each label at the end where its band is thicker', () => {
    const svg = at(PRESET_SPEC);
    const side = Object.fromEntries(boxes(svg).map((l) => [l.text, l.anchor]));
    // Walking is thickest at 2005, Biking at 2025.
    expect(side).toMatchObject({ Walking: 'start', Biking: 'end' });
  });

  it('sets the goal’s label above its rule at the left, its text only', () => {
    const svg = at(PRESET_SPEC);
    const goal = boxes(svg).find((l) => l.text === PRESET.goal.label);
    const plotLeft = Math.min(...(bands(svg)[0]?.bottom.map(([x]) => x) ?? []));
    expect(goal?.a).toBeGreaterThanOrEqual(plotLeft);
    expect(goal?.a).toBeLessThan(plotLeft + 8);
    expect(goal?.bottom).toBeLessThan(goalY(svg));
  });

  it('gives the right margin back to the data', () => {
    const svg = at(PRESET_SPEC);
    const right = Math.max(...(bands(svg)[0]?.bottom.map(([x]) => x) ?? []));
    expect(430 - right).toBeLessThanOrEqual(24);
  });

  it('draws the labels in the house ink with the paper halo, not the series colour', () => {
    const svg = at(PRESET_SPEC);
    for (const g of svg.querySelectorAll('[aria-label="text"]')) {
      expect(g.getAttribute('fill')).toBe(HOUSE.ink);
      expect(g.getAttribute('stroke')).toBe(HOUSE.paper);
    }
  });

  it('labels five bands without overlap and leaves a band too thin for its name unlabelled', () => {
    const svg = at(FIVE);
    const names = boxes(svg).map((l) => l.text);
    expect(names.sort()).toEqual(['Biking', 'Bus', 'Car', 'Walking']);
    expect(outsideBand(svg, FIVE_ORDER)).toEqual([]);
    expect(overlaps(boxes(svg))).toEqual([]);
  });

  it('keeps every label clear of the goal’s rule', () => {
    const goalAcross = { ...FIVE, preset: { ...FIVE.preset, goal: { value: 60, label: 'Goal' } } };
    const svg = at(goalAcross);
    const y = goalY(svg);
    const all = boxes(svg);
    expect(all.filter((l) => l.top < y && l.bottom > y)).toEqual([]);
    expect(outsideBand(svg, FIVE_ORDER)).toEqual([]);
    expect(overlaps(all)).toEqual([]);
  });

  it('keeps the end labels when the spec reverses y, whose pixels it cannot know here', () => {
    const svg = at({ ...PRESET_SPEC, options: { height: 380, y: { reverse: true } } });
    const lines = [...svg.querySelectorAll('[aria-label="text"] text[fill]')].map((t) =>
      [...t.querySelectorAll('tspan')].map((s) => s.textContent),
    );
    expect(lines).toContainEqual(['Walking', '19']);
  });
});

describe('the checks above, against a chart drawn wrong', () => {
  it('reports a label moved out of its band, and two labels drawn over each other', () => {
    const svg = at(PRESET_SPEC);
    const [walking] = bands(svg);
    const biking = [...svg.querySelectorAll('[aria-label="text"] text')].find(
      (t) => t.textContent === 'Biking',
    );
    if (!walking || !biking) throw new Error('the chart drew no Walking band or Biking label');
    const [x] = translate(biking);
    const [, dy] = translate(biking.parentElement);
    const mid = (edgeAt(walking.top, x - 30) + edgeAt(walking.bottom, x - 30)) / 2;
    biking.setAttribute('transform', `translate(${x},${mid - dy})`);
    expect(outsideBand(svg, TWO_ORDER)).toEqual(['Biking']);
    const [one] = boxes(svg);
    if (!one) throw new Error('no labels');
    expect(overlaps([one, { ...one, text: 'copy' }])).toHaveLength(1);
  });
});
