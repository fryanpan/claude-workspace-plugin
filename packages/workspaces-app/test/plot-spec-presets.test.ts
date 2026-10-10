import { HOUSE, PlotSpecError, buildPlot, expandPreset } from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';
import { PRESET, PRESET_OPTIONS, PRESET_SPEC, ROWS, SPEC } from './fixtures/plot-chart.ts';

/**
 * The presets `plot-spec.mjs` expands into ordinary marks: stackedArea, lines
 * and barsH. Each is asserted twice, on the marks it expands into and on the
 * SVG real Plot draws from them.
 */

const svgOf = (spec: Parameters<typeof buildPlot>[1]) => buildPlot(Plot, spec) as SVGSVGElement;
const texts = (svg: Element, sel = 'text') =>
  [...svg.querySelectorAll(sel)].map((t) => t.textContent ?? '');

describe('stackedArea', () => {
  it('expands into the stacked areas, the goal, end labels and a stacked tip', () => {
    const { marks, options, grid } = expandPreset(PRESET_SPEC);
    expect(marks.map((m) => m.mark)).toEqual(['areaY', 'ruleY', 'text', 'text', 'tip']);
    expect(grid).toBe('y');
    expect(marks[0]).toMatchObject({ data: 'rows', transform: 'stackY' });
    // Each label sits at the last year, in the middle of its own band.
    expect(marks[3]?.data).toEqual([
      { x: 2025, y: 9.5, series: 'Walking', label: 'Walking 19' },
      { x: 2025, y: 23, series: 'Biking', label: 'Biking 8' },
    ]);
    expect(marks[4]).toMatchObject({ transform: 'stackY2', pointer: 'pointerX' });
    expect(options).toMatchObject({ width: 820, x: { tickFormat: 'd' }, y: { domain: [0, 80] } });
  });

  it('draws the example the marks form draws, labelled at its ends with no legend', () => {
    const svg = svgOf(PRESET_SPEC);
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelectorAll('[aria-label="area"] path')).toHaveLength(2);
    const all = texts(svg);
    expect(all).toEqual(
      expect.arrayContaining(['Walking 19', 'Biking 8', 'Safe Routes goal, 16 a year']),
    );
    // A year is not a quantity: no thousands separator on the axis.
    expect(texts(svg, '[aria-label="x-axis tick label"] text')).toContain('2010');
    expect(svg.querySelector('[aria-label="area"] path')?.getAttribute('fill')).toBe(HOUSE.seq3);
  });

  it('shows the series’ own value in its tip, not the stacked total', () => {
    const tip = expandPreset(PRESET_SPEC).marks[4];
    expect(tip?.options).toMatchObject({ channels: { n: 'n' }, format: { y: false } });
  });
});

const LINES = [
  { year: 2019, place: 'Harborlight', v: 100 },
  { year: 2021, place: 'Harborlight', v: 84 },
  { year: 2023, place: 'Harborlight', v: 112 },
  { year: 2019, place: 'Riverbend', v: 100 },
  { year: 2021, place: 'Riverbend', v: 91 },
  { year: 2023, place: 'Riverbend', v: 97 },
];

