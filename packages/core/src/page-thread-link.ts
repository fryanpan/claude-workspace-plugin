/**
 * The link a person opens for a thread on a page: an attached app's page or a
 * served mock, with `?thread=<id>` for the frame to open the thread by
 * (`mock-bridge.ts`).
 *
 * One builder for every surface that links to such a thread: the agent's
 * `threadUrl`, a review item's push link, the Home queue and the cross-board
 * review. They used to spell it four ways, and three of them sent an app
 * thread to the markdown editor or to the app's root.
 */
import type { Anchor } from './types.ts';

/** The query parameter that asks for the mock itself rather than its host. */
export const MOCK_FRAME_PARAM = 'cw-frame';

/** Query parameters the board adds to a page's address; never the app's. */
const BOARD_PARAMS = new Set([MOCK_FRAME_PARAM, 'thread']);

/** `search` without the board's parameters, every other byte as written. */
export function withoutBoardParams(search: string): string {
  const parts = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part !== '' && !BOARD_PARAMS.has(part.split('=')[0] ?? ''));
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * The page at `pageUrl` (the address the frame's widget read, which an app
 * thread's anchor keeps as its context), resolved against `docHref`, with
 * `thread` in place of the board's own query. Without a `pageUrl` it is the
 * doc itself: a mock is one page. So is a `pageUrl` outside the doc, because
 * a widget wrote it and a link must not leave the board for it.
 *
 * `docHref` may be absolute or a path; the link comes back in the same form.
 */
export function pageThreadHref(docHref: string, threadId: string, pageUrl?: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(docHref);
  const doc = new URL(docHref, 'http://page');
  let u = doc;
  try {
    const page = new URL(pageUrl ?? '', doc);
    if (page.origin === doc.origin && page.pathname.startsWith(doc.pathname)) u = page;
  } catch {}
  const rest = withoutBoardParams(u.search);
  const param = `thread=${encodeURIComponent(threadId)}`;
  const path = `${u.pathname}${rest ? `${rest}&` : '?'}${param}${u.hash}`;
  return absolute ? `${u.origin}${path}` : path;
}

/** The page a thread is pinned to: an element anchor's context. */
export function pageUrlOf(anchor: Anchor): string | undefined {
  return anchor.kind === 'element' ? anchor.context?.url : undefined;
}
