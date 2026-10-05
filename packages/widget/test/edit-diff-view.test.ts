import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { drawDiff, mountDiffView } from '../src/edit/edit-diff-view.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A page-edit comment in the widget reads as a diff, not as markers. Fixture
 * names only.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const TEXT = 'Edited 1 heading\n- Harborlight Street ~~Projects~~ **Works**';

function widgetWith(text: string, pageEdits: unknown): FeedbackWidgetEl {
  const ydoc = new Y.Doc();
  ydoc.getMap('threads').set('t1', new Y.Map(Object.entries({ comments: [{ text, pageEdits }] })));
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return Object.assign(host, { shadow, client: { ydoc } }) as unknown as FeedbackWidgetEl;
}

const popover = (w: FeedbackWidgetEl, text: string): HTMLElement => {
  const pop = document.createElement('div');
  pop.className = 'thread-popover';
  pop.innerHTML = '<div class="comment"><div class="body"></div></div>';
  (pop.querySelector('.body') as HTMLElement).textContent = text;
  w.shadow.append(pop);
  return pop.querySelector('.body') as HTMLElement;
};

describe('a page-edit comment in the widget', () => {
  it('strikes the deleted words and marks the new ones, with no markers left', async () => {
    const w = widgetWith(TEXT, [{ selector: 'h1' }]);
    mountDiffView(w);
    const body = popover(w, TEXT);
    await new Promise((r) => setTimeout(r, 0));
    expect(body.querySelector('del')?.textContent).toBe('Projects');
    expect(body.querySelector('ins')?.textContent).toBe('Works');
    expect(body.textContent).toBe('Edited 1 headingHarborlight Street Projects Works');
  });

  it('leaves an ordinary comment as it was written', async () => {
    const w = widgetWith('Say **which** pier', undefined);
    mountDiffView(w);
    const body = popover(w, 'Say **which** pier');
    await new Promise((r) => setTimeout(r, 0));
    expect(body.textContent).toBe('Say **which** pier');
    expect(body.querySelector('ins')).toBeNull();
  });

  it('shows only the first line in a panel row', () => {
    const el = document.createElement('div');
    drawDiff(el, TEXT, false);
    expect(el.textContent).toBe('Edited 1 heading');
  });
});
