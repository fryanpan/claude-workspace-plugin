import { appendFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOUSE,
  PLOT_MARKS,
  PLOT_POINTERS,
  PLOT_SPEC_VERSION,
  PLOT_TRANSFORMS,
  PlotSpecError,
  buildPlot,
} from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { afterEach, describe, expect, it } from 'vitest';
import { PLOT_SPEC_PATH, checkFile, stampFile } from '../../../scripts/plot-spec-stamp.ts';
import { MARKS, ROWS, SPEC } from './fixtures/plot-chart.ts';

/**
 * `buildPlot` (core `plot-spec.mjs`) turns a `<PlotChart>` spec into the chart
 * real Plot draws, and refuses a spec naming anything outside its allowlists
 * before it calls any Plot function at all.
 */

/** A Plot that records every call, in order, and draws nothing. */
function spyPlot(): {
  plot: Record<string, unknown>;
  calls: Array<{ name: string; args: unknown[] }>;
} {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const plot: Record<string, unknown> = {};
  for (const name of [
    ...PLOT_MARKS,
    ...PLOT_TRANSFORMS,
    ...PLOT_POINTERS,
    'gridX',
    'gridY',
    'plot',
  ]) {
    plot[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      return name === 'plot' ? document.createElement('figure') : { from: name, args };
    };
  }
  return { plot, calls };
}

function refusal(spec: unknown): { code: string; message: string; calls: number } {
  const { plot, calls } = spyPlot();
  try {
    buildPlot(plot, spec as Parameters<typeof buildPlot>[1]);
  } catch (err) {
    expect(err).toBeInstanceOf(PlotSpecError);
    const e = err as PlotSpecError;
    return { code: e.code, message: e.message, calls: calls.length };
  }
  throw new Error('buildPlot drew a spec it should have refused');
}

describe('buildPlot on the agreed example', () => {
  const figure = buildPlot(Plot, SPEC) as SVGSVGElement;

  it('draws an 820 by 380 SVG', () => {
    expect(figure.tagName.toLowerCase()).toBe('svg');
    expect(figure.getAttribute('width')).toBe('820');
    expect(figure.getAttribute('height')).toBe('380');
  });

  it('stacks one area per mode, filled with the colours the options give', () => {
    const fills = [...figure.querySelectorAll('path')]
      .map((p) => p.getAttribute('fill'))
      .filter((f) => f === '#2f7d76' || f === '#c8a25e');
    expect(fills.sort()).toEqual(['#2f7d76', '#c8a25e']);
  });

  it('draws the dashed goal rule and its label', () => {
    const rule = [...figure.querySelectorAll('line, g')].find(
      (n) => n.getAttribute('stroke-dasharray') === '6 4',
    );
    expect(rule).toBeDefined();
    expect([...figure.querySelectorAll('text')].map((t) => t.textContent)).toContain(
      'Safe Routes goal, 16 a year',
    );
  });

  it('ticks the x axis inside the domain the options give', () => {
    const ticks = [...figure.querySelectorAll('[aria-label="x-axis tick label"] text')].map((t) =>
      Number(t.textContent?.replace(/,/g, '')),
    );
    expect(ticks.length).toBeGreaterThan(3);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(2005);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(2025);
  });
});

