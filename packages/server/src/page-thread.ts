/**
 * An agent's thread on a page it cannot see: an attached app or a served
 * mock, anchored by the words the page shows.
 *
 * `create_thread`'s `find` searches a doc's own text, and these docs hold
 * none: the page lives in a dev server or an HTML file the widget runs on.
 * So the thread is anchored the way the widget anchors a person's comment,
 * an element anchor with the page as its context, except that its
 * fingerprint is the words alone (`createWordsAnchor`) and the page finds
 * the element that says them.
 *
 * The context is the address the widget INSIDE the frame reads, because
 * `contextMatches` compares it exactly: the app's prefix on the board, the
 * page's own query with the frame flag after it (`frameSrcFor`), then the
 * hash. A mock is one page, so its threads carry no context and show on it
 * whatever version is open.
 */
import type { DocType, ElementAnchor, PageSuggestion } from '@claude-workspaces/core';
import { createWordsAnchor } from '@claude-workspaces/core/anchor/element';
import { MAX_PAGE_FIND, readPageSuggestion } from '@claude-workspaces/core/page-edits';
import { appPrefix } from './app-proxy.ts';
import { frameSrcFor } from './mockup-frame.ts';

export type PageThreadPlan =
  | { ok: true; anchor: ElementAnchor; suggestion?: PageSuggestion }
  | { ok: false; error: string };

/** The doc kinds whose words are a page the widget runs on. */
export function isPageDoc(type: DocType): type is 'app' | 'mockup' {
  return type === 'app' || type === 'mockup';
}

export interface PageThreadArgs {
  type: 'app' | 'mockup';
  /** The board the app is served under; null when the doc is on none. */
  workspaceId: string | null;
  docId: string;
  find: string;
  path?: unknown;
  suggest?: unknown;
  /** Present when the caller sent any of the markdown-only narrowing fields. */
  narrowed: boolean;
}

/** The address the widget in the frame reads for the app page at `path`, or
 *  null when `path` does not name a page inside the app. */
export function appFrameUrl(workspaceId: string, docId: string, path: string): string | null {
  const prefix = appPrefix(workspaceId, docId);
  let u: URL;
  try {
    u = new URL(path.replace(/^\/+/, ''), `http://page${prefix}`);
  } catch {
    return null;
  }
  if (!u.pathname.startsWith(prefix)) return null;
  return u.pathname + frameSrcFor(u) + u.hash;
}

/** What to store for an agent's `find` on a page, or why it is refused. */
export function pageThreadPlan(a: PageThreadArgs): PageThreadPlan {
  if (a.find.trim() === '') return { ok: false, error: 'find must name words the page shows' };
  if (a.find.length > MAX_PAGE_FIND) {
    return { ok: false, error: `find is at most ${MAX_PAGE_FIND} characters on a page` };
  }
  if (a.narrowed) {
    return {
      ok: false,
      error:
        'on a page, find is the words alone: contextBefore, contextAfter and occurrence are for ' +
        'markdown. Pass more of the words to tell two places apart.',
    };
  }
  let suggestion: PageSuggestion | undefined;
  if (a.suggest !== undefined) {
    const replacement = (a.suggest as { replacement?: unknown } | null)?.replacement;
    suggestion = readPageSuggestion({ find: a.find, replacement });
    if (!suggestion) {
      return {
        ok: false,
        error: 'suggest is { replacement }: at most 4000 characters, different from find',
      };
    }
  }
  const extra = suggestion ? { suggestion } : {};
  if (a.type === 'mockup') {
    if (a.path !== undefined) return { ok: false, error: 'a mock is one page: omit path' };
    return { ok: true, anchor: createWordsAnchor(a.find), ...extra };
  }
  if (typeof a.path !== 'string' || !a.path.startsWith('/')) {
    return {
      ok: false,
      error:
        "an app has many pages: pass path, the page's address inside the app, e.g. /calendar " +
        'or /calendar?month=june',
    };
  }
  const url = a.workspaceId ? appFrameUrl(a.workspaceId, a.docId, a.path) : null;
  if (!url) return { ok: false, error: `path ${a.path} is not a page inside this app` };
  return { ok: true, anchor: createWordsAnchor(a.find, { url }), ...extra };
}
