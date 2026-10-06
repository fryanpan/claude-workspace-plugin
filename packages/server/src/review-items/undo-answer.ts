/**
 * Taking back the answer on one of a ticket's review items.
 *
 * The ticket's own decision (`r-legacy`) and a doc-thread item each had an
 * undo; a review item filed on the ticket had none, so an answer recorded by
 * mistake there could only be written over. The voice queue reads every
 * decision back and lets "no, undo that" reverse it, which needs a way back
 * on every kind it records.
 *
 * Soft, like the other two: the answer moves to `priorAnswers` (the list a
 * superseded answer already goes to), the item is open again, and
 * `decision.answer_withdrawn` names who took it back and when. `r-legacy`
 * goes to `withdrawAnswer`, so the ticket's decision keeps one undo.
 *
 * Refuses when there is no answer to take back, so two people racing the
 * same undo are not both told it worked.
 */
import type { TaskReviewItem } from '@claude-workspaces/core';
import type { Task, TaskActor } from '@claude-workspaces/core/task-wire';
import { classifyActor } from '../actor-identity.ts';
import { answeredByOther, mayChangeAnswer } from './answer-change.ts';
import { TaskDecisionStore } from './decisions.ts';
import { LEGACY_REVIEW_ITEM_ID } from './derive.ts';
import type { ReviewItemPersistence } from './persistence.ts';

export type UndoTaskReviewAnswerResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | { ok: false; error: 'not-found' | 'unknown-review-item' | 'no-answer' | 'not-a-decision' }
  | ReturnType<typeof answeredByOther>;

export class ReviewAnswerUndo {
  private readonly decisions: TaskDecisionStore;

  constructor(private readonly p: ReviewItemPersistence) {
    this.decisions = new TaskDecisionStore(p);
  }

  undoTaskReviewAnswer(
    taskId: string,
    reviewItemId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): UndoTaskReviewAnswerResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };

    if (reviewItemId === LEGACY_REVIEW_ITEM_ID && this.decisions.legacyReviewItem(task)) {
      const res = this.decisions.withdrawAnswer(taskId, opts);
      if (!res.ok) return res;
      const item = this.decisions.legacyReviewItem(res.task);
      if (!item) return { ok: false, error: 'unknown-review-item' };
      return { ok: true, task: res.task, item };
    }

    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };
    const answer = item.answer;
    if (!answer) return { ok: false, error: 'no-answer' };
    if (!mayChangeAnswer(answer, opts.actor)) return answeredByOther(answer.by);

    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    item.priorAnswers = [...(item.priorAnswers ?? []), answer];
    item.answer = undefined;
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    this.p.emit({
      type: 'decision.answer_withdrawn',
      workspaceId: task.workspaceId,
      taskId: task.id,
      reviewItemId,
      answer: answer.text,
      answeredBy: answer.by,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task, item };
  }
}