describe('how a mark is composed', () => {
  it('wraps the transform in the pointer, so a tip reads the stacked positions', () => {
    const { plot, calls } = spyPlot();
    buildPlot(plot, SPEC);
    const names = calls.map((c) => c.name);
    // The tip's three calls run innermost first: stackY2, then pointerX over its output.
    const tip = names.lastIndexOf('tip');
    expect(names.slice(tip - 2, tip + 1)).toEqual(['stackY2', 'pointerX', 'tip']);
    const stacked = calls[tip - 1]?.args[0];
    // The spec's own options, over the tip's house edge; its years read "2005".
    expect(stacked).toEqual({
      from: 'stackY2',
      args: [{ stroke: HOUSE.rule, ...MARKS[3]?.options, format: { x: 'd' } }],
    });
    expect(calls[tip]?.args).toEqual([ROWS, { from: 'pointerX', args: [stacked] }]);
  });

  it('hands groupX, groupY and binX their outputs as the first argument', () => {
    const { plot, calls } = spyPlot();
    const options = { x: 'mode', y: 'n' };
    buildPlot(plot, {
      data: { rows: ROWS },
      marks: [
        { mark: 'barY', data: 'rows', transform: 'groupX', outputs: { y: 'sum' }, options },
        { mark: 'barX', data: 'rows', transform: 'groupY', outputs: { x: 'count' }, options },
        { mark: 'rectY', data: 'rows', transform: 'binX', outputs: { y: 'mean' }, options },
      ],
    });
    const at = (name: string) => calls.find((c) => c.name === name)?.args;
    expect(at('groupX')).toEqual([{ y: 'sum' }, options]);
    expect(at('groupY')).toEqual([{ x: 'count' }, options]);
    expect(at('binX')).toEqual([{ y: 'mean' }, options]);
  });

  it('draws a count per group with real Plot', () => {
    const svg = buildPlot(Plot, {
      data: { rows: ROWS },
      marks: [
        {
          mark: 'barY',
          data: 'rows',
          transform: 'groupX',
          outputs: { y: 'count' },
          options: { x: 'mode' },
        },
      ],
    });
    // Five rows of each mode, so two bars of the same height.
    const heights = [...svg.querySelectorAll('[aria-label="bar"] rect')].map((r) =>
      r.getAttribute('height'),
    );
    expect(heights).toHaveLength(2);
    expect(heights[0]).toBe(heights[1]);
    const ticks = [...svg.querySelectorAll('[aria-label="y-axis tick label"] text')].map(
      (t) => t.textContent,
    );
    // The y axis runs to five, the count in each group.
    expect(Number(ticks.at(-1))).toBe(5);
  });

  it('passes a mark with no wrappers its options as they are, and inline data as given', () => {
    const { plot, calls } = spyPlot();
    buildPlot(plot, SPEC);
    const rule = calls.find((c) => c.name === 'ruleY');
    expect(rule?.args).toEqual([[16], MARKS[1]?.options]);
  });

  it('draws the chart from the options with the marks in order', () => {
    const { plot, calls } = spyPlot();
    buildPlot(plot, SPEC);
    const last = calls.at(-1);
    expect(last?.name).toBe('plot');
    const opts = last?.args[0] as { width: number; marks: Array<{ from: string }> };
    expect(opts.width).toBe(820);
    // The house grid and zero line first, under the spec's own marks.
    expect(opts.marks.map((m) => m.from)).toEqual([
      'gridY',
      'ruleY',
      'areaY',
      'ruleY',
      'text',
      'tip',
    ]);
  });
});

describe('the allowlists', () => {
  it('names only functions this Plot has', () => {
    const p = Plot as unknown as Record<string, unknown>;
    for (const name of [...PLOT_MARKS, ...PLOT_TRANSFORMS, ...PLOT_POINTERS]) {
      expect(typeof p[name], name).toBe('function');
    }
  });

  it('draws every allowlisted mark', () => {
    for (const mark of PLOT_MARKS) {
      const fig = buildPlot(Plot, {
        data: { rows: ROWS },
        marks: [{ mark, data: 'rows', options: { x: 'year', y: 'n' } }],
      });
      expect(fig.tagName.toLowerCase(), mark).toMatch(/^(svg|figure)$/);
    }
  });
});

