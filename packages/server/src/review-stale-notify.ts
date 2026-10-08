/**
 * Tell an asker, once, that its open ask stopped applying.
 *
 * The queue drops a stale ask by reading the thread (`review-stale.ts` in
 * core), which needs nothing written and covers every item ever filed. What
 * a read cannot do is tell the asker, and the asker is the one who should
 * withdraw the item or file a fresh one. So this listens at the two moments
 * an ask BECOMES stale and sends one addressed `workspace.review_item_stale`
 * frame at each:
 *
 *  - a comment lands that is the first to settle the ask — the asker's own
 *    reply (`onCommentPosted`);
 *  - an edit-triggered re-anchor sweep newly orphans the thread
 *    (`onThreadsOrphaned`). The sweep a doc runs when it loads is not one of
 *    these moments: a thread orphaned before the restart was orphaned before
 *    this listener existed, and waking its asker now would be news about a
 *    day-old edit.
 *
 * Both are transitions, so the frame is sent once per transition with no
 * stamp written to the doc. A re-anchor and a second orphaning send again,
 * which is correct: the ask came back and went away a second time.
 *
 * The frame carries the words and the exact call, so it is news an agent can
 * act on (`.claude/rules/code-health.md`), and it carries no top-level actor:
 * the server sends it, so the MCP child's self-echo drop never matches it,
 * even though the asker's own reply is what caused it.
 */
import {
  type Thread,
  getThreads,
  isReviewPayloadGated,
  pendingDeclaration,
} from '@claude-workspaces/core';
import { threadReviewItemId } from '@claude-workspaces/core/review-item-id';
import { STALE_ASK_NOTE, type StaleAskRule, staleAsk } from '@claude-workspaces/core/review-stale';
import type * as Y from 'yjs';

export const REVIEW_ITEM_STALE_EVENT = 'workspace.review_item_stale';

export interface ReviewItemStaleFrame {
  event: typeof REVIEW_ITEM_STALE_EVENT;
  workspaceId: string;
  docId: string;
  threadId: string;
  commentId: string;
  reviewItemId: string;
  headline: string;
  /** The ticket's or doc's name, when known. */
  title?: string;
  rule: StaleAskRule;
  note: string;
  /** The paste-ready call that retires it. */
  withdraw: string;
  ts: number;
}

export interface StaleAskNotifierContext {
  thread: (docId: string, threadId: string) => Thread | null;
  workspaceOf: (docId: string) => string | null;
  titleOf?: (docId: string) => string | undefined;
  sendToAgent: (channel: string, agentId: string, frame: ReviewItemStaleFrame) => void;
  now?: () => number;
}

export interface StaleAskNotifier {
  /** Every posted comment; sends only when this comment is the first to
   *  settle the thread's open ask. */
  onCommentPosted: (event: { docId: string; threadId: string; commentId: string }) => void;
  /** Threads an edit's re-anchor sweep has just orphaned. */
  onThreadsOrphaned: (docId: string, threadIds: readonly string[]) => void;
}

export function createStaleAskNotifier(ctx: StaleAskNotifierContext): StaleAskNotifier {
  const now = ctx.now ?? Date.now;

  function notify(
    docId: string,
    threadId: string,
    wanted: (rule: StaleAskRule, by?: string) => boolean,
  ): void {
    const thread = ctx.thread(docId, threadId);
    if (!thread || thread.status === 'resolved') return;
    const declaring = pendingDeclaration(thread);
    const review = declaring?.review;
    // A held ask is already off the queue and its filer already told why.
    if (!declaring || !review || isReviewPayloadGated(review)) return;
    const stale = staleAsk(thread, declaring);
    if (!stale || !wanted(stale.rule, stale.commentId)) return;
    const workspaceId = ctx.workspaceOf(docId);
    const askerId = declaring.author.id;
    if (!workspaceId || !askerId) return;
    const title = ctx.titleOf?.(docId);
    const reason =
      stale.rule === 'orphaned'
        ? 'what it was about is gone from the page'
        : 'your reply settled it';
    ctx.sendToAgent(`ws~${workspaceId}`, askerId, {
      event: REVIEW_ITEM_STALE_EVENT,
      workspaceId,
      docId,
      threadId,
      commentId: declaring.id,
      reviewItemId: threadReviewItemId(docId, threadId, declaring.id),
      headline: review.headline,
      ...(title ? { title } : {}),
      rule: stale.rule,
      note: STALE_ASK_NOTE[stale.rule],
      withdraw: `withdraw_review_item(docId="${docId}", threadId="${threadId}", commentId="${declaring.id}", reason="${reason}")`,
      ts: now(),
    });
  }

  return {
    onCommentPosted: (event) =>
      notify(
        event.docId,
        event.threadId,
        (rule, by) => rule === 'settled' && by === event.commentId,
      ),
    onThreadsOrphaned: (docId, threadIds) => {
      for (const threadId of threadIds) notify(docId, threadId, (rule) => rule === 'orphaned');
    },
  };
}

/** The ids of every thread whose anchor is orphaned in `ydoc` right now. */
export function orphanedThreadIds(ydoc: Y.Doc): Set<string> {
  const out = new Set<string>();
  getThreads(ydoc).forEach((threadMap, id) => {
    const anchor = threadMap.get('anchor') as { kind?: string } | undefined;
    if (anchor?.kind === 'orphan') out.add(id);
  });
  return out;
}

/** The ids in `after` that were not in `before`. */
export function newlyOrphaned(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((id) => !before.has(id));
}
