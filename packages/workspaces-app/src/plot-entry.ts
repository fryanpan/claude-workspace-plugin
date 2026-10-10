/**
 * The entry `scripts/build.ts` builds into `/app/plot/plot.js`: Observable
 * Plot and `buildPlot` (core `plot-spec.mjs`), fetched by `mdx-plot-chart.ts`
 * the first time a doc shows a `<PlotChart>`. No page bundle imports this
 * file, so neither costs a page that shows no chart a byte.
 */
import { type PlotSpec, PlotSpecError, buildPlot } from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';

/** The chart, or the words the error box shows in its place. */
export function drawPlotSpec(spec: PlotSpec): { figure: Element } | { error: string } {
  try {
    return { figure: buildPlot(Plot, spec) };
  } catch (err) {
    if (err instanceof PlotSpecError) return { error: err.message };
    return { error: `Plot could not draw this chart: ${String(err)}` };
  }
}
