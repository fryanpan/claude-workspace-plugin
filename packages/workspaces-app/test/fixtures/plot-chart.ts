/**
 * The `<PlotChart>` example agreed with the repos that copy `plot-spec.mjs`:
 * walking and biking counts stacked by year, a goal rule, its label, and a
 * tip that reads the stacked positions.
 */

const YEARS = [2005, 2010, 2015, 2020, 2025];
const WALKING = [43, 38, 30, 24, 19];
const BIKING = [6, 9, 12, 10, 8];

export const ROWS = YEARS.flatMap((year, i) => [
  { year, mode: 'Walking', n: WALKING[i] },
  { year, mode: 'Biking', n: BIKING[i] },
]);

export const OPTIONS = {
  width: 820,
  height: 380,
  marginRight: 210,
  x: { domain: [2005, 2025] },
  y: { domain: [0, 80] },
  color: { domain: ['Walking', 'Biking'], range: ['#2f7d76', '#c8a25e'] },
};

export const MARKS = [
  {
    mark: 'areaY',
    data: 'rows',
    transform: 'stackY',
    options: { x: 'year', y: 'n', fill: 'mode', order: ['Walking', 'Biking'] },
  },
  { mark: 'ruleY', data: [16], options: { stroke: '#15181c', strokeDasharray: '6 4' } },
  {
    mark: 'text',
    data: [{ x: 2025, y: 16, t: 'Safe Routes goal, 16 a year' }],
    options: { x: 'x', y: 'y', text: 't', dx: 8, textAnchor: 'start' },
  },
  {
    mark: 'tip',
    data: 'rows',
    transform: 'stackY2',
    pointer: 'pointerX',
    options: { x: 'year', y: 'n', fill: 'mode' },
  },
];

export const SPEC = { data: { rows: ROWS }, options: OPTIONS, marks: MARKS };

/** The component as a post writes it. */
export function plotChartSource(over: { title?: string; marks?: unknown } = {}): string {
  return [
    `<PlotChart title="${over.title ?? 'Riverbend school trips by mode'}"`,
    '  subtitle="Trips a year, stacked"',
    '  note="Counts from the Harborlight survey."',
    `  data={${JSON.stringify({ rows: ROWS })}}`,
    `  options={${JSON.stringify(OPTIONS)}}`,
    `  marks={${JSON.stringify(over.marks ?? MARKS)}} />`,
  ].join('\n');
}
