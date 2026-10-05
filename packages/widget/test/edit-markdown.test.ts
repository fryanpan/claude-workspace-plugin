import { afterEach, describe, expect, it } from 'vitest';
import { renderMarkdown, toMarkdown } from '../src/edit/edit-markdown.ts';
import { EditDrafts, markFor } from '../src/edit/edit-model.ts';

/**
 * An edited element as the markdown its edit's `after` carries, and that
 * markdown shown on the page again after a reload. All fixtures synthetic.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const el = (html: string): HTMLElement => {
  document.body.innerHTML = `<p id="p">${html}</p>`;
  return document.getElementById('p') as HTMLElement;
};

describe('toMarkdown', () => {
  it('keeps an existing link through an edit of the words around it', () => {
    const p = el('See the <a href="/ferry">Saltmarsh ferry</a> times.');
    const drafts = new EditDrafts();
    drafts.begin(p);
    (p.lastChild as Text).data = ' timetable.';
    expect(drafts.changed()[0]?.after).toBe('See the [Saltmarsh ferry](/ferry) timetable.');
  });

  it('writes bold, italic and code, with spaces outside the marks', () => {
    expect(toMarkdown(el('Riverbend <b>opens </b>at <em>nine</em>, <code>gate*2</code>'))).toBe(
      'Riverbend **opens** at *nine*, `gate*2`',
    );
  });

  it('escapes the characters the marks are made of', () => {
    expect(toMarkdown(el('2 * 3 [Bob]'))).toBe('2 \\* 3 \\[Bob\\]');
  });

  it('leaves out a link that goes nowhere safe, and one with no words', () => {
    expect(
      toMarkdown(el('<a href="javascript:void(0)">Riverbend</a><a href="#x"><svg></svg></a>')),
    ).toBe('Riverbend');
  });

  it('marks each paragraph on its own when bold runs across a break', () => {
    expect(toMarkdown(el('<b>Riverbend<br>Saltmarsh</b>'))).toBe('**Riverbend**\n\n**Saltmarsh**');
  });
});

describe('renderMarkdown', () => {
  it('shows the marks again, and reads back to the same markdown', () => {
    const md = 'Riverbend **opens** at *nine*.\n\nSee [the ferry](/ferry) and `gate`.';
    const p = el('x');
    renderMarkdown(p, md);
    expect(p.querySelector('b')?.textContent).toBe('opens');
    expect(p.querySelector('a')?.getAttribute('href')).toBe('/ferry');
    expect(toMarkdown(p)).toBe(md);
  });

  it('never builds a link to a script', () => {
    const p = el('x');
    renderMarkdown(p, '[Riverbend](javascript:alert)');
    expect(p.querySelector('a')).toBeNull();
    expect(p.textContent).toBe('Riverbend');
  });
});

describe('formatting as an edit', () => {
  it('counts bolding a word as a change, though the words are the same', () => {
    const p = el('Riverbend opens at nine.');
    const drafts = new EditDrafts();
    drafts.begin(p);
    p.innerHTML = 'Riverbend <b>opens</b> at nine.';
    expect(drafts.changed().map((e) => e.after)).toEqual(['Riverbend **opens** at nine.']);
  });

  it('marks a formatted edit applied once the page shows its words', () => {
    const p = el('Riverbend opens at nine.');
    const drafts = new EditDrafts();
    drafts.begin(p);
    p.innerHTML = 'Riverbend <b>opens</b> at [ten].';
    const edit = drafts.changed()[0];
    if (!edit) throw new Error('no edit');
    expect(markFor(true, edit, 'Riverbend opens at [ten].', false)).toBe('applied');
  });
});
