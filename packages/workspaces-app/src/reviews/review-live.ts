/**
 * The cross-board review (`/review`) hears every ask filed or answered on
 * any board, on the workspaces list's one stream (`/landing/events:stream`).
 * A frame naming `boards` means the review queue may have moved; the page
 * re-reads `/api/review-queue` and merges the answer (`mergeLiveQueue`).
 *
 * One stream for every board, because a browser holds six connections per
 * host and the owner has more boards than that.
 *
 * The merge never moves the reader's card. A new ask joins the queue in the
 * server's order. A card the reader is on that left the queue (answered or
 * withdrawn elsewhere) stays in its place and is drawn closed, until the
 * reader steps away from it.
 *
 * Catch-up: the stream replays nothing, so when it reopens after an error the
 * page re-reads once. A hidden tab defers its re-read until it is shown.
 */
import type { CrossEntry } from './cross-walk-model.ts';

export const REVIEW_STREAM_URL = '/landing/events:stream';

export interface MergedQueue {
  entries: CrossEntry[];
  /** The reader's card, when it is no longer waiting on anyone. */
  closedKey: string | null;
}

/**
 * The fresh queue, with the reader's card kept where it was when it has left
 * it: after the nearest card before it that is still open, or first.
 */
export function mergeLiveQueue(
  shown: readonly CrossEntry[],
  fresh: readonly CrossEntry[],
  currentKey: string | null,
): MergedQueue {
  const entries = [...fresh];
  if (currentKey === null || fresh.some((e) => e.item.key === currentKey)) {
    return { entries, closedKey: null };
  }
  const at = shown.findIndex((e) => e.item.key === currentKey);
  const current = shown[at];
  if (!current) return { entries, closedKey: null };
  let insert = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const key = shown[i]?.item.key;
    const found = entries.findIndex((e) => e.item.key === key);
    if (found >= 0) {
      insert = found + 1;
      break;
    }
  }
  entries.splice(insert, 0, current);
  return { entries, closedKey: currentKey };
}

export interface ReviewLiveOptions {
  openStream?: (url: string) => EventSource;
  /** How long a burst of frames gathers before one re-read. */
  debounceMs?: number;
}

/** Whether a frame can have moved the review queue. A frame naming no
 *  parts comes from an older server, whose frames were all board changes. */
function touchesQueue(data: unknown): boolean {
  try {
    const parts = (JSON.parse(String(data)) as { parts?: unknown }).parts;
    return !Array.isArray(parts) || parts.includes('boards');
  } catch {
    return true;
  }
}

/** Call `reread` after each burst of board changes. Returns the unwiring. */
export function startReviewLive(
  reread: () => Promise<void>,
  opts: ReviewLiveOptions = {},
): () => void {
  if (!opts.openStream && typeof EventSource === 'undefined') return () => {};
  const debounceMs = opts.debounceMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let deferred = false;

  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await reread();
    } catch {
      // The walk keeps what it showed; the next frame retries.
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      void run();
    }
  };
  const schedule = (): void => {
    if (document.visibilityState === 'hidden') {
      deferred = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'hidden' || !deferred) return;
    deferred = false;
    schedule();
  };

  const stream = (opts.openStream ?? ((u) => new EventSource(u)))(REVIEW_STREAM_URL);
  let dropped = false;
  stream.addEventListener('landing.changed', (ev) => {
    if (touchesQueue((ev as MessageEvent).data)) schedule();
  });
  stream.addEventListener('error', () => {
    dropped = true;
  });
  stream.addEventListener('open', () => {
    if (!dropped) return;
    dropped = false;
    schedule();
  });
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
    stream.close();
  };
}
