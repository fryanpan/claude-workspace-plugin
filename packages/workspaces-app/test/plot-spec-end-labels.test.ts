import { HOUSE, buildPlot } from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';
import { measured } from './fixtures/chrome-glyph-widths.ts';
import { ALL_MODES, ALL_MODES_ORDER } from './fixtures/ssc-all-modes.ts';

/**
 * At 600px and wider a stackedArea chart labels each series at its right
 * end, "<series> <value>" in ink beside a dot of the series' colour, and
 * moves labels apart where their bands are too thin to keep them clear. An
 * iPad in landscape draws a doc's chart 793px wide; 820 and 1180 are the
 * other widths a wide chart takes.
 */

type Pt = [number, number];
type Box = { text: string; a: number; b: number; top: number; bottom: number; fill: string };

/** Chrome's box for one 13px line of the house font is about 16px tall. */
const LINE_BOX = 16;
const WIDTHS = [793, 820, 1180];

const at = (spec: Parameters<typeof buildPlot>[1], width: number) =>
  buildPlot(Plot, spec, { width }) as SVGSVGElement;

const translate = (el: Element | null): Pt => {
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(el?.getAttribute('transform') ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

/** Every text label's box, at Chrome's measured glyph widths. */
const boxes = (svg: Element): Box[] =>
  [...svg.querySelectorAll('[aria-label="text"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    const fill = g.getAttribute('fill') ?? '';
    return [...g.querySelectorAll('text')].map((t) => {
      const [x, y] = translate(t);
      const text = t.textContent ?? '';
      const a = x + dx;
      return {
        text,
        a,
        b: a + measured(text),
        top: y + dy - LINE_BOX / 2,
        bottom: y + dy + LINE_BOX / 2,
        fill,
      };
    });
  });

const overlaps = (all: Box[]) =>
  all.flatMap((m, i) =>
    all
      .slice(i + 1)
      .filter((n) => m.a < n.b && n.a < m.b && m.top < n.bottom && n.top < m.bottom)
      .map((n) => [m.text, n.text]),
  );

/** The swatches: each dot's centre and fill. */
const dots = (svg: Element) =>
  [...svg.querySelectorAll('[aria-label="dot"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    return [...g.querySelectorAll('circle')].map((c) => ({
      x: Number(c.getAttribute('cx')) + dx,
      y: Number(c.getAttribute('cy')) + dy,
      fill: c.getAttribute('fill') ?? '',
    }));
  });

/** Each area's fill, bottom band first, as Plot draws them in order. */
const fills = (svg: Element) =>
  [...svg.querySelectorAll('[aria-label="area"] path')].map((p) => p.getAttribute('fill'));

/** Five modes ending with two thin bands on top: Biking 8 and Other 5 of 160. */
const THIN: Record<string, number[]> = {
  'Car passenger': [95, 100, 105, 110, 112],
  Driving: [12, 9, 7, 5, 4],
  Walking: [30, 27, 24, 22, 20],
  Biking: [3, 5, 7, 9, 8],
  Other: [3, 4, 4, 5, 5],
};
const THIN_ORDER = Object.keys(THIN);
const THIN_TOP = {
  data: {
    rows: [2005, 2010, 2015, 2020, 2025].flatMap((year, i) =>
      THIN_ORDER.map((mode) => ({ year, mode, n: THIN[mode]?.[i] ?? 0 })),
    ),
  },
  options: { height: 380, y: { domain: [0, 160] } },
  preset: {
    type: 'stackedArea',
    data: 'rows',
    x: 'year',
    y: 'n',
    series: 'mode',
    order: THIN_ORDER,
  },
};

const CHARTS = [
  ['the all-modes chart', ALL_MODES, ALL_MODES_ORDER],
  ['two thin bands on top', THIN_TOP, THIN_ORDER],
] as const;

describe.each(CHARTS)('%s, wide', (_name, spec, order) => {
  it.each(WIDTHS)('labels every series at %ipx, no two labels overlapping', (w) => {
    const svg = at(spec, w);
    const all = boxes(svg);
    const names = all.map((l) => l.text.replace(/ [\d,]+$/, ''));
    expect(names.sort()).toEqual([...order].sort());
    expect(overlaps(all)).toEqual([]);
    expect(Math.max(...all.map((l) => l.b))).toBeLessThanOrEqual(w);
    expect(Math.min(...all.map((l) => l.top))).toBeGreaterThanOrEqual(0);
  });

  it.each(WIDTHS)('sets each label in ink, its band’s colour in a dot beside it, at %ipx', (w) => {
    const svg = at(spec, w);
    const colour = fills(svg);
    const marks = dots(svg);
    for (const l of boxes(svg)) {
      expect(l.fill).toBe(HOUSE.ink);
      const i = order.indexOf(l.text.replace(/ [\d,]+$/, '') as never);
      const dot = marks.find((d) => Math.abs(d.y - (l.top + l.bottom) / 2) < 1);
      expect(dot?.fill).toBe(colour[i]);
      expect(dot && dot.x < l.a && l.a - dot.x < 12).toBe(true);
    }
  });
});

describe('a label moved off its band', () => {
  it('stays next to it: Other and Biking split around where they want to be', () => {
    const svg = at(THIN_TOP, 793);
    const y = Object.fromEntries(boxes(svg).map((l) => [l.text, (l.top + l.bottom) / 2]));
    const other = y['Other 5'];
    const biking = y['Biking 8'];
    if (other === undefined || biking === undefined) throw new Error('no Other or Biking label');
    // Their bands' middles are 13.4px apart; each moves about 2px to clear 17.
    expect(biking - other).toBeGreaterThanOrEqual(LINE_BOX);
    expect(biking - other).toBeLessThan(LINE_BOX + 2);
  });
});
