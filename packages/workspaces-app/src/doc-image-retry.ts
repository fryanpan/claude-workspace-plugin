/**
 * A doc image that failed asks again until its file lands.
 *
 * The assets route resolves the file on every request, but a browser never
 * re-requests an `<img>` that has fired `error`: a doc opened before its
 * image was written stayed blank until a reload. So a failed doc-asset image
 * is re-requested every second while the page is visible, every ten seconds
 * once it has been failing for a minute, and never again once it loads or
 * leaves the DOM.
 *
 * The retry changes the DOM's `src` only, adding `?r=<n>` so the browser
 * cannot answer from its record of the failure. The node keeps the path as
 * written, and `fromDisplaySrc` drops the query on a paste.
 */

export interface RetryClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const RETRY_FAST_MS = 1_000;
export const RETRY_SLOW_MS = 10_000;
/** How long an image fails at the fast cadence before it slows down. */
export const RETRY_FAST_FOR_MS = 60_000;

const realClock: RetryClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Retry {
  attempt: number;
  failingSince: number;
  timer: unknown;
}

/**
 * Retries every failed `<img>` under `root` whose `src` is under `base`.
 * Returns the function that stops it and cancels every pending retry.
 */
export function retryFailedDocImages(
  root: HTMLElement,
  base: string,
  clock: RetryClock = realClock,
  isVisible: () => boolean = () => document.visibilityState !== 'hidden',
): () => void {
  const pending = new Map<HTMLImageElement, Retry>();

  const schedule = (img: HTMLImageElement, retry: Retry) => {
    const failedFor = clock.now() - retry.failingSince;
    const delay = failedFor < RETRY_FAST_FOR_MS ? RETRY_FAST_MS : RETRY_SLOW_MS;
    retry.timer = clock.setTimeout(() => fire(img, retry), delay);
  };

  const fire = (img: HTMLImageElement, retry: Retry) => {
    retry.timer = null;
    if (!img.isConnected) {
      pending.delete(img);
      return;
    }
    // A hidden tab spends nothing; it asks on the next tick it is visible.
    if (!isVisible()) {
      schedule(img, retry);
      return;
    }
    retry.attempt += 1;
    const src = img.getAttribute('src') ?? '';
    img.setAttribute('src', `${src.split('?')[0]}?r=${retry.attempt}`);
  };

  const onError = (e: Event) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!(img.getAttribute('src') ?? '').startsWith(base)) return;
    let retry = pending.get(img);
    if (!retry) {
      retry = { attempt: 0, failingSince: clock.now(), timer: null };
      pending.set(img, retry);
    }
    if (retry.timer === null) schedule(img, retry);
  };

  const onLoad = (e: Event) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const retry = pending.get(img);
    if (!retry) return;
    if (retry.timer !== null) clock.clearTimeout(retry.timer);
    pending.delete(img);
  };

  // `error` and `load` do not bubble, so listen in the capture phase.
  root.addEventListener('error', onError, true);
  root.addEventListener('load', onLoad, true);
  return () => {
    root.removeEventListener('error', onError, true);
    root.removeEventListener('load', onLoad, true);
    for (const retry of pending.values()) {
      if (retry.timer !== null) clock.clearTimeout(retry.timer);
    }
    pending.clear();
  };
}
