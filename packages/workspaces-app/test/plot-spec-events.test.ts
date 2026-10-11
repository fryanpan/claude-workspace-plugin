import { HOUSE, PlotSpecError, buildPlot, expandPreset } from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';
import { PRESET, PRESET_SPEC } from './fixtures/plot-chart.ts';

/**
 * A preset's `events`: a dashed rule at each x in the muted ink, its label
 * at the top of the plot on the side with more room, wrapped to two lines
 * below 600px and clear of the labels inside the bands. Read off the SVG
 * real Plot draws.
 */

const CH = 7.5;
const LINE = 13;
const VISION = { x: 2013, label: 'Vision Zero adopted, 2014' };

const withEvents = (events: unknown) => ({ ...PRESET_SPEC, preset: { ...PRESET, events } });
const at = (spec: Parameters<typeof buildPlot>[1], width?: number) =>
  buildPlot(Plot, spec, width === undefined ? {} : { width }) as SVGSVGElement;

const translate = (el: Element | null): [number, number] => {
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(el?.getAttribute('transform') ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

type Box = { text: string; lines: string[]; a: number; b: number; top: number; bottom: number };

/** Every text label's box, its lines one em apart from the y it names. */
const boxes = (svg: Element): Box[] =>
  [...svg.querySelectorAll('[aria-label="text"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    const anchor = g.getAttribute('text-anchor') ?? 'start';
    const top = g.querySelector('tspan[y="0.71em"]') !== null;
    return [...g.querySelectorAll('text')].map((t) => {
      const [x, y] = translate(t);
      const spans = [...t.querySelectorAll('tspan')].map((s) => s.textContent ?? '');
      const lines = spans.length > 0 ? spans : [t.firstChild?.textContent ?? ''];
      const w = Math.max(...lines.map((l) => l.length)) * CH;
      const a = anchor === 'end' ? x + dx - w : x + dx;
      const y0 = top ? y + dy : y + dy - LINE / 2;
      return {
        text: lines.join(' '),
        lines,
        a,
        b: a + w,
        top: y0,
        bottom: y0 + lines.length * LINE,
      };
    });
  });

const eventRules = (svg: Element) =>
  [...svg.querySelectorAll('[aria-label="rule"]')].filter(
    (g) => g.getAttribute('stroke') === HOUSE.muted,
  );

describe('an event on a stacked chart 600px or wider', () => {
  it('draws a dashed rule at its x in the muted ink, never a series colour', () => {
    const svg = at(withEvents([VISION]));
    const [rule] = eventRules(svg);
    expect(rule?.getAttribute('stroke-dasharray')).toBe('4 4');
    const line = rule?.querySelector('line');
    expect(line?.getAttribute('x1')).toBe(line?.getAttribute('x2'));
  });

  it('labels it on one line at the top, on the side of the rule with more room', () => {
    const svg = at(withEvents([VISION, { x: 2022, label: 'Late' }]));
    const label = boxes(svg).find((l) => l.text === VISION.label);
    expect(label?.lines).toEqual([VISION.label]);
    expect(label?.top).toBeLessThan(30);
    const anchors = [...svg.querySelectorAll('[aria-label="text"]')]
      .filter((g) => g.textContent === VISION.label || g.textContent === 'Late')
      .map((g) => [g.textContent, g.getAttribute('text-anchor')]);
    // 2013 has more of 2005-2025 to its right, 2022 to its left.
    expect(anchors).toEqual([
      [VISION.label, 'start'],
      ['Late', 'end'],
    ]);
  });

  it('draws a lines chart’s event the same way', () => {
    const spec = {
      data: { rows: PRESET_SPEC.data.rows },
      preset: { type: 'lines', data: 'rows', x: 'year', y: 'n', series: 'mode', events: [VISION] },
    };
    const svg = at(spec);
    expect(eventRules(svg)).toHaveLength(1);
    expect(boxes(svg).map((l) => l.text)).toContain(VISION.label);
  });
});

describe('an event below 600px', () => {
  it('wraps a label too wide for its side to two lines rather than cutting it', () => {
    const svg = at(withEvents([VISION]), 371);
    const label = boxes(svg).find((l) => l.text === VISION.label);
    expect(label?.lines).toEqual(['Vision Zero', 'adopted, 2014']);
    expect(label?.b).toBeLessThanOrEqual(371);
  });

  it('keeps it clear of the labels inside the bands', () => {
    for (const width of [371, 430]) {
      const all = boxes(at(withEvents([VISION, { x: 2006, label: 'Survey starts' }]), width));
      const events = all.filter((l) => l.text === VISION.label || l.text === 'Survey starts');
      expect(events).toHaveLength(2);
      for (const e of events) {
        const hit = all.filter(
          (l) => l !== e && l.a < e.b && e.a < l.b && l.top < e.bottom && e.top < l.bottom,
        );
        expect(hit.map((l) => l.text)).toEqual([]);
      }
    }
  });
});

describe('an event label beside a band label', () => {
  it('moves a band’s label away from an event label where both would sit', () => {
    // Biking's band runs along the top of the plot, where event labels go.
    const rows = [2005, 2010, 2015, 2020, 2025].flatMap((year) => [
      { year, mode: 'Walking', n: 36 },
      { year, mode: 'Biking', n: 4 },
    ]);
    const spec = {
      data: { rows },
      options: { height: 380 },
      preset: { ...PRESET, goal: undefined, events: [{ x: 2006, label: 'Survey starts' }] },
    };
    const all = boxes(at(spec, 430));
    const event = all.find((l) => l.text === 'Survey starts');
    const biking = all.find((l) => l.text === 'Biking');
    if (!event || !biking) throw new Error('no event or Biking label');
    expect(biking.a < event.b && event.a < biking.b && biking.top < event.bottom).toBe(false);
  });
  it('keeps a band’s label off an event’s rule', () => {
    // Biking is thickest around 2012-2014, right where the rule falls.
    const biking = [1, 1, 2, 3, 5, 8, 11, 13, 14, 14, 13, 12, 10, 8, 6, 4, 3, 2, 1, 1, 1];
    const rows = biking.flatMap((n, i) => [
      { year: 2005 + i, mode: 'Walking', n: 43 - i * 1.2 },
      { year: 2005 + i, mode: 'Biking', n },
    ]);
    for (const width of [371, 430]) {
      const svg = at({ ...withEvents([VISION]), data: { rows } }, width);
      const x = Number(eventRules(svg)[0]?.querySelector('line')?.getAttribute('x1'));
      const crossing = boxes(svg).filter(
        (l) => PRESET.order.includes(l.text) && l.a < x && l.b > x,
      );
      expect(boxes(svg).map((l) => l.text)).toContain('Biking');
      expect(crossing.map((l) => l.text)).toEqual([]);
    }
  });
});

describe('events it refuses', () => {
  it.each([
    ['not a list', { x: 2013 }],
    ['an event with no numeric x', [{ x: '2013', label: 'Vision Zero' }]],
  ])('%s', (_label, events) => {
    expect(() => expandPreset(withEvents(events))).toThrow(PlotSpecError);
  });
});
