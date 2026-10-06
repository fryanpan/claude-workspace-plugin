/**
 * Changing an answer already given on one of a ticket's review items.
 *
 * Answering is one tap with no confirmation, so a wrong tap has to be
 * fixable: the person undoes it and picks again, or answers over it. Three
 * rules make that safe, and they live here so the four writers (a ticket
 * item's answer and undo, the ticket's own decision's answer and undo) apply
 * the same ones.
 *
 * - **Only the person who answered may change it.** Anyone else's re-answer
 *   or undo is refused while that answer stands. The stored record carries
 *   the answerer's display name and nothing else (`ReviewItemAnswer.by` — no
 *   actor ids in projected state), so the check is by name; two people with
 *   one display name share it, as they already share a Home marker.
 * - **No time limit.** The earlier answer is never lost (it moves to
 *   `priorAnswers` / `answerHistory`), and the filer is told the new pick
 *   replaces it, so a late change refuses nobody for anything.
 * - **The filer is told it changed.** `replacedAnswer` names the answer a new
 *   one supersedes, and `decision.answered` carries it as `replaces`.
 *
 * `recentTicketAnswers` is the read Home's "Answered" fold is drawn from.
 */
import type { TaskReviewItem } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import { LEGACY_REVIEW_ITEM_ID } from './derive.ts';

/** The refusal a writer returns when somebody else's answer stands. */
export function answeredByOther(by: string): {
  ok: false;
  error: 'answered-by-other';
  message: string;
} {
  return {
    ok: false,
    error: 'answered-by-other',
    message: `${by} has answered this; only ${by} can change or undo that answer`,
  };
}

/** The answer a new one supersedes, as `decision.answered` carries it. */
export interface ReplacedAnswer {
  answer: string;
  optionId?: string;
  by: string;
  ts: number;
}

/** True when `actor` may replace or take back the answer `standing` records. */
export function mayChangeAnswer(
  standing: { by: string } | undefined,
  actor: { name: string },
): boolean {
  return standing === undefined || standing.by === actor.name;
}

/**
 * The answer a new one on this ticket item replaces: the standing one, or —
 * after an undo — the one taken back, unless the item's words were revised
 * since, in which case the new answer is to a new question.
 *
 * After an undo `answer` is empty and the last of `priorAnswers` is the one
 * taken back: an answer over a standing one leaves `answer` set, and nothing
 * else empties it.
 */
export function replacedItemAnswer(item: TaskReviewItem): ReplacedAnswer | undefined {
  const prior = item.answer ?? item.priorAnswers?.at(-1);
  if (!prior) return undefined;
  if (!item.answer && (item.revisions ?? []).some((r) => r.at > prior.ts)) return undefined;
  return {
    answer: prior.text,
    ...(prior.answeredWith !== undefined ? { optionId: prior.answeredWith } : {}),
    by: prior.by,
    ts: prior.ts,
  };
}

/** The same for the ticket's own decision, whose undo writes `answerHistory`. */
export function replacedDecisionAnswer(task: Task): ReplacedAnswer | undefined {
  if (task.answer) {
    return {
      answer: task.answer.text,
      ...(task.answer.optionId !== undefined ? { optionId: task.answer.optionId } : {}),
      by: task.answer.by,
      ts: task.answer.ts,
    };
  }
  const prior = task.answerHistory?.at(-1);
  if (!prior) return undefined;
  if ((task.decisionRevisions ?? []).some((r) => r.at > prior.withdrawnAt)) return undefined;
  return {
    answer: prior.text,
    ...(prior.optionId !== undefined ? { optionId: prior.optionId } : {}),
    by: prior.by,
    ts: prior.ts,
  };
}

/** How long an answer stays in Home's "Answered" fold. */
export const RECENT_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One answered ticket item, as Home's "Answered" fold lists it. */
export interface RecentTicketAnswer {
  /** The queue key the item had while open, so the page can match the two. */
  key: string;
  taskId: string;
  reviewItemId: string;
  headline: string;
  answer: string;
  by: string;
  ts: number;
}

/**
 * Every ticket item answered in the last day, newest first. A withdrawn item
 * is left out: its asker took the question back, so there is nothing to
 * change an answer to.
 */
export function recentTicketAnswers(
  tasks: ReadonlyArray<{ id: string; reviews: TaskReviewItem[] }>,
  now: number,
): RecentTicketAnswer[] {
  const out: RecentTicketAnswer[] = [];
  for (const t of tasks) {
    for (const r of t.reviews) {
      const a = r.answer;
      if (!a || r.review.withdrawnAt !== undefined) continue;
      if (now - a.ts > RECENT_ANSWER_WINDOW_MS) continue;
      out.push({
        key: r.id === LEGACY_REVIEW_ITEM_ID ? `decision:${t.id}` : `task-review:${t.id}:${r.id}`,
        taskId: t.id,
        reviewItemId: r.id,
        headline: r.review.headline,
        answer: a.text,
        by: a.by,
        ts: a.ts,
      });
    }
  }
  return out.sort((x, y) => y.ts - x.ts);
}