describe('lines', () => {
  const spec = {
    data: { rows: LINES },
    preset: {
      type: 'lines',
      data: 'rows',
      x: 'year',
      y: 'v',
      series: 'place',
      dashed: ['Riverbend'],
      goal: { value: 120, label: 'Target' },
      baseline: { value: 100, label: '2019 = 100' },
    },
  };

  it('expands into a solid and a dashed line, end dots and labels, the goal and the baseline', () => {
    const { marks } = expandPreset(spec);
    expect(marks.map((m) => m.mark)).toEqual([
      'ruleY',
      'text',
      'lineY',
      'lineY',
      'ruleY',
      'text',
      'dot',
      'text',
      'tip',
    ]);
    expect(marks[2]?.options?.strokeDasharray).toBeUndefined();
    expect(marks[3]?.options?.strokeDasharray).toBe('6 4');
    expect(marks[7]?.data).toEqual([
      { x: 2023, y: 112, series: 'Harborlight', label: 'Harborlight 112' },
      { x: 2023, y: 97, series: 'Riverbend', label: 'Riverbend 97' },
    ]);
  });

  it('starts an index chart at zero, with its baseline drawn, labelled and ticked', () => {
    const { options } = expandPreset(spec);
    expect(options.y).toMatchObject({ zero: true, ticks: [0, 20, 40, 60, 80, 100, 120] });
    const svg = svgOf(spec);
    const yTicks = texts(svg, '[aria-label="y-axis tick label"] text');
    expect(yTicks[0]).toBe('0');
    expect(yTicks).toContain('100');
    expect(texts(svg)).toEqual(
      expect.arrayContaining(['2019 = 100', 'Target', 'Harborlight 112', 'Riverbend 97']),
    );
    const dashed = [...svg.querySelectorAll('[aria-label="line"]')].filter(
      (g) => g.getAttribute('stroke-dasharray') === '6 4',
    );
    expect(dashed).toHaveLength(1);
  });

  it('runs a percent axis from 0 to 100 unless the spec sets a domain', () => {
    const pct = { ...spec, preset: { ...spec.preset, baseline: undefined, format: { y: 'pct' } } };
    expect(expandPreset(pct).options.y).toMatchObject({ domain: [0, 100], tickFormat: 'pct' });
    const own = { ...pct, options: { y: { domain: [40, 60] } } };
    expect(expandPreset(own).options.y).toMatchObject({ domain: [40, 60] });
    expect(texts(svgOf(pct), '[aria-label="y-axis tick label"] text')).toContain('100%');
  });
});

describe('barsH', () => {
  const spec = {
    data: {
      rows: [
        { name: 'Harborlight', cost: 1200, note: 'two crossings' },
        { name: 'Saltmarsh', cost: 450.5, note: 'one crossing' },
        { name: 'Riverbend', cost: 800, note: 'ferry' },
      ],
    },
    preset: {
      type: 'barsH',
      data: 'rows',
      label: 'name',
      value: 'cost',
      sublabel: 'note',
      format: { value: 'usd' },
    },
  };

  it('expands into bars in row order, values at their ends, names and sublabels', () => {
    const { marks, options, grid } = expandPreset(spec);
    expect(marks.map((m) => m.mark)).toEqual(['barX', 'text', 'text', 'text']);
    expect(grid).toBe('x');
    expect(options.y).toMatchObject({
      domain: ['Harborlight', 'Saltmarsh', 'Riverbend'],
      axis: null,
    });
    expect(marks[1]?.data).toEqual([
      { label: 'Harborlight', value: 1200, text: '$1,200' },
      { label: 'Saltmarsh', value: 450.5, text: '$450.50' },
      { label: 'Riverbend', value: 800, text: '$800' },
    ]);
  });

  it('draws one bar per row in the house colour, each named, sublabelled and valued', () => {
    const svg = svgOf(spec);
    const bars = svg.querySelector('[aria-label="bar"]');
    expect(bars?.getAttribute('fill')).toBe(HOUSE.seq3);
    expect(bars?.querySelectorAll('rect')).toHaveLength(3);
    expect(texts(svg)).toEqual(
      expect.arrayContaining([
        'Harborlight',
        'two crossings',
        '$1,200',
        'Saltmarsh',
        '$450.50',
        'Riverbend',
      ]),
    );
    expect(svg.querySelector('[aria-label="x-grid"]')?.getAttribute('stroke-dasharray')).toBe(
      '2 4',
    );
  });
});

describe('a preset it refuses', () => {
  it.each([
    ['an unknown preset', { preset: { type: 'pie' } }, 'unknown-preset'],
    ['a missing field', { data: { rows: ROWS }, preset: { ...PRESET, x: undefined } }, 'bad-spec'],
    ['a missing data key', { data: {}, preset: PRESET }, 'missing-data'],
    [
      'an unknown format',
      { data: { rows: ROWS }, preset: { ...PRESET, format: { y: 'roman' } } },
      'unknown-format',
    ],
    ['marks beside a preset', { ...PRESET_SPEC, marks: [] }, 'bad-spec'],
  ])('%s', (_label, spec, code) => {
    expect(() => expandPreset(spec)).toThrow(PlotSpecError);
    try {
      expandPreset(spec);
    } catch (err) {
      expect((err as PlotSpecError).code).toBe(code);
    }
  });
});

