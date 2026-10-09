/**
 * Every open review item on every board, in one order: top project first,
 * then each board's own Home order.
 *
 * Bryan runs several boards and used to open each one to find what was
 * waiting on him. This is the list the cross-board flow walks, and the list
 * the answer metrics measure "in priority order" against, so both read the
 * SAME order rather than two that could drift.
 *
 * Project order is `rankProjects` (review-plan.ts). Inside a board the order
 * is a port of Home's `compareAsk` (board-review-model.ts in the app): the
 * task's goal band, then its place in the band, then its age, then which kind
 * of ask it is (the ticket's own decision, then questions about the work,
 * then doc comments), then a direct question over a status note, then the
 * wait. An ask with no task on the board sorts after every ask that has one.
 * The port exists because the server has to know an item's rank at the
 * moment it is answered, and the client is not there to ask.
 *
 * Items on one task keep their filing order, and a size filter never shows a
 * later one before an earlier one: an item's size is at least the size of
 * every open item filed before it on the same task, so a filter that hides
 * the first hides the ones behind it too. Agents file a task's asks as a
 * sequence — the second often assumes the first was answered.
 *
 * A legacy decision rides as its derived `r-legacy` row, which Home skips
 * only because it draws the same question from the board projection. Here
 * there is no projection, and the row's answer route already delegates to
 * the decision path, so it stays and ranks where Home ranks the decision.
 */
import {
  REVIEW_SIZES,
  type ReviewPayload,
  type ReviewSize,
  isBlockingAsk,
} from '@claude-workspaces/core';
import type { RankedProject } from './review-plan.ts';
import type { SizedReviewItemRow } from './review-sizing.ts';
import { LEGACY_REVIEW_ITEM_ID } from './tasks.ts';

/** What the order reads of one task. */
export interface OrderTask {
  id: string;
  goal: string;
  order: number;
  createdAt: number;
  /** When the work should be finished. Shown on the card; orders nothing. */
  dueAt?: number;
}

/** One board's inputs. */
export interface BoardQueueInput {
  project: RankedProject;
  rows: SizedReviewItemRow[];
  tasks: OrderTask[];
  /** Goal ids in band order. */
  goalIds: string[];
}

export type CrossReviewItem = SizedReviewItemRow & {
  workspaceId: string;
  project: string;
  /** Stable across reads: `<workspaceId>:<row key>`. */
  key: string;
  /** The task's due date, when the row is about a task that has one. */
  dueAt?: number;
  /** The plan lead's rank this item rides at, when one counts. */
  leadRank?: number;
  /** The plan lead's goal tag (`review-ranks.ts`), when one counts. */
  goalTag?: string;
};

export interface CrossReviewQueue {
  projects: RankedProject[];
  items: CrossReviewItem[];
}

const BAND_TASK_ROW = 0;
const BAND_TASK_THREAD = 1;
const BAND_DOC_THREAD = 2;

interface AskRank {
  placed: 0 | 1;
  goal: number;
  order: number;
  createdAt: number;
  taskId: string;
  band: number;
  direct: 0 | 1;
  since: number;
  tie: string;
}

function compareAsk(a: AskRank, b: AskRank): number {
  return (
    a.placed - b.placed ||
    a.goal - b.goal ||
    a.order - b.order ||
    a.createdAt - b.createdAt ||
    a.taskId.localeCompare(b.taskId) ||
    a.band - b.band ||
    a.direct - b.direct ||
    a.since - b.since ||
    a.tie.localeCompare(b.tie)
  );
}

/** The key a row is known by within its board — the same spelling Home uses. */
export function rowKey(row: SizedReviewItemRow): string {
  if (row.kind === 'task-review') {
    return row.reviewItemId === LEGACY_REVIEW_ITEM_ID
      ? `decision:${row.taskId}`
      : `task-review:${row.taskId}:${row.reviewItemId}`;
  }
  return `${row.kind}:${row.docId}:${row.threadId}`;
}

/** What `rankOf` needs to place an ask, whether or not it is still open. */
export interface AskShape {
  kind: SizedReviewItemRow['kind'];
  taskId?: string;
  legacy?: boolean;
  direct: boolean;
  since: number;
  tie: string;
}

export function askShapeOf(row: SizedReviewItemRow): AskShape {
  if (row.kind === 'task-review') {
    return {
      kind: row.kind,
      taskId: row.taskId,
      legacy: row.reviewItemId === LEGACY_REVIEW_ITEM_ID,
      direct: true,
      since: row.since,
      tie:
        row.reviewItemId === LEGACY_REVIEW_ITEM_ID
          ? row.taskId
          : `${row.taskId}:${row.reviewItemId}`,
    };
  }
  return {
    kind: row.kind,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    direct: row.direct,
    since: row.since,
    tie: row.threadId,
  };
}

