import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { renderThreadsInto } from '../src/widget-threads.ts';
import { pinOf, pins, thread, widgetAt } from './page-fixture.ts';

/**
 * "I can't see where I made comments on the page. It's very disorienting."
 *
 * A site that keeps every control in its address — `?o=ss`, `?all=1` — moved
 * the address under each comment, and a pin matched on the whole address, so
 * a toggle took the earlier pins off the page. A map drew one canvas that many
 * threads anchored to, and its pins stood at the canvas's corner rather than
 * where they were put. A chart rebuilt its bars on every render, and a bar
 * has no words to be found by again.
 *
 * Each case here is one of those, driven through the widget's own renderer.
 * Fixture names only; the clock is injected.
 */

const T0 = 1_760_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

/** The page at `url`, holding one heading to comment on. */
function pageAt(url: string): HTMLElement {
  history.replaceState(null, '', url);
  document.body.innerHTML = '<main><h1 id="h">Harborlight case</h1></main>';
  return document.getElementById('h') as HTMLElement;
}

describe('a pin on a page whose address carries its controls', () => {
  it('stands, dimmed, when only the query differs, and its tap restores that query', () => {
    const h = pageAt('/case/harborlight/?all=1');
    const ydoc = new Y.Doc();
    const at = (url: string) => ({ ...createAnchor(h), context: { url } });
    thread(ydoc, 't-here', at('/case/harborlight/?all=1'), T0);
    thread(ydoc, 't-view', at('/case/harborlight/?top=5&o=ss%2Cwb'), T0 + 1);
    thread(ydoc, 't-away', at('/case/riverbend/?all=1'), T0 + 2);
    const el = widgetAt(ydoc, '/case/harborlight/?all=1');
    renderThreadsInto(el);

    // The thread made in this very state is pinned as it always was.
    expect(pinOf(el, 't-here')?.hasAttribute('data-dim')).toBe(false);
    // The one made with other controls set is pinned too, dimmed.
    expect(pinOf(el, 't-view')?.hasAttribute('data-dim')).toBe(true);
    // A thread on another page is not pinned here at all.
    expect(pinOf(el, 't-away')).toBeUndefined();
    expect(pins(el)).toHaveLength(2);

    pinOf(el, 't-view')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // That query, exactly as it was written, and which thread to show there.
    expect(location.pathname + location.search).toBe(
      '/case/harborlight/?top=5&o=ss%2Cwb&cw-goto=t-view',
    );
  });

  it('keeps a view-keyed thread off a page in another view, as before', () => {
    const h = pageAt('/case/harborlight/');
    const ydoc = new Y.Doc();
    thread(
      ydoc,
      't-modal',
      { ...createAnchor(h), context: { url: '/case/harborlight/?o=ss', view: 'modal=edit' } },
      T0,
    );
    const el = widgetAt(ydoc, '/case/harborlight/');
    renderThreadsInto(el);
    expect(pins(el)).toHaveLength(0);
  });
});
