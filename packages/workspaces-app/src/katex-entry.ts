/**
 * The entry `scripts/build.ts` builds into `/app/katex/katex.js`: KaTeX and
 * nothing else, fetched by `math-katex.ts` the first time a doc shows an
 * equation. No page bundle imports this file.
 */
export { default } from 'katex';
