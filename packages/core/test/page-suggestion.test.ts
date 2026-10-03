import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createWordsAnchor } from '../src/anchor/element.ts';
import { readPageSuggestion, suggestedEdit } from '../src/page-edits.ts';
import { createThread, listThreads } from '../src/schema.ts';

/** An agent's suggested words: what is stored, read back, and what Accept makes of them. */

const AT = {
  anchor: {
    kind: 'element' as const,
    fingerprint: { tag: 'P', stableAttrs: {}, classes: [], text: 'x', path: 'P[0]', dataAttrs: {} },
    snippet: { text: 'x' },
  },
  selector: 'p.lede',
  before: 'Join the  Riverbend walk on Sunday.',
};

describe('a page suggestion', () => {
  it('becomes the page edit of its element, first occurrence only', () => {
    const edit = suggestedEdit(AT, {
      find: 'Riverbend walk',
      replacement: 'Riverbend Street walk',
    });
    expect(edit?.before).toBe('Join the Riverbend walk on Sunday.');
    expect(edit?.after).toBe('Join the Riverbend Street walk on Sunday.');
    expect(suggestedEdit(AT, { find: 'Sunday.', replacement: '' })?.after).toBe(
      'Join the Riverbend walk on',
    );
  });

  it('is no edit when the element no longer says the words', () => {
    expect(suggestedEdit(AT, { find: 'Saltmarsh', replacement: 'Harborlight' })).toBeNull();
  });

  it('reads only a whole one back', () => {
    expect(readPageSuggestion({ find: 'a', replacement: 'b' })).toEqual({
      find: 'a',
      replacement: 'b',
    });
    for (const bad of [
      null,
      'a',
      { find: '', replacement: 'b' },
      { find: 'a' },
      { find: 'a', replacement: 'a' },
    ]) {
      expect(readPageSuggestion(bad)).toBeUndefined();
    }
  });

  it('survives the thread store', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't-1',
      anchor: createWordsAnchor('Riverbend walk'),
      createdBy: {
        id: 'agent-harborlight',
        name: 'Harborlight site',
        kind: 'known',
        color: '#e36f1e',
      },
      firstComment: {
        id: 'c-1',
        text: 'Name it?',
        pageSuggestion: { find: 'Riverbend walk', replacement: 'Riverbend Street walk' },
      },
    });
    expect(listThreads(doc)[0]?.comments[0]?.pageSuggestion).toEqual({
      find: 'Riverbend walk',
      replacement: 'Riverbend Street walk',
    });
  });
});
