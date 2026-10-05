import { describe, expect, it } from 'vitest';
import { diffLine, mdPlain, mdSpans, pageEditsText } from '../src/page-edits-text.ts';
import type { PageEdit } from '../src/page-edits.ts';

/** An edit of an element with tag `tag`; only the tag and words matter here. */
const edit = (tag: string, before: string, after: string): PageEdit => ({
  anchor: {
    kind: 'element',
    fingerprint: { tag, stableAttrs: {}, classes: [], text: before, path: '', dataAttrs: {} },
    snippet: { text: before },
  },
  selector: tag.toLowerCase(),
  before,
  after,
});

describe('mdSpans', () => {
  it('reads bold, italic, code and links, and an escape as its character', () => {
    expect(mdSpans('A **b** *c* `d` [e **f**](/g) \\*h')).toEqual([
      { text: 'A ' },
      { b: true, text: 'b' },
      { text: ' ' },
      { i: true, text: 'c' },
      { text: ' ' },
      { code: true, text: 'd' },
      { text: ' ' },
      { href: '/g', text: 'e ' },
      { href: '/g', b: true, text: 'f' },
      { text: ' *h' },
    ]);
  });

  it('reads three stars as bold around italic', () => {
    expect(mdSpans('***x***')).toEqual([{ b: true, i: true, text: 'x' }]);
  });

  it('leaves a star with no partner as a star', () => {
    expect(mdSpans('2 * 3')).toEqual([{ text: '2 * 3' }]);
  });
});

describe('mdPlain', () => {
  it('is the words the page shows once the edit is applied', () => {
    expect(mdPlain('Riverbend **opens** at [ten](/t).\n\nSaltmarsh  closes.')).toBe(
      'Riverbend opens at ten. Saltmarsh closes.',
    );
  });
});

describe('diffLine', () => {
  it('trims unchanged words to a few either side, at word ends', () => {
    const before =
      'Harborlight ferry leaves the north pier every morning at nine and returns from Riverbend before the evening tide turns';
    const after = before.replace('nine', 'ten');
    expect(diffLine(before, after)).toBe(
      '… pier every morning at ~~nine~~ **ten** and returns from Riverbend …',
    );
  });

  it('marks a new paragraph where the reviewer split one', () => {
    expect(
      diffLine('Riverbend opens. Saltmarsh closes.', 'Riverbend opens.\n\nSaltmarsh closes.'),
    ).toBe('Riverbend opens. **¶** Saltmarsh closes.');
  });

  it('says when only the formatting changed', () => {
    expect(diffLine('Riverbend opens at nine.', 'Riverbend **opens** at nine.')).toBe(
      'Formatting: Riverbend opens at nine.',
    );
  });

  it('shows a deletion as struck words', () => {
    expect(diffLine('Riverbend Way', '')).toBe('~~Riverbend Way~~');
  });
});

describe('pageEditsText', () => {
  it('counts what was edited by kind', () => {
    const text = pageEditsText([
      edit('P', 'Riverbend opens at nine.', 'Riverbend opens at ten.'),
      edit('P', 'Saltmarsh closes.', 'Saltmarsh shuts.'),
      edit('H2', 'Harborlight', 'Harborlight Works'),
      edit('SPAN', 'Alice', 'Bob'),
    ]);
    expect(text.split('\n')[0]).toBe('Edited 2 paragraphs, 1 heading and 1 piece of text');
    expect(text.split('\n')).toHaveLength(5);
  });
});
