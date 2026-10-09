/**
 * Incoming Messages stays live on an open `/`.
 *
 * The store broadcasts nothing, so every write it makes (a poster's pass,
 * the owner's tap on another device, a send) tells the workspaces list's
 * feed (`landing-changes.ts`), and the page re-reads the section.
 *
 * A snooze ending is a change nobody makes: the store moves the row back to
 * open on its next read. So a timer is armed for the soonest snooze end, and
 * when it fires it reads the store, which writes the move and tells the
 * feed. The timer is re-armed after every write and every firing, and holds
 * at most the platform's largest delay, so a snooze weeks out re-arms once
 * on the way.
 */
import type { InboxStore } from './store.ts';

/** `setTimeout`'s largest delay; a longer one fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface InboxLiveDeps {
  store: Pick<InboxStore, 'list' | 'nextSnoozeEnd' | 'onChange'>;
  notify: () => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

/** Wire the store to the feed. Returns the unwiring. */
export function watchInbox(deps: InboxLiveDeps): () => void {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  let cancel: (() => void) | null = null;
  let stopped = false;
  const arm = (): void => {
    cancel?.();
    cancel = null;
    if (stopped) return;
    const at = deps.store.nextSnoozeEnd();
    if (at === undefined) return;
    cancel = schedule(
      () => {
        cancel = null;
        deps.store.list();
        arm();
      },
      Math.min(Math.max(0, at - now()), MAX_DELAY_MS),
    );
  };
  deps.store.onChange = () => {
    deps.notify();
    arm();
  };
  arm();
  return () => {
    stopped = true;
    cancel?.();
    cancel = null;
    deps.store.onChange = null;
  };
}
