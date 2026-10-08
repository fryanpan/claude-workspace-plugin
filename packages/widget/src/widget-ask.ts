import {
  type DockItem,
  answerHtml,
  dockRounds,
  threadAsk,
  wireAnswer,
} from '@claude-workspaces/core/review-dock';
import type { Thread } from '@claude-workspaces/core/types';
import { STATUS_COLORS, escapeHtml as esc } from '@claude-workspaces/core/ui-shared';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * A thread's review item, answered in the thread's popover on the page.
 *
 * An agent answers a reader's comment with a decision or a question
 * (`post_reply` with a `review` payload). The budgeted bundle draws that reply
 * as its plain words, so the reader had to leave the page for Home to answer
 * it. This puts the ask itself in the popover — the headline, the detail with
 * its links, a button per option or a box for a question's answer — and marks
 * the thread's row in the panel. The answer goes through the doc's thread
 * `/answer` route, the one Home answers a thread item through, so it leaves
 * Home's queue and reaches the agent the same way. Inside a mock frame that
 * call is relayed by the host page (`mock-relay-policy.ts`), which lets it
 * reach only this doc's threads.
 *
 * Which items show, and how an answer is wired, are `core/review-dock.ts`'s,
 * shared with the dock. A HELD or withdrawn item shows nothing; an answered
 * one shows what was picked; a revised one shows its latest words.
 *
 * It rides in `mic.js` and `mockup-live.js`, which load with every page the
 * widget is a guest on, rather than in the budgeted bundle: the base bundle
 * gives its rows a `data-thread-id` and nothing else. The thread is read off
 * the raw thread map, as `edit/edit-suggest.ts` reads its own, so this script
 * needs no Yjs of its own. Calm: a steady mark, no count, no motion.
 */

export const ASK_CSS = [
  '.cw-ask{flex:none;margin-top:6px;padding:8px;border:1px solid #eaeef2;border-radius:6px;max-height:40vh;overflow-y:auto;font-size:13px}',
  '.cw-ask .cw-modal-answer,.cw-ask .cw-modal-answered{border:0;padding:8px 0 0}',
  '.cw-ask-note{color:#6e7781;font-size:12px;margin-top:6px}',
  // The row's dot gains the white eye a review pin wears, at the same size.
  `.thread[data-ask] .dot{background:#fff;box-shadow:inset 0 0 0 2px ${STATUS_COLORS.open}}`,
].join('');

/** The thread under `id`, as plain values, with the id its map key holds. */
function rawThread(widget: FeedbackWidgetEl, id: string): Thread | null {
  const raw = (
    widget.client?.ydoc.getMap('threads').get(id) as { toJSON?: () => unknown } | undefined
  )?.toJSON?.() as Thread | undefined;
  return raw && Array.isArray(raw.comments) ? { ...raw, id } : null;
}

/** The ask a thread holds for the reader now, or null — see `threadAsk`. */
export function askOf(widget: FeedbackWidgetEl, id: string): DockItem | null {
  const t = rawThread(widget, id);
  return t ? threadAsk(t) : null;
}

/** The ask's markup: its latest round, then how it was answered or the way to. */
export function askHtml(item: DockItem): string {
  const r = item.review;
  const rounds = dockRounds(r).length;
  const picked = r.options?.find((o) => o.id === r.answeredWith)?.label;
  const said = r.answerText && r.answerText !== picked ? `<span>${esc(r.answerText)}</span>` : '';
  const answer = item.answered
    ? `<div class="cw-modal-answered"><b>Answered${picked ? `: ${esc(picked)}` : ''}</b>${said}</div>`
    : r.ownerOnly
      ? // The board answers an owner-only ask for its owner alone, and this
        // page may be open to anyone it is shared with; the dock leaves such
        // an ask out for the same reason.
        '<div class="cw-ask-note">Only the board’s owner can answer this, on Home.</div>'
      : answerHtml(item);
  return `<div class="cw-round-head"><b>${r.options?.length ? 'Decision' : 'Question'}</b>${
    rounds > 1 ? `<span>Round ${rounds}</span>` : ''
  }</div><div class="cw-round-headline">${esc(r.headline)}</div>${
    r.detail ? `<p class="cw-round-body">${esc(r.detail)}</p>` : ''
  }${answer}`;
}

/** Draw `item` into `block` and wire its answer. An accepted answer redraws
 *  it as answered at once, before the doc's own update comes back. */
function fill(widget: FeedbackWidgetEl, block: HTMLElement, item: DockItem): void {
  block.innerHTML = askHtml(item);
  let sent: { text: string; optionId?: string } = { text: '' };
  wireAnswer(block, {
    send: (text, optionId) => {
      sent = { text, ...(optionId !== undefined ? { optionId } : {}) };
      return widget.postAnswer(item.threadId, item.commentId, text, optionId);
    },
    onAnswered: () => {
      const review = { ...item.review, answeredAt: Date.now(), answerText: sent.text };
      if (sent.optionId !== undefined) review.answeredWith = sent.optionId;
      fill(widget, block, { ...item, review, answered: true });
    },
  });
}

/** Give one popover its ask, when the thread it shows has one. */
function decorate(widget: FeedbackWidgetEl, pop: HTMLElement, id: string | null): void {
  if (!id || pop.querySelector('.cw-ask')) return;
  const item = askOf(widget, id);
  if (!item) return;
  const block = document.createElement('div');
  block.className = 'cw-ask';
  block.dataset.threadId = id;
  fill(widget, block, item);
  pop.querySelector('.actions')?.before(block);
}

/**
 * Mark what the base bundle drew: a row whose thread has an open ask gains
 * `data-ask`, and a pin the base bundle marked for a HELD item — which it
 * cannot tell from an open one — goes back to an ordinary open pin.
 */
export function markAsks(widget: FeedbackWidgetEl): void {
  const open = (id: string | undefined): boolean => {
    const item = id ? askOf(widget, id) : null;
    return !!item && !item.answered;
  };
  for (const row of widget.shadow.querySelectorAll<HTMLElement>('.thread[data-thread-id]')) {
    row.toggleAttribute('data-ask', open(row.dataset.threadId));
  }
  for (const pin of widget.pinLayer?.querySelectorAll<HTMLElement>('.cfw-pin') ?? []) {
    if (pin.dataset.state === 'review' && !open(pin.dataset.threadId)) pin.dataset.state = 'open';
  }
}

/**
 * Watch the widget's popovers and rows from now on. The base bundle draws a
 * popover without saying whose it is, so the thread is the one the reader
 * just opened: the pin tapped, or else the row tapped, which sets
 * `activeThread` — the reading `edit/edit-suggest.ts` makes too.
 */
export function mountAsks(widget: FeedbackWidgetEl): void {
  const shadow = widget.shadow;
  if (!shadow || shadow.querySelector('style[data-cw-ask]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-cw-ask', '');
  style.textContent = ASK_CSS;
  shadow.append(style);
  let pinned: string | null = null;
  document.addEventListener(
    'click',
    (ev) => {
      const pin = (ev.target as Element | null)?.closest?.('.cfw-pin') as HTMLElement | null;
      pinned = pin?.dataset.threadId ?? null;
    },
    true,
  );
  const scan = (): void => {
    for (const pop of shadow.querySelectorAll<HTMLElement>('.thread-popover'))
      decorate(widget, pop, pinned ?? widget.activeThread);
    markAsks(widget);
  };
  const watch = new MutationObserver(scan);
  watch.observe(shadow, { childList: true, subtree: true });
  if (widget.pinLayer) watch.observe(widget.pinLayer, { childList: true });
  scan();
}
