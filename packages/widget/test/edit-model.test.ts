import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EditDrafts,
  cssPath,
  editableTarget,
  markFor,
  normText,
  sentEdits,
} from '../src/edit/edit-model.ts';

/**
 * The rules of edit mode that need no screen: which element a tap edits, the
 * short path the agent is handed, what an unsent draft holds and gives back,
 * and which mark a sent edit wears. All fixtures synthetic.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const page = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body;
};

describe('editableTarget', () => {
  it('edits the text element a tap lands in, inline markup and all', () => {
    page('<main><p id="p">Riverbend <b>opens</b> at nine.</p></main>');
    const b = document.querySelector('b') as HTMLElement;
    expect(editableTarget(b)?.id).toBe('p');
  });

  it('refuses a block that holds other blocks, and a control that holds a value', () => {
    page('<div id="d"><p>One</p><p>Two</p></div><input id="i" value="x">');
    expect(editableTarget(document.getElementById('d') as HTMLElement)).toBeNull();
    expect(editableTarget(document.getElementById('i') as HTMLElement)).toBeNull();
  });

  it('edits a heading that holds its own anchor link and icon, as a static site builds one', () => {
    page(
      '<article><h2 id="riverbend">Riverbend landing' +
        '<a class="heading-anchor" href="#riverbend" aria-hidden="true">' +
        '<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"></path></svg></a></h2></article>',
    );
    const h2 = document.querySelector('h2') as HTMLElement;
    expect(editableTarget(h2)).toBe(h2);
    // A tap on the icon edits the heading it sits in.
    expect(editableTarget(document.querySelector('a') as HTMLElement)).toBe(h2);
  });

  it('refuses the widget itself and an element with no words', () => {
    page('<div data-feedback-widget><p id="w">Undo</p></div><p id="e">  </p>');
    expect(editableTarget(document.getElementById('w') as HTMLElement)).toBeNull();
    expect(editableTarget(document.getElementById('e') as HTMLElement)).toBeNull();
  });
});

describe('cssPath', () => {
  it('names the last steps, skips the wrappers, and counts siblings of a tag', () => {
    page(
      '<main><section><table><tbody><tr><td>a</td><td id="t">Riverbend Way</td></tr></tbody></table></section></main>',
    );
    expect(cssPath(document.getElementById('t') as HTMLElement)).toBe(
      'table > tr > td:nth-of-type(2)',
    );
  });

  it('uses the first class that is not the widget’s own', () => {
    page('<header><h1 class="cw-editing hero">Harborlight</h1></header>');
    expect(cssPath(document.querySelector('h1') as HTMLElement)).toBe('header > h1.hero');
  });
});

describe('EditDrafts', () => {
  it('holds the words as they were, and gives the element back on undo', () => {
    page('<p id="p">Riverbend <b>opens</b> at nine.</p>');
    const p = document.getElementById('p') as HTMLElement;
    const drafts = new EditDrafts();
    drafts.begin(p);
    p.textContent = 'Riverbend opens at ten.';
    expect(drafts.changed()).toEqual([
      expect.objectContaining({
        selector: 'p',
        before: 'Riverbend opens at nine.',
        after: 'Riverbend opens at ten.',
      }),
    ]);
    drafts.undo(p);
    expect(p.innerHTML).toBe('Riverbend <b>opens</b> at nine.');
    expect(drafts.changed()).toEqual([]);
  });

  it('fingerprints the element as it was, so a reload finds it again', () => {
    page('<h1>Harborlight Projects</h1>');
    const h = document.querySelector('h1') as HTMLElement;
    const drafts = new EditDrafts();
    drafts.begin(h);
    h.textContent = 'Harborlight Works';
    expect(drafts.changed()[0]?.anchor.fingerprint.text).toBe('Harborlight Projects');
  });

  it('counts a draft typed back to its first words as no edit', () => {
    page('<h1>Harborlight</h1>');
    const h = document.querySelector('h1') as HTMLElement;
    const drafts = new EditDrafts();
    drafts.begin(h);
    h.textContent = 'Harborlight ';
    expect(drafts.changed()).toEqual([]);
  });
});

describe('a draft with a new paragraph', () => {
  it('sends the paragraphs as blocks joined by a blank line', () => {
    page('<p id="p">Riverbend opens at nine. Saltmarsh closes at six.</p>');
    const p = document.getElementById('p') as HTMLElement;
    const drafts = new EditDrafts();
    drafts.begin(p);
    p.innerHTML = 'Riverbend opens at nine.<br>Saltmarsh closes at six.<br><br>';
    expect(drafts.changed()[0]?.after).toBe('Riverbend opens at nine.\n\nSaltmarsh closes at six.');
    expect(drafts.changed()[0]?.before).toBe('Riverbend opens at nine. Saltmarsh closes at six.');
  });

  it('marks a split paragraph applied once the page shows its words', () => {
    const edit = {
      anchor: createAnchor(page('<p>x</p>').firstElementChild as HTMLElement),
      selector: 'p',
      before: 'Riverbend opens. Saltmarsh closes.',
      after: 'Riverbend opens.\n\nSaltmarsh closes.',
    };
    expect(markFor(true, edit, 'Riverbend opens. Saltmarsh closes.', false)).toBe('applied');
  });
});

describe('sent edits and their marks', () => {
  const edit = {
    anchor: {
      kind: 'element' as const,
      fingerprint: {
        tag: 'H1',
        stableAttrs: {},
        classes: [],
        text: 'Harborlight Projects',
        path: 'H1[0] > BODY[0]',
        dataAttrs: {},
      },
      snippet: { text: 'Harborlight Projects' },
    },
    selector: 'h1',
    before: 'Harborlight Projects',
    after: 'Harborlight Works',
  };
  const threads = {
    t1: { id: 't1', status: 'open', comments: [{ text: 'x', pageEdits: [edit] }] },
    t2: { id: 't2', status: 'resolved', comments: [{ text: 'y', pageEdits: [edit] }] },
    t3: { id: 't3', status: 'open', comments: [{ text: 'a plain comment' }] },
  };

  it('reads the sends off the threads, and nothing else', () => {
    expect(sentEdits(threads).map((s) => [s.threadId, s.open])).toEqual([
      ['t1', true],
      ['t2', false],
    ]);
  });

  it('marks an open send pending until the page shows its words', () => {
    expect(markFor(true, edit, 'Harborlight Projects', false)).toBe('pending');
    // The agent changed the source and the page reloaded.
    expect(markFor(true, edit, 'Harborlight Works', false)).toBe('applied');
    // The reviewer's own typing is not the agent's change.
    expect(markFor(true, edit, 'Harborlight Works', true)).toBe('pending');
    expect(markFor(false, edit, 'Harborlight Projects', false)).toBe('applied');
  });

  it('compares words, not whitespace', () => {
    expect(normText('  Harborlight\n   Works ')).toBe('Harborlight Works');
  });
});
