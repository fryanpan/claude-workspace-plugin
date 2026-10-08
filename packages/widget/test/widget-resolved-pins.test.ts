import { createThread, setStatus } from '@claude-workspaces/core';
import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { mountPageList } from '../src/widget-page-list.ts';
import { renderThreadsInto } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A resolved thread leaves the page until the reader asks for it: its pin is
 * drawn only while the panel shows resolved threads, and the panel still
 * lists it behind Show resolved. Fixture names only.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function widgetOn(ydoc: Y.Doc, showResolved: boolean): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel-threads"></div>';
  document.body.append(host);
  const pinLayer = document.createElement('div');
  document.body.append(pinLayer);
  const el = Object.assign(host, {
    shadow,
    user: null,
    pinLayer,
    threadPositions: new Map(),
    currentContext: undefined,
    showResolved,
    activeThread: null,
    client: { ydoc },
    listHook: null,
    scheduleRender: () => {},
  }) as unknown as FeedbackWidgetEl;
  // The panel is drawn by the page list, which mic.js mounts on every embed.
  mountPageList(el);
  return el;
}

function page(): Y.Doc {
  document.body.innerHTML = '<h1 id="h">Harborlight Projects</h1><p id="p">Riverbend opens.</p>';
  const ydoc = new Y.Doc();
  const who = { id: 'u-alice', name: 'Alice', kind: 'known' as const, color: '#2e7dd7' };
  for (const [threadId, id] of [
    ['t-open', 'h'],
    ['t-done', 'p'],
  ] as const) {
    createThread(ydoc, {
      threadId,
      anchor: createAnchor(document.getElementById(id) as HTMLElement),
      createdBy: who,
      firstComment: { id: `c-${threadId}`, text: 'Say which pier' },
    });
  }
  setStatus(ydoc, 't-done', 'resolved');
  return ydoc;
}

const pins = (el: FeedbackWidgetEl): string[] =>
  [...(el.pinLayer as HTMLElement).children].map((p) => (p as HTMLElement).dataset.threadId ?? '');

describe('resolved threads on the page', () => {
  it('pins only the open thread by default, and keeps the resolved one in the panel', () => {
    const el = widgetOn(page(), false);
    renderThreadsInto(el);
    expect(pins(el)).toEqual(['t-open']);
    expect(el.shadow.querySelector('.resolved-toggle')?.textContent).toBe('Show resolved (1)');
  });

  it('pins the resolved thread too once the panel shows resolved ones', () => {
    const el = widgetOn(page(), true);
    renderThreadsInto(el);
    expect(pins(el)).toEqual(['t-open', 't-done']);
  });
});