/** Each end label's lines, as Plot drew them. */
const endLines = (svg: Element) =>
  [...svg.querySelectorAll('[aria-label="text"] text[fill]')].map((t) =>
    [...t.querySelectorAll('tspan')].map((s) => s.textContent ?? ''),
  );
/** The x where the data stops: the right edge of the areas or lines. */
const dataRight = (svg: Element) =>
  Math.max(
    ...[...svg.querySelectorAll('[aria-label="area"] path, [aria-label="line"] path')].flatMap(
      (p) => [...(p.getAttribute('d') ?? '').matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1])),
    ),
  );

describe('a chart under 600px wide', () => {
  const stacked = (over: Partial<typeof PRESET> = {}) => ({
    ...PRESET_SPEC,
    preset: { ...PRESET, goal: undefined, ...over },
  });
  const atWidth = (spec: Parameters<typeof buildPlot>[1], width: number) =>
    buildPlot(Plot, spec, { width }) as SVGSVGElement;

  it('sets each end label as its series over its value', () => {
    const svg = atWidth(stacked(), 430);
    expect(endLines(svg)).toEqual([
      ['Walking', '19'],
      ['Biking', '8'],
    ]);
    // The margin fits "Walking", the longest line, not "Walking 19".
    expect(dataRight(svg)).toBe(430 - (Math.ceil(7 * 7.5) + 16));
  });

  it('keeps two-thirds of the width for the data, cutting a long label with an ellipsis', () => {
    const svg = atWidth(PRESET_SPEC, 430);
    expect(dataRight(svg)).toBe(430 - Math.floor(430 / 3));
    const goal = [...svg.querySelectorAll('[aria-label="text"] text')].find((t) =>
      t.textContent?.startsWith('Safe Routes'),
    );
    expect(goal?.firstChild?.textContent).toMatch(/^Safe Routes goal,?…$/);
    expect(goal?.querySelector('title')?.textContent).toBe('Safe Routes goal, 16 a year');
    // The end labels still fit whole.
    expect(endLines(svg)[0]).toEqual(['Walking', '19']);
  });

  it('cuts a series name too long for a third of the width', () => {
    const rows = ROWS.map((r) => ({
      ...r,
      mode: r.mode === 'Walking' ? 'Walking to Harborlight school' : r.mode,
    }));
    const svg = atWidth({ ...stacked({ order: undefined }), data: { rows } }, 430);
    expect(dataRight(svg)).toBe(430 - Math.floor(430 / 3));
    const [name, value] = endLines(svg)[0] ?? [];
    expect(name).toMatch(/^Walking to .+…$/);
    expect(value).toBe('19');
  });

  it('sets a lines chart’s end labels the same way, its end dots still drawn', () => {
    const spec = {
      data: { rows: LINES },
      preset: { type: 'lines', data: 'rows', x: 'year', y: 'v', series: 'place' },
    };
    const svg = atWidth(spec, 430);
    expect(endLines(svg)).toEqual([
      ['Harborlight', '112'],
      ['Riverbend', '97'],
    ]);
    expect(svg.querySelectorAll('[aria-label="dot"] circle')).toHaveLength(2);
    expect(dataRight(svg)).toBeGreaterThanOrEqual((430 * 2) / 3);
  });

  it('starts at 599px, and the spec’s own width counts when the page gives none', () => {
    expect(endLines(atWidth(stacked(), 599))[0]).toEqual(['Walking', '19']);
    expect(endLines(atWidth(stacked(), 600))[0]).toEqual([]);
    const own = { ...stacked(), options: { ...PRESET_OPTIONS, width: 430 } };
    expect(endLines(svgOf(own))[0]).toEqual(['Walking', '19']);
    expect(expandPreset(own).marks.at(-2)?.data).toEqual([
      { x: 2025, y: 9.5, series: 'Walking', label: 'Walking\n19' },
      { x: 2025, y: 23, series: 'Biking', label: 'Biking\n8' },
    ]);
  });
});

