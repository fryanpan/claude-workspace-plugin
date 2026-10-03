/**
 * KaTeX in a real browser, through the shipped editor: a doc without math
 * fetches none of it, and a doc with math — the positive control, in the same
 * page — fetches it, draws every equation, refuses the `javascript:` links
 * `\href` and `\url` would make, and shows bad TeX as its source.
 *
 * The no-math reading is only worth anything because the same page then
 * fetches: a page that could not reach `/app/katex/` at all would pass it.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Reading } from './math-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** One launch, two bundles (the editor and KaTeX), two mounts. */
const BROWSER_CASE_MS = 120_000;

describe.skipIf(CHROME === null)('KaTeX in headless Chrome', () => {
  it(
    'loads nothing for a doc without math, and draws a doc with math safely',
    () => {
      const r = spawnSync('bun', [join(import.meta.dirname, 'math-browser-driver.ts')], {
        encoding: 'utf8',
        timeout: BROWSER_CASE_MS - 10_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const { before, after } = JSON.parse(r.stdout) as Reading;
      expect(before).toEqual({ katex: 0, requests: 0, resources: 0, stylesheets: 0 });

      expect(after.requests).toContain('/app/katex/katex.js');
      expect(after.requests).toContain('/app/katex/katex.min.css');
      expect(after.requests.some((p) => p.endsWith('.woff2'))).toBe(true);
      // x_e, a*b, c*d, the \href and the \url, and the broken one.
      expect(after.katex).toBeGreaterThanOrEqual(5);
      expect(after.display).toBe(1);
      expect(after.scriptLinks).toBe(0);
      expect(after.errors).toBeGreaterThan(0);
      expect(after.errorText).toContain('\\frac{a');
      expect(after.openedOnClick).toBe('x_e');
    },
    BROWSER_CASE_MS,
  );
});
