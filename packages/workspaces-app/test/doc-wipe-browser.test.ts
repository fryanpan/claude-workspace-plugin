/**
 * Pressing Delete on a selected comment must not wipe the doc, in a real
 * browser: tap a comment's highlight, select all, press Delete or Backspace,
 * and the doc keeps every word.
 *
 * Two controls in the same page. A caret placed by that tap still edits, one
 * character per key, so the guard has not simply switched the keys off. And a
 * select-all reached from plain prose still deletes the doc, because that is
 * a person clearing it on purpose (the Undo toast is what answers a mistake
 * there) — and it proves the key really reaches the editor, so the comment
 * cases are not passing on a key that did nothing.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { WipeReading } from './doc-wipe-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** One launch, one bundle, eight mounts. */
const BROWSER_CASE_MS = 120_000;

describe.skipIf(CHROME === null)('Delete on a selected comment, in headless Chrome', () => {
  it(
    'keeps the doc after a comment tap and a select-all, and still edits otherwise',
    () => {
      const r = spawnSync('bun', [join(import.meta.dirname, 'doc-wipe-browser-driver.ts')], {
        encoding: 'utf8',
        timeout: BROWSER_CASE_MS - 10_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const readings = JSON.parse(r.stdout) as WipeReading[];
      const byName = new Map(readings.map((x) => [x.name, x]));
      for (const key of ['Backspace', 'Delete']) {
        for (const where of ['prose', 'chart']) {
          const g = byName.get(`${where} comment, select all, ${key}`);
          expect(g?.selection, `${where} ${key}`).toMatch(/^AllSelection/);
          expect(g?.after, `${where} ${key}`).toBe(g?.before);
        }
        const caret = byName.get(`prose comment, ${key}`);
        expect(caret?.after, `caret ${key}`).toBe((caret?.before ?? 0) - 1);
        const plain = byName.get(`plain prose, select all, ${key}`);
        expect(plain?.before, `plain ${key}`).toBeGreaterThan(0);
        expect(plain?.after, `plain ${key}`).toBe(0);
      }
    },
    BROWSER_CASE_MS,
  );
});
