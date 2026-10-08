/**
 * How `workspace.review_item_stale` reads to the asker it wakes.
 *
 * The server sends it once, when one of this agent's open asks stops
 * applying: its anchor was orphaned, or the agent's own later reply settled
 * it. The item is already off the reader's Home; the next act is to withdraw
 * it, or to file a fresh ask if the question still stands. Kept out of the
 * channel switch so the wording can be asserted against the payload.
 */

/** The fields this line reads off the frame. */
export interface ReviewItemStalePayload {
  docId?: string;
  threadId?: string;
  commentId?: string;
  headline?: string;
  title?: string;
  rule?: string;
  note?: string;
  withdraw?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function reviewItemStaleLine(p: ReviewItemStalePayload): string {
  const ask = p.headline ? `"${truncate(p.headline, 60)}"` : 'a review item you filed';
  const on = p.title ? ` on "${truncate(p.title, 40)}"` : '';
  const why =
    p.rule === 'orphaned'
      ? 'what it was about is gone from the page'
      : 'your own later reply on its thread settled it';
  const call = p.withdraw ?? 'withdraw_review_item with its docId, threadId and commentId';
  return `[workspace.review_item_stale] your review item ${ask}${on} is off the reader's Home because ${why}. Call ${call}, or file a new item if the question still stands.`;
}
