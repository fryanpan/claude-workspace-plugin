/**
 * The entry `scripts/build.ts` builds into `/app/plot/plot.js`: Observable
 * Plot and core `plot-spec.mjs`, fetched by `mdx-plot-chart.ts` the first time
 * a doc shows a `<PlotChart>`. No page bundle imports this file, so neither
 * costs a page that shows no chart a byte.
 */
import { type PlotSpec, renderPlot } from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';

/** Draw `spec` into `slot` with the same call the sites make: the chart, or
 *  the error box in its place. */
export function renderPlotInto(slot: Element, spec: PlotSpec): Element | null {
  return renderPlot(Plot, slot, spec);
}
