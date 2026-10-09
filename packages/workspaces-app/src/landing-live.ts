/**
 * The workspaces list redraws itself when a board changes elsewhere.
 *
 * `/` is server-rendered, so a change is not applied here: the server sends
 * `landing.changed` on one stream (`packages/server/src/landing-changes.ts`)
 * and this re-reads `/` and swaps `#landing-review` and `#landing-boards` in
 * place, as `landing-coach.ts` does for its section after an answer. The
 * coach and the inbox are left alone: they keep their own wiring, and the
 * inbox may hold a reply being typed.
 *
 * The reader's place survives a swap: the review bar's tab, every fold they
 * opened or closed, and the link that has keyboard focus are carried onto the
 * new markup. A swap waits while a finger or button is down, so a tap is
 * never lost to the row being replaced under it.
 *
 * Catch-up: the stream replays nothing, so when it reopens after an error
 * the page re-reads `/` once. A hidden tab defers its re-read until it is
 * shown again, so a background tab does not render `/` for nobody.
 */

const REGIONS = ['#landing-review', '#landing-boards'];
export const LANDING_STREAM_URL = '/landing/events:stream';

export interface LandingLiveOptions {
  openStream?: (url: string) => EventSource;
  /** How long a burst of frames gathers before one re-read. */
  debounceMs?: number;
}

/** A fold's name without its count, so "Inactive workspaces 3" still
 *  matches "Inactive workspaces 4". */
const foldKey = (d: HTMLDetailsElement): string =>
  (d.querySelector(':scope > summary')?.textContent ?? '').replace(/\d+/g, '').trim();

function carryState(here: Element, fresh: Element): void {
  const open = new Map<string, boolean>();
  for (const d of here.querySelectorAll('details')) open.set(foldKey(d), d.open);
  for (const d of fresh.querySelectorAll('details')) {
    const was = open.get(foldKey(d));
    if (was !== undefined) d.open = was;
  }
  for (const r of here.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')) {
    const twin = r.id ? fresh.querySelector<HTMLInputElement>(`#${CSS.escape(r.id)}`) : null;
    if (twin) twin.checked = true;
  }
}

function carryFocus(active: Element | null, here: Element, fresh: Element): void {
  if (!(active instanceof HTMLAnchorElement) || !here.contains(active)) return;
  const href = active.getAttribute('href');
  if (href) fresh.querySelector<HTMLElement>(`a[href="${CSS.escape(href)}"]`)?.focus();
}

/** Re-read `/` and swap. False when a press began while the read was in
 *  flight: nothing is swapped, and the caller re-reads once it ends. */
async function redraw(held: () => boolean): Promise<boolean> {
  const res = await fetch('/', { credentials: 'same-origin' });
  if (!res.ok) return true;
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  if (held()) return false;
  for (const sel of REGIONS) {
    const here = document.querySelector(sel);
    const fresh = doc.querySelector(sel);
    if (!here || !fresh) continue;
    const node = document.importNode(fresh, true);
    carryState(here, node);
    const active = document.activeElement;
    here.replaceWith(node);
    carryFocus(active, here, node);
  }
  return true;
}

export function startLandingLive(opts: LandingLiveOptions = {}): () => void {
  if (!document.querySelector('#landing-boards')) return () => {};
  if (!opts.openStream && typeof EventSource === 'undefined') return () => {};
  const debounceMs = opts.debounceMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let deferred = false;
  let pressed = false;
  let heldByPress = false;

  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      if (!(await redraw(() => pressed))) heldByPress = true;
    } catch {
      // A failed re-read leaves the page as it was; the next frame retries.
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      void run();
    }
  };
  const schedule = (): void => {
    if (pressed) {
      heldByPress = true;
      return;
    }
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
    if (document.visibilityState !== 'hidden' && deferred) {
      deferred = false;
      schedule();
    }
  };

  const stream = (opts.openStream ?? ((u) => new EventSource(u)))(LANDING_STREAM_URL);
  let dropped = false;
  stream.addEventListener('landing.changed', schedule);
  stream.addEventListener('error', () => {
    dropped = true;
  });
  stream.addEventListener('open', () => {
    if (!dropped) return;
    dropped = false;
    schedule();
  });
  const onDown = (): void => {
    pressed = true;
  };
  const onUp = (): void => {
    pressed = false;
    if (!heldByPress) return;
    heldByPress = false;
    schedule();
  };
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
  return () => {
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);
    stream.close();
  };
}