describe('a spec it refuses, calling no Plot function', () => {
  const one = (m: Record<string, unknown>) => ({ data: { rows: ROWS }, marks: [m] });

  it.each([
    ['an unknown mark', { mark: 'image', data: 'rows' }, 'unknown-mark'],
    ['a mark named after an object key', { mark: 'constructor', data: 'rows' }, 'unknown-mark'],
    ['an unknown transform', { mark: 'dot', data: 'rows', transform: 'map' }, 'unknown-transform'],
    ['an unknown pointer', { mark: 'tip', data: 'rows', pointer: 'pointer' }, 'unknown-pointer'],
    ['a data key that is missing', { mark: 'dot', data: 'other' }, 'missing-data'],
    ['a data key from the prototype', { mark: 'dot', data: '__proto__' }, 'missing-data'],
    ['a mark with no data', { mark: 'dot' }, 'missing-data'],
    [
      'a link from the data',
      { mark: 'dot', data: 'rows', options: { href: 'url' } },
      'refused-option',
    ],
    [
      'a reducer outside the list',
      { mark: 'barY', data: 'rows', transform: 'groupX', outputs: { y: 'mode' } },
      'unknown-reducer',
    ],
    [
      'a reducer named after an object key',
      { mark: 'barY', data: 'rows', transform: 'groupX', outputs: { y: 'constructor' } },
      'unknown-reducer',
    ],
    [
      'a reducer that is a function body',
      { mark: 'barY', data: 'rows', transform: 'binX', outputs: { y: '(d) => d.length' } },
      'unknown-reducer',
    ],
    [
      'outputs on a transform that does not reduce',
      { mark: 'areaY', data: 'rows', transform: 'stackY', outputs: { y: 'sum' } },
      'bad-spec',
    ],
    ['outputs with no transform', { mark: 'dot', data: 'rows', outputs: { y: 'sum' } }, 'bad-spec'],
    [
      'outputs that are a list',
      { mark: 'barY', data: 'rows', transform: 'groupY', outputs: ['count'] },
      'bad-spec',
    ],
  ])('%s', (_label, mark, code) => {
    const got = refusal(one(mark));
    expect(got.code).toBe(code);
    expect(got.calls).toBe(0);
  });

  it('refuses the whole chart when its last mark is bad, before drawing the first', () => {
    const got = refusal({ ...SPEC, marks: [...MARKS, { mark: 'geo', data: 'rows' }] });
    expect(got).toEqual({ code: 'unknown-mark', message: 'Mark 5: unknown mark "geo"', calls: 0 });
  });

  it.each([
    ['no marks', { data: {}, marks: [] }],
    ['marks that are not a list', { marks: { mark: 'dot' } }],
    ['data that is a list', { data: [], marks: [{ mark: 'dot', data: [] }] }],
    ['options that are a string', { options: 'wide', marks: [{ mark: 'dot', data: [] }] }],
  ])('%s', (_label, spec) => {
    const got = refusal(spec);
    expect(got.code).toBe('bad-spec');
    expect(got.calls).toBe(0);
  });
});

describe('the version line other sites compare', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A copy of the canonical file, as a site would hold it. */
  const copy = () => {
    const dir = mkdtempSync(join(tmpdir(), 'plot-spec-'));
    dirs.push(dir);
    const path = join(dir, 'plot-spec.mjs');
    copyFileSync(PLOT_SPEC_PATH, path);
    return path;
  };

  it('names the version the module exports and the hash of its contents', () => {
    expect(checkFile(PLOT_SPEC_PATH)).toEqual({ ok: true, version: PLOT_SPEC_VERSION });
  });

  it('stops matching when the contents change and the line does not', () => {
    const path = copy();
    appendFileSync(path, '// one more line\n');
    expect(checkFile(path)).toMatchObject({ ok: false, version: PLOT_SPEC_VERSION });
  });

  it('moves the version on once when restamped against the released copy', () => {
    const released = copy();
    const edited = copy();
    appendFileSync(edited, '// one more line\n');
    const base = copy();
    const next = { ok: true, version: PLOT_SPEC_VERSION + 1 };
    // With nothing released to compare, the hash moves and the number stays.
    expect(stampFile(edited, undefined, '2026-10-11')).toEqual({
      ok: true,
      version: PLOT_SPEC_VERSION,
    });
    expect(stampFile(edited, released, '2026-10-11')).toEqual(next);
    // Stamping again on the same branch keeps the new number.
    expect(stampFile(edited, released, '2026-10-11')).toEqual(next);
    // A copy that matches the released one keeps its number.
    expect(stampFile(base, released, '2026-10-11')).toEqual({
      ok: true,
      version: PLOT_SPEC_VERSION,
    });
  });
});
