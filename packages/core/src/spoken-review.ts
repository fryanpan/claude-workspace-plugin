/**
 * The review queue by voice: what the server asks the page to write, and
 * where the page writes it.
 *
 * The server walks the queue and decides WHEN a decision is recorded (only
 * after it was read back and the speaker said yes). The page does the
 * writing, through the same routes the screen's answer button and its Undo
 * use, with the signed-in person's own identity — so a decision said aloud
 * and one tapped are the same request and leave the same record.
 *
 * In `core` because both ends read it: the server builds a `SpokenDecide`,
 * the page turns it into a request with `spokenDecisionRequest`.
 */

/** Where an answer is written: a ticket's review item, or a declared item on
 *  a doc thread. The same two addresses the queue rows carry. */
export type SpokenReviewTarget =
  | { kind: 'task-review'; taskId: string; reviewItemId: string }
  | { kind: 'doc-thread'; docId: string; threadId: string; commentId: string };

/** One write the page is asked to make, carried on a `reply` frame. */
export interface SpokenDecide {
  /** Echoed back on `decided`, so the server knows which write failed. */
  id: string;
  action: 'record' | 'undo';
  target: SpokenReviewTarget;
  /** The words recorded — the option's label, or what was said. `record` only. */
  text?: string;
  /** The option the words came from, when one was picked. `record` only. */
  optionId?: string;
}

/** The page's report on one `SpokenDecide`. */
export interface SpokenDecided {
  type: 'decided';
  id: string;
  ok: boolean;
}

const MAX_ID = 64;

/** A `decided` frame's fields, or null. */
export function parseSpokenDecided(m: Record<string, unknown>): SpokenDecided | null {
  const id = typeof m.id === 'string' ? m.id.slice(0, MAX_ID) : '';
  if (!id || typeof m.ok !== 'boolean') return null;
  return { type: 'decided', id, ok: m.ok };
}

/**
 * The route an answer to `target` is written at, relative to the board
 * (`tasks/…` or `docs/…`), and its body minus the author the caller adds.
 *
 * The board's answer card builds its declared-item requests here too
 * (`reviewReplyRequest`), so the two cannot name different doors.
 */
export function reviewAnswerRequest(
  target: SpokenReviewTarget,
  text: string,
  optionId?: string,
): { sub: string; body: Record<string, unknown> } {
  if (target.kind === 'task-review') {
    return {
      sub: `tasks/${encodeURIComponent(target.taskId)}/review-items/${encodeURIComponent(target.reviewItemId)}/answer`,
      body: { text, ...(optionId !== undefined ? { answeredWith: optionId } : {}) },
    };
  }
  return {
    sub: `docs/${encodeURIComponent(target.docId)}/threads/${encodeURIComponent(target.threadId)}/answer`,
    body: { text, commentId: target.commentId, ...(optionId !== undefined ? { optionId } : {}) },
  };
}

/** The request for one `SpokenDecide`: an answer, or the undo of one. */
export function spokenDecisionRequest(d: SpokenDecide): {
  sub: string;
  body: Record<string, unknown>;
} {
  if (d.action === 'record') return reviewAnswerRequest(d.target, d.text ?? '', d.optionId);
  const answer = reviewAnswerRequest(d.target, '');
  return d.target.kind === 'task-review'
    ? { sub: `${answer.sub}/undo`, body: {} }
    : { sub: `${answer.sub}/undo`, body: { commentId: d.target.commentId } };
}