/** The stacked chart ticked at its five years, each read as a school year. */
const SCHOOL_YEARS = {
  ...PRESET_SPEC,
  options: { ...PRESET_OPTIONS, x: { ticks: [2005, 2010, 2015, 2020, 2025] } },
  preset: { ...PRESET, goal: undefined, format: { x: 'schoolYear' } },
};

/** The x tick labels as drawn, each with the x its label is centred on. */
const xTicks = (svg: Element) =>
  [...svg.querySelectorAll('[aria-label="x-axis tick label"] text')].map((t) => ({
    text: t.textContent ?? '',
    x: Number(/translate\(([\d.]+)/.exec(t.getAttribute('transform') ?? '')?.[1]),
  }));

describe('explicit x ticks under 600px wide', () => {
  const at = (spec: Parameters<typeof buildPlot>[1], width: number) =>
    xTicks(buildPlot(Plot, spec, { width }));

  it('keeps every other school year at 360px, the first kept, no two labels overlapping', () => {
    const ticks = at(SCHOOL_YEARS, 360);
    expect(ticks.map((t) => t.text)).toEqual(['2005-06', '2015-16', '2025-26']);
    for (const [i, t] of ticks.slice(1).entries()) {
      const prev = ticks[i] as { text: string; x: number };
      // Centred labels clear each other when their centres sit a label apart.
      expect(t.x - prev.x).toBeGreaterThan(((t.text.length + prev.text.length) / 2) * 7.5);
    }
  });

  it('keeps every tick while the labels still fit', () => {
    const years = { ...SCHOOL_YEARS, preset: { ...SCHOOL_YEARS.preset, format: {} } };
    expect(at(years, 599).map((t) => t.text)).toEqual(['2005', '2010', '2015', '2020', '2025']);
  });

  it('thins further when the plot is narrower still', () => {
    const many = {
      ...SCHOOL_YEARS,
      options: { ...SCHOOL_YEARS.options, x: { ticks: [2005, 2007, 2009, 2011, 2013, 2015] } },
    };
    const kept = at(many, 360).map((t) => t.text);
    expect(kept[0]).toBe('2005-06');
    expect(kept.length).toBeLessThanOrEqual(3);
  });

  it('thins the marks form too', () => {
    const spec = {
      ...SPEC,
      options: {
        ...SPEC.options,
        width: 360,
        marginRight: 120,
        x: { ...SPEC.options.x, ticks: [2005, 2010, 2015, 2020, 2025], tickFormat: 'schoolYear' },
      },
    };
    expect(at(spec, 360).map((t) => t.text)).toEqual(['2005-06', '2015-16', '2025-26']);
  });
});

describe('a chart 600px or wider', () => {
  const lines = {
    data: { rows: LINES },
    preset: {
      type: 'lines',
      data: 'rows',
      x: 'year',
      y: 'v',
      series: 'place',
      goal: { value: 120 },
    },
  };
  // A clip id counts up across the whole run, so it is not part of the drawing.
  const drawn = (spec: Parameters<typeof buildPlot>[1], width?: number) =>
    buildPlot(Plot, spec, width === undefined ? {} : { width }).outerHTML.replace(
      /plot-clip-\d+/g,
      'plot-clip',
    );

  // The files were written by the code before narrow charts were handled, so
  // a difference here is a change to what a wide chart draws.
  it.each([
    ['stacked-area-820', PRESET_SPEC, undefined],
    ['stacked-area-ticks-600', SCHOOL_YEARS, 600],
    ['stacked-area-600', PRESET_SPEC, 600],
    ['lines-640', lines, undefined],
    ['lines-600', lines, 600],
  ] as const)('draws %s exactly as before', async (name, spec, width) => {
    await expect(drawn(spec, width)).toMatchFileSnapshot(`./fixtures/plot-wide/${name}.svg`);
  });
});
