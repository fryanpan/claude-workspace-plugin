import { createThread } from '@claude-workspaces/core';
import { createWordsAnchor } from '@claude-workspaces/core/anchor/element';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { hasOpenSuggestion } from '../src/edit/edit-button.ts';
import { mountSuggestions } from '../src/edit/edit-suggest.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * An agent's suggested words on a page: the popover gains the old and new
 * words with Accept and Reject. Accept posts the change exactly as a pencil
 * send does and resolves the suggestion; Reject resolves it and posts
 * nothing else. All fixtures synthetic.
 */

const AGENT = {
  id: 'agent-harborlight',
  name: 'Harborlight site',
  kind: 'known',
  color: '#e36f1e',
};

let fetchMock: ReturnType<typeof vi.fn>;
let statuses: Array<[string, string]>;

function page(suggestion = { find: 'Riverbend walk', replacement: 'Riverbend Street walk' }) {
  document.body.innerHTML =
    '<main><h1 class="title">Harborlight <em>events</em></h1>' +
    '<p class="lede">Join the Riverbend walk on Sunday.</p></main>';
  const ydoc = new Y.Doc();
  createThread(ydoc, {
    threadId: 't-sugg',
    anchor: createWordsAnchor('Riverbend walk'),
    createdBy: AGENT as never,
    firstComment: { id: 'c-1', text: 'Name the street?', pageSuggestion: suggestion },
  });
  const host = document.createElement('claude-feedback-widget');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  Object.assign(host, {
    shadow,
    client: { ydoc, onReady: () => {} },
    user: { id: 'u-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' },
    opts: { serverUrl: 'ws://host:8787', workspaceId: 'w-harbor', docId: 'd-mock', user: null },
    currentContext: {},
    authToken: null,
    setStatus: async (id: string, status: string) => {
      statuses.push([id, status]);
    },
  });
  const widget = host as unknown as FeedbackWidgetEl;
  return { widget, shadow, ydoc };
}

/** The popover the base bundle draws for a thread, as far as this reads it. */
function popover(shadow: ShadowRoot, threadId: string): HTMLElement {
  const pop = document.createElement('div');
  pop.className = 'thread-popover';
  pop.dataset.threadId = threadId;
  pop.innerHTML = '<div class="comments"></div><div class="actions"></div>';
  shadow.append(pop);
  return pop;
}

beforeEach(() => {
  statuses = [];
  fetchMock = vi.fn(async () => Response.json({ thread: { id: 't-edit' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe("an agent's suggestion on the page", () => {
  it('makes the loader fetch the chunk while it is waiting, and not once resolved', () => {
    const { ydoc } = page();
    const threads = ydoc.getMap('threads');
    expect(hasOpenSuggestion(threads.toJSON())).toBe(true);
    (threads.get('t-sugg') as Y.Map<unknown>).set('status', 'resolved');
    expect(hasOpenSuggestion(threads.toJSON())).toBe(false);
  });

  it('shows the old and new words with Accept and Reject in its popover', async () => {
    const { widget, shadow } = page();
    mountSuggestions(widget);
    const pop = popover(shadow, 't-sugg');
    await vi.waitFor(() => expect(pop.querySelector('.cw-sugg')).not.toBeNull());
    expect(pop.querySelector('.cw-sugg .was')?.textContent).toBe('Riverbend walk');
    expect(pop.querySelector('.cw-sugg .now')?.textContent).toBe('Riverbend Street walk');
    expect(pop.querySelector('[data-accept]')?.textContent).toBe('Accept');
    expect(pop.querySelector('[data-reject]')?.textContent).toBe('Reject');
    // Before the reply box, inside the popover.
    expect(pop.querySelector('.cw-sugg')?.nextElementSibling?.className).toBe('actions');
  });

  it('leaves a thread with no suggestion as it was', async () => {
    const { widget, shadow, ydoc } = page();
    createThread(ydoc, {
      threadId: 't-plain',
      anchor: createWordsAnchor('Harborlight'),
      createdBy: AGENT as never,
      firstComment: { id: 'c-2', text: 'Bigger?' },
    });
    mountSuggestions(widget);
    const pop = popover(shadow, 't-plain');
    const control = popover(shadow, 't-sugg');
    await vi.waitFor(() => expect(control.querySelector('.cw-sugg')).not.toBeNull());
    expect(pop.querySelector('.cw-sugg')).toBeNull();
  });

  it('Accept changes the words, posts them as a page edit, and resolves the suggestion', async () => {
    const { widget, shadow } = page();
    mountSuggestions(widget);
    const pop = popover(shadow, 't-sugg');
    await vi.waitFor(() => expect(pop.querySelector('[data-accept]')).not.toBeNull());
    (pop.querySelector('[data-accept]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(statuses).toEqual([['t-sugg', 'resolved']]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://host:8787/workspaces/w-harbor/docs/d-mock/threads');
    const body = JSON.parse(String(init.body));
    expect(body.pageEdits).toEqual([
      expect.objectContaining({
        selector: 'p.lede',
        before: 'Join the Riverbend walk on Sunday.',
        after: 'Join the Riverbend Street walk on Sunday.',
      }),
    ]);
    // A person's fingerprint, made on the page: the shape a pencil send has.
    expect(body.pageEdits[0].anchor.fingerprint.tag).toBe('P');
    expect(body.anchor).toEqual(body.pageEdits[0].anchor);
    expect(body.author.name).toBe('Alice');
    expect(document.querySelector('.lede')?.textContent).toBe(
      'Join the Riverbend Street walk on Sunday.',
    );
    expect(pop.isConnected).toBe(false);
  });

  it('keeps inline markup when the words sit in one text node', async () => {
    const { widget, shadow } = page({ find: 'Harborlight', replacement: 'Saltmarsh' });
    const ydoc = widget.client?.ydoc as Y.Doc;
    (ydoc.getMap('threads').get('t-sugg') as Y.Map<unknown>).set(
      'anchor',
      createWordsAnchor('Harborlight'),
    );
    mountSuggestions(widget);
    const pop = popover(shadow, 't-sugg');
    await vi.waitFor(() => expect(pop.querySelector('[data-accept]')).not.toBeNull());
    (pop.querySelector('[data-accept]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(statuses).toHaveLength(1));
    expect(document.querySelector('h1')?.innerHTML).toBe('Saltmarsh <em>events</em>');
  });

  it('Reject resolves the suggestion and posts nothing else', async () => {
    const { widget, shadow } = page();
    mountSuggestions(widget);
    const pop = popover(shadow, 't-sugg');
    await vi.waitFor(() => expect(pop.querySelector('[data-reject]')).not.toBeNull());
    (pop.querySelector('[data-reject]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(statuses).toEqual([['t-sugg', 'resolved']]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('.lede')?.textContent).toBe('Join the Riverbend walk on Sunday.');
  });

  it('keeps the page as it was when the post is refused', async () => {
    fetchMock.mockImplementation(async () => new Response('no', { status: 500 }));
    const { widget, shadow } = page();
    mountSuggestions(widget);
    const pop = popover(shadow, 't-sugg');
    await vi.waitFor(() => expect(pop.querySelector('[data-accept]')).not.toBeNull());
    (pop.querySelector('[data-accept]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(pop.querySelector('.cw-sugg-note')).not.toBeNull());
    expect(statuses).toEqual([]);
    expect(document.querySelector('.lede')?.textContent).toBe('Join the Riverbend walk on Sunday.');
  });
});
