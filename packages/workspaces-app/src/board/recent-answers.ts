/**
 * The way back to an answer given by mistake.
 *
 * `GET /workspaces/:id/review-items` ships `answered`: every ticket item
 * answered in the last day. Home folds the reader's own under the queue,
 * each with an Undo that reopens the item, and the walkthrough's "just
 * answered" banner offers the same Undo. The server lets only the answerer
 * change an answer (`review-items/answer-change.ts`), so a row is offered only
 * to the person who answered it.
 */

/** One answered ticket item, as the server ships it. */
export interface RecentAnswer {
  /** The queue key the item had while open. */
  key: string;
  taskId: string;
  reviewItemId: string;
  headline: string;
  answer: string;
  by: string;
  ts: number;
}

/** The ticket's own decision, addressed by the id the server derives for it. */
const LEGACY_ID = 'r-legacy';

/**
 * The reader's own answers, minus any already back on the queue — an undo
 * the next read has not yet dropped from the list must not be offered twice.
 */
export function ownRecentAnswers(
  answers: readonly RecentAnswer[],
  selfName: string,
  liveKeys: ReadonlySet<string>,
): RecentAnswer[] {
  return answers.filter((a) => a.by === selfName && !liveKeys.has(a.key));
}

/**
 * Where the undo for a queue item goes, or undefined for a kind with no
 * ticket-item undo (a thread reply is taken back on its thread, and the
 * route refuses a secret or grant item). One route
 * serves both ticket kinds: it accepts the ticket's own decision as
 * `r-legacy`. The item is read structurally so this module imports nothing
 * back from `board-review-model.ts`.
 */
export function undoTarget(item: {
  kind: string;
  decision?: { task: { id: string } };
  thread?: { taskId?: string; reviewItemId?: string };
  review?: { shape?: string };
}): { taskId: string; reviewItemId: string } | undefined {
  if (item.review?.shape === 'secret' || item.review?.shape === 'grant') return undefined;
  if (item.kind === 'decision' && item.decision) {
    return { taskId: item.decision.task.id, reviewItemId: LEGACY_ID };
  }
  if (item.kind === 'task-review' && item.thread?.taskId && item.thread.reviewItemId) {
    return { taskId: item.thread.taskId, reviewItemId: item.thread.reviewItemId };
  }
  return undefined;
}
