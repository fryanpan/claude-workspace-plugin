import { describe, expect, it } from 'vitest';
import { summarizeMdx } from '../src/mdx-preview.ts';
import { BARS, LINE, ONE_LINE } from './fixtures/mdx-charts.ts';

/**
 * The chart a component's literal props describe (`mdx-chart-props.ts`), read
 * by shape rather than by component name and never by running the source.
 */

describe('reading a chart written the way posts write it', () => {
  it("reads a line chart's series values, band, unit and numeric-keyed tick labels", () => {
    const s = summarizeMdx(LINE);
    expect(s.title).toBe("Riverbend's crossings × weekday – 2025");
    expect(s.chart).toEqual({
      type: 'line',
      series: [
        {
          label: 'Harborlight route',
          dashed: false,
          showValue: true,
          points: [
            { x: 1, y: 1200 },
            { x: 2, y: 1350 },
            { x: 3, y: 1280 },
            { x: 4, y: 1510 },
          ],
        },
        {
          label: 'Saltmarsh route',
          dashed: true,
          showValue: true,
          points: [
            { x: 1, y: 800 },
            { x: 2, y: 950 },
            { x: 3, y: 900 },
            { x: 4, y: 1020 },
          ],
        },
      ],
      unit: 'crossings',
      band: { from: 2, to: 3, label: 'Planned capacity' },
      zeroBaseline: false,
      yTickFormat: 'thousands',
      xTickLabels: [
        { x: 1, label: 'Jan' },
        { x: 2, label: 'Feb' },
        { x: 3, label: 'Mar' },
        { x: 4, label: 'Apr' },
      ],
      ignored: [],
      siteIgnores: [],
    });
  });

  it('reads the same chart written on one line with spaces inside its braces', () => {
    const s = summarizeMdx(ONE_LINE);
    expect(s.title).toBe("Riverbend's crossings");
    expect(s.chart?.type === 'line' && s.chart.series[0]?.points).toHaveLength(2);
    expect(s.chart?.type === 'line' && s.chart.band).toEqual({ from: 1, to: 2 });
    expect(s.chart?.type === 'line' && s.chart.xTickLabels?.map((t) => t.label)).toEqual([
      'Mon',
      'Tue',
    ]);
  });

  it("reads a bar chart's rows and orientation, keeps only a plain colour, and names what it drops", () => {
    expect(summarizeMdx(BARS('horizontal')).chart).toEqual({
      type: 'bar',
      orientation: 'horizontal',
      unit: '%',
      bars: [
        { label: 'North pier', value: 42 },
        { label: 'South pier', value: 31, color: '#0b7285' },
        { label: 'Ferry slip', value: 17 },
      ],
      ignored: ['data[].color'],
      siteIgnores: ['highlightIndex'],
    });
  });

  it("takes the site's defaults: horizontal bars in percent, and any other orientation word is vertical", () => {
    const chart = (attrs: string) =>
      summarizeMdx(`<Chart ${attrs} data={[{ label: "Riverbend", value: 3 }]} />`).chart;
    expect(chart('')).toMatchObject({ orientation: 'horizontal', unit: '%' });
    expect(chart('orientation="vertical" unit=""')).toMatchObject({
      orientation: 'vertical',
      unit: '',
    });
    expect(chart('orientation="sideways"')).toMatchObject({ orientation: 'vertical' });
    expect(chart('orientation={dir}')).toMatchObject({
      orientation: 'horizontal',
      ignored: ['orientation'],
    });
  });

  it("reads a line chart's events in x order, and a series that hides its value", () => {
    const s = summarizeMdx(
      '<LineChart events={[{ x: 5, label: "Pier reopened" }, { x: 2, label: "Ferry added" }, { label: "no x" }]} series={[{ label: "Riverbend", showValue: false, values: [{ x: 1, y: 2 }, { x: 6, y: 4 }] }]} />',
    );
    expect(s.chart?.type === 'line' && s.chart.events).toEqual([
      { x: 2, label: 'Ferry added' },
      { x: 5, label: 'Pier reopened' },
    ]);
    expect(s.chart?.type === 'line' && s.chart.series[0]?.showValue).toBe(false);
  });

  it('reads no chart from props that are not literals of a chart shape', () => {
    expect(summarizeMdx('<LineChart title="Riders" series={rows} />').chart).toBeUndefined();
    expect(summarizeMdx('<Chart data={[{ label: "A", value: n }]} />').chart).toBeUndefined();
    expect(summarizeMdx('<Callout type="note">Words</Callout>').chart).toBeUndefined();
  });
});
