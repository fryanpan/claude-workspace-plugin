import type { Anchor, AnchorContext, User } from '@claude-workspaces/core';
import { createThread } from '@claude-workspaces/core';
import { vi } from 'vitest';
import type * as Y from 'yjs';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * The widget element a render needs, over a real Yjs doc, for the page-pin
 * and page-list tests. The same stand-in the other render tests build, with a
 * current context, so a thread's page can be told from the page it is on.
 * Fixture names only.
 */

export const ALICE: User = { id: 'u-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };

export function widgetAt(ydoc: Y.Doc, url: string): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel-threads"></div>';
  document.body.append(host);
  const pinLayer = document.createElement('div');
  pinLayer.className = 'cfw-overlay';
  document.body.append(pinLayer);
  const el = Object.assign(host, {
    shadow,
    user: ALICE,
    pinLayer,
    threadPositions: new Map(),
    currentContext: { url } as AnchorContext,
    showResolved: false,
    activeThread: null,
    listHook: null,
    client: { ydoc },
    scheduleRender: () => {},
  }) as unknown as FeedbackWidgetEl;
  return el;
}

/** A thread on `anchor`, written at `ts` on the injected clock. */
export function thread(
  ydoc: Y.Doc,
  id: string,
  anchor: Anchor,
  ts: number,
  text = 'Say which pier',
) {
  vi.setSystemTime(ts);
  createThread(ydoc, {
    threadId: id,
    anchor,
    createdBy: ALICE,
    firstComment: { id: `c-${id}`, text },
  });
}

/** A box for an element happy-dom cannot lay out. */
export function box(el: Element, left: number, top: number, width: number, height: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    }) as DOMRect;
}

export const pins = (el: FeedbackWidgetEl): HTMLElement[] =>
  [...(el.pinLayer as HTMLElement).children] as HTMLElement[];

export const pinOf = (el: FeedbackWidgetEl, id: string): HTMLElement | undefined =>
  pins(el).find((p) => p.dataset.threadId === id);
