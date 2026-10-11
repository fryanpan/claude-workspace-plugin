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
type Box = {
  text: string;
  a: number;
  b: number;
  top: number;
  bottom: number;
  anchor: string;
  size: number;
};

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
    const size = Number(g.getAttribute('font-size') ?? LINE);
    return [...g.querySelectorAll('text')].map((t) => {
      const [x, y] = translate(t);
      const text = t.firstChild?.textContent ?? '';
      const w = text.length * CH * (size / LINE);
      const a = anchor === 'end' ? x + dx - w : x + dx;
      return { text, a, b: a + w, top: y + dy - size / 2, bottom: y + dy + size / 2, anchor, size };
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

/** The all-modes chart: three bands under 10 of 160 in places, about 20px. */
const THIN: Record<string, number[]> = {
  'Car passenger': [95, 100, 105, 110, 112],
  'Teen driver': [12, 9, 7, 5, 4],
  Walking: [30, 27, 24, 22, 20],
  Biking: [3, 5, 7, 9, 8],
  Other: [3, 4, 4, 5, 5],
};
const THIN_ORDER = Object.keys(THIN);
const THREE_THIN = {
  data: {
    rows: [2005, 2010, 2015, 2020, 2025].flatMap((year, i) =>
      THIN_ORDER.map((mode) => ({ year, mode, n: THIN[mode]?.[i] ?? 0 })),
    ),
  },
  options: { height: 380, y: { domain: [0, 160] } },
  preset: { ...FIVE.preset, order: THIN_ORDER },
};

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

  // Each is a chart whose pixels the preset cannot know before Plot draws it.
  it.each([
    ['reverses y', { options: { height: 380, y: { reverse: true } } }],
    ['insets the plot', { options: { height: 380, insetTop: 10 } }],
    [
      'stacks a negative value',
      { data: { rows: PRESET_SPEC.data.rows.map((r, i) => (i === 1 ? { ...r, n: -2 } : r)) } },
    ],
  ])('keeps the end labels when the spec %s', (_label, over) => {
    const svg = at({ ...PRESET_SPEC, ...over });
    const lines = [...svg.querySelectorAll('[aria-label="text"] text[fill]')].map((t) =>
      [...t.querySelectorAll('tspan')].map((s) => s.textContent),
    );
    expect(lines).toContainEqual(['Walking', '19']);
  });
});

describe('a stackedArea chart with three thin bands at 430px', () => {
  const svg = () => at(THREE_THIN);

  it('names every band, no two labels overlapping', () => {
    const all = boxes(svg());
    expect(all.map((l) => l.text).sort()).toEqual([...THIN_ORDER].sort());
    expect(overlaps(all)).toEqual([]);
  });

  it('sets a band too thin for 13px at 11px, or along the band where it is thickest', () => {
    const all = Object.fromEntries(boxes(svg()).map((l) => [l.text, l]));
    expect(all['Teen driver']?.size).toBe(11);
    expect(all.Biking).toMatchObject({ size: 13, anchor: 'start' });
    // Biking is thickest at 2020, well inside the plot, not at either end.
    expect(all.Biking?.a).toBeGreaterThan(200);
    expect(outsideBand(svg(), THIN_ORDER)).toEqual(['Other']);
  });

  it('sets the top band’s label just above it when the band cannot hold it', () => {
    const drawn = svg();
    const other = boxes(drawn).find((l) => l.text === 'Other');
    const band = bands(drawn).at(-1);
    if (!other || !band) throw new Error('no Other label or band');
    for (const x of [other.a, other.b]) {
      expect(other.bottom).toBeLessThanOrEqual(edgeAt(band.top, x));
      expect(edgeAt(band.top, x) - other.bottom).toBeLessThan(4);
    }
    expect(other.top).toBeGreaterThanOrEqual(20);
  });
});

/**
 * Shaped like the school-trips charts on prod: school years ticked every
 * fifth, a Biking band 40-60px thick in the middle years and a few px at
 * both ends, and a goal, drawn 371px wide.
 */
const SSC_YEARS = Array.from({ length: 21 }, (_, i) => 2005 + i);
const SSC_BIKING = [1, 1, 2, 3, 5, 8, 11, 13, 14, 14, 13, 12, 10, 8, 6, 4, 3, 2, 1, 1, 1];
const SSC = {
  data: {
    rows: SSC_YEARS.flatMap((year, i) => [
      { year, mode: 'Walking', n: 43 - i * 1.2 },
      { year, mode: 'Biking', n: SSC_BIKING[i] ?? 0 },
    ]),
  },
  options: { height: 380, y: { domain: [0, 80] }, x: { ticks: [2005, 2010, 2015, 2020, 2025] } },
  preset: {
    ...PRESET,
    format: { x: 'schoolYear' },
    goal: { value: 16, label: 'Safe Routes goal, 16 a year' },
  },
};

/** How far each text reaches right: tick labels centred, at 8px a glyph. */
const rightmost = (svg: Element) =>
  Math.max(
    ...[...svg.querySelectorAll('[aria-label="x-axis tick label"] text')].map((t) => {
      const [x] = translate(t);
      const [dx] = translate(t.parentElement);
      return x + dx + ((t.textContent ?? '').length * 8) / 2;
    }),
    ...boxes(svg).map((l) => l.b),
  );

describe('a school-trips chart at 371px', () => {
  it('names Walking, Biking and the goal, Biking where its band is thick', () => {
    const svg = at(SSC, 371);
    const names = boxes(svg).map((l) => l.text);
    expect(names).toEqual(expect.arrayContaining(['Walking', 'Biking', SSC.preset.goal.label]));
    expect(outsideBand(svg, TWO_ORDER)).toEqual([]);
    expect(overlaps(boxes(svg))).toEqual([]);
  });

  it('keeps every text inside the SVG, the last school-year tick included', () => {
    const svg = at(SSC, 371);
    expect([...svg.querySelectorAll('text')].map((t) => t.textContent)).toContain('2025-26');
    expect(rightmost(svg)).toBeLessThanOrEqual(371);
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