/** A board's ranking function: where an ask sits among that board's asks. */
export function boardRanker(tasks: OrderTask[], goalIds: string[]): (ask: AskShape) => AskRank {
  const goalIndex = new Map(goalIds.map((id, i) => [id, i]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  return (ask) => {
    // Only a ticket's own rows and its discussion inherit its priority; a
    // goal's discussion and a doc comment have no task to rank by.
    const task =
      ask.taskId && (ask.kind === 'task-review' || ask.kind === 'task-thread')
        ? taskById.get(ask.taskId)
        : undefined;
    const band =
      ask.kind === 'task-review'
        ? ask.legacy
          ? BAND_TASK_ROW
          : BAND_TASK_THREAD
        : ask.kind === 'doc-thread'
          ? BAND_DOC_THREAD
          : BAND_TASK_THREAD;
    const direct: 0 | 1 = ask.direct ? 0 : 1;
    return task
      ? {
          placed: 0,
          goal: goalIndex.get(task.goal) ?? goalIds.length,
          order: task.order,
          createdAt: task.createdAt,
          taskId: task.id,
          band,
          direct,
          since: ask.since,
          tie: ask.tie,
        }
      : {
          placed: 1,
          goal: 0,
          order: 0,
          createdAt: 0,
          taskId: '',
          band,
          direct,
          since: ask.since,
          tie: ask.tie,
        };
  };
}

/** One board's rows in Home order. */
export function boardOrder(input: Omit<BoardQueueInput, 'project'>): SizedReviewItemRow[] {
  const rank = boardRanker(input.tasks, input.goalIds);
  return input.rows
    .map((row) => ({ row, rank: rank(askShapeOf(row)) }))
    .sort((a, b) => compareAsk(a.rank, b.rank))
    .map((r) => r.row);
}

/** Whether `ask` ranks ahead of `than` on one board. */
export function ranksAhead(
  ranker: (ask: AskShape) => AskRank,
  ask: AskShape,
  than: AskShape,
): boolean {
  return compareAsk(ranker(ask), ranker(than)) < 0;
}

const larger = (a: ReviewSize, b: ReviewSize): ReviewSize =>
  REVIEW_SIZES.indexOf(a) >= REVIEW_SIZES.indexOf(b) ? a : b;

/** The task a row belongs to for ordering, if any. */
const taskOfRow = (row: SizedReviewItemRow): string | undefined =>
  (row.kind === 'task-review' || row.kind === 'task-thread') && row.taskId ? row.taskId : undefined;

/** Every board's rows, top project first. */
export function crossReviewQueue(boards: BoardQueueInput[]): CrossReviewQueue {
  const ordered = [...boards].sort((a, b) => a.project.rank - b.project.rank);
  const items: CrossReviewItem[] = [];
  for (const board of ordered) {
    const dueOf = new Map(board.tasks.map((t) => [t.id, t.dueAt]));
    // The largest size filed so far on each task, in board order — which on
    // one task is filing order (see the header).
    const sizeSoFar = new Map<string, ReviewSize>();
    for (const row of boardOrder(board)) {
      const taskId = taskOfRow(row);
      const prior = taskId ? sizeSoFar.get(taskId) : undefined;
      const size = prior ? larger(prior, row.size) : row.size;
      if (taskId) sizeSoFar.set(taskId, size);
      const dueAt = taskId ? dueOf.get(taskId) : undefined;
      items.push({
        ...row,
        size,
        workspaceId: board.project.workspaceId,
        project: board.project.name,
        key: `${board.project.workspaceId}:${rowKey(row)}`,
        ...(dueAt !== undefined ? { dueAt } : {}),
      });
    }
  }
  return { projects: ordered.map((b) => b.project), items };
}

/**
 * The queue with the plan lead's ranks applied (`review-ranks.ts`): every
 * ranked item first, lowest rank first, then every unranked item in the
 * order it already had.
 *
 * Items on one task still keep their filing order (see the header): an item
 * rides at the best rank of itself and every item filed after it on the same
 * task, so ranking a task's second ask brings its first along ahead of it.
 * Ties keep the existing order. Each item that rides at a rank carries it as
 * `leadRank`, which is how Home picks its Top 10.
 */
export function applyLeadRanks(
  items: CrossReviewItem[],
  rankOf: (item: CrossReviewItem) => number | undefined,
): CrossReviewItem[] {
  const effective = items.map((item) => rankOf(item) ?? Number.POSITIVE_INFINITY);
  // Walk backwards so each item sees the best rank filed after it on its task.
  const bestAfter = new Map<string, number>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const taskId = item ? taskOfRow(item) : undefined;
    if (!item || !taskId) continue;
    const key = `${item.workspaceId}:${taskId}`;
    const best = Math.min(
      effective[i] ?? Number.POSITIVE_INFINITY,
      bestAfter.get(key) ?? Number.POSITIVE_INFINITY,
    );
    effective[i] = best;
    bestAfter.set(key, best);
  }
  return items
    .map((item, index) => ({ item, index, rank: effective[index] ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((r) => (Number.isFinite(r.rank) ? { ...r.item, leadRank: r.rank } : r.item));
}

/**
 * The lead's ranked items where `applyLeadRanks` put them, then among the
 * unranked every item that STOPS work first, then the rest, each part in the
 * order it already had. Bryan, 2026-10-08: "team lead should still rank" — a
 * blocking ask tells the lead what the wait costs (`review-blocks.ts`), and
 * outranks only what the lead has not placed.
 */
export function blockingFirst<T extends { review?: ReviewPayload; leadRank?: number }>(
  items: T[],
): T[] {
  const unranked = items.filter((i) => i.leadRank === undefined);
  return [
    ...items.filter((i) => i.leadRank !== undefined),
    ...unranked.filter((i) => isBlockingAsk(i.review)),
    ...unranked.filter((i) => !isBlockingAsk(i.review)),
  ];
}

/** How many of `items` are at or under each size — the per-level count a
 *  cumulative filter shows. */
export function countBySize(
  items: ReadonlyArray<{ size: ReviewSize }>,
): Record<ReviewSize, number> {
  const out: Record<ReviewSize, number> = { easy: 0, medium: 0, hard: 0 };
  for (const it of items) {
    if (it.size === 'easy') out.easy += 1;
    if (it.size !== 'hard') out.medium += 1;
    out.hard += 1;
  }
  return out;
}
