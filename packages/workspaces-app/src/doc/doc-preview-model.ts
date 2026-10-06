/**
 * The rules behind the doc page's app preview (`doc-preview.ts`), kept apart
 * from the DOM so each can be driven directly.
 *
 * Three of them. Which address the frame may load: only a page under one of
 * THIS board's app doors, so the pane can show nothing the board's own
 * embeds could not. Where the choice is kept: per doc, on this device, in
 * `localStorage` — the reader sets it from the page and nothing on the
 * server changes. And when the frame reloads: a short time after the last
 * change to the prose, which is after the ~800ms write-back has put it on
 * disk, unless the app's own page reloaded first.
 */
import { EMBED_PARAM } from '@claude-workspaces/core/board-embeds';
import { MOCK_FRAME_PARAM } from '@claude-workspaces/core/page-thread-link';

/** An app door's id segment, the same rule `board-embeds.ts` holds it to. */
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The app-door prefix every preview address must sit under. */
export function appDoorPrefix(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/apps/`;
}

/**
 * The frame address for what the reader typed, or null when it is not a page
 * of one of this board's apps. Resolved against `base` first, so `..`
 * segments and a foreign host are judged after the URL parser has collapsed
 * them, not before.
 */
export function previewFrameSrc(raw: string, workspaceId: string, base: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  const prefix = appDoorPrefix(workspaceId);
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash < 0 || !APP_ID_RE.test(rest.slice(0, slash))) return null;
  // The app's own page rather than the host page, and no comment widget over
  // it — the board embed's form of the same address.
  url.searchParams.set(MOCK_FRAME_PARAM, '1');
  url.searchParams.set(EMBED_PARAM, '1');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** What the reader chose for one doc on this device. */
export interface PreviewPref {
  path: string;
  open: boolean;
}

const prefKey = (docId: string): string => `cw:doc-preview:${docId}`;

/** Every storage call is wrapped: private mode throws on the accessor. */
export function readPreviewPref(docId: string): PreviewPref {
  try {
    const raw = localStorage.getItem(prefKey(docId));
    const v = raw ? (JSON.parse(raw) as Partial<PreviewPref>) : {};
    return { path: typeof v.path === 'string' ? v.path : '', open: v.open === true };
  } catch {
    return { path: '', open: false };
  }
}

export function writePreviewPref(docId: string, pref: PreviewPref): void {
  try {
    localStorage.setItem(prefKey(docId), JSON.stringify(pref));
  } catch {
    // storage unavailable — the pane still works for this visit
  }
}

/**
 * How long after the last prose change the frame reloads. The write-back
 * flushes 800ms after the last change (`doc-store-timings.ts`), and a dev
 * server needs a moment to rebuild from the file it then sees.
 */
export const PREVIEW_RELOAD_MS = 2000;

export interface ReloadScheduler {
  /** The prose changed. */
  edited(): void;
  /** The frame finished loading a page. */
  frameLoaded(): void;
  dispose(): void;
}

/**
 * Reloads the frame `delayMs` after the last edit — unless the frame loads a
 * page by itself inside that window, which is the app's own dev server
 * reloading it, and a second reload would only flash the same page.
 */
export function createReloadScheduler(opts: {
  delayMs: number;
  reload: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): ReloadScheduler {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  const cancel = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  return {
    edited() {
      cancel();
      timer = setTimer(() => {
        timer = null;
        opts.reload();
      }, opts.delayMs);
    },
    frameLoaded: cancel,
    dispose: cancel,
  };
}
