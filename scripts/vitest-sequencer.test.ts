/**
 * The start order: browser-gated files first, and nothing else moved.
 *
 * audit: no-text — the reader is injected; nothing here reads a source file.
 */
import { describe, expect, it } from 'vitest';
import { browserFirst, callsBrowserGate } from './vitest-sequencer.ts';

describe('browserFirst', () => {
  it('moves the gated files to the front and keeps both halves in order', () => {
    const gated = new Set(['b', 'd']);
    expect(browserFirst(['a', 'b', 'c', 'd', 'e'], (f) => gated.has(f))).toEqual([
      'b',
      'd',
      'a',
      'c',
      'e',
    ]);
  });

  it('changes nothing when no file is gated — the control', () => {
    expect(browserFirst(['a', 'b', 'c'], () => false)).toEqual(['a', 'b', 'c']);
  });

  it('drops and duplicates nothing', () => {
    const files = Array.from({ length: 50 }, (_, i) => `f${i}`);
    const out = browserFirst(files, (f) => Number(f.slice(1)) % 3 === 0);
    expect([...out].sort()).toEqual([...files].sort());
  });
});

describe('callsBrowserGate', () => {
  const text: Record<string, string> = {
    gated: "const CHROME = chromeForSuite();\ndescribe.skipIf(CHROME === null)('x', () => {});",
    named: "// see chromeForSuite in scripts/browser-tests.ts\nit('x', () => {});",
    plain: "it('x', () => {});",
  };
  const read = (p: string) => {
    const t = text[p];
    if (t === undefined) throw new Error(`ENOENT ${p}`);
    return t;
  };

  it('is true for a file that calls the gate', () => {
    expect(callsBrowserGate('gated', read)).toBe(true);
  });

  it('is false for a file that only names it, or never mentions it', () => {
    expect(callsBrowserGate('named', read)).toBe(false);
    expect(callsBrowserGate('plain', read)).toBe(false);
  });

  it('is false, not a throw, for a file it cannot read', () => {
    expect(callsBrowserGate('missing', read)).toBe(false);
  });
});
