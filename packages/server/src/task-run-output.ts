/**
 * A scheduled run's output reaching Home, on the scheduler's own pass
 * (docs/architecture/scheduled-tasks.md, "A run's output reaches Home").
 *
 * A rule that declares an output folder (`schedule-output.ts` in core) gets
 * ONE review item per run that wrote something there, filed on the rule task
 * — the reader's Home queue is where a person looks, and a daily digest found
 * only by going to the Library is one nobody is told about. Three things
 * happen here and nowhere else:
 *
 *  - **One look per success.** The run record (`task-run-record.ts`, earlier
 *    in the same pass) writes the success; this module looks once the slack
 *    after the close has passed, and remembers the success it looked at so no
 *    later tick lists the project again for the same run.
 *  - **One item, however many files.** Every file the run wrote in the folder
 *    is a link on the same item. A run is its instance, not a burst of mtimes.
 *  - **The next run replaces the item.** It is filed first and the old one
 *    withdrawn after, carrying the old item's unopened files, so an unread
 *    digest never piles up into a card per day and never silently drops off.
 *
 * An item is withdrawn once a reader has opened every file it links, after
 * it was filed (`noteOutputOpened`): the Library's open, or the doc page of a
 * doc that holds the file — a writer binds each digest as its own doc before
 * its run closes, so "a doc holds it" says nothing about a reader. Until
 * then the doc page of each file it still waits on offers Mark read, which
 * withdraws it through the review item's own route.
 *
 * Writes go through the store as the scheduler's actor, past the quality
 * judge, for the reason the stale item gives: words generated from board
 * state have no author to send back to.
 */
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import {
  OUTPUT_SLACK_MS,
  type ScheduleOutputItem,
  outputItemPaths,
  runOutputPaths,
} from '@claude-workspaces/core/schedule-output';
import type { Task } from '@claude-workspaces/core/task-wire';
import { taskDeepLink } from './home-brief.ts';
import type { AddReviewItemResult, WithdrawReviewItemResult } from './review-items/types.ts';
import { lastInstanceOf } from './task-run-record.ts';

/** What this module reaches in the store. `TaskStore` satisfies it. */
export interface RunOutputStore {
  getTask(taskId: string): Task | undefined;
  listReviewItems(taskId: string): TaskReviewItem[];
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AddReviewItemResult;
  withdrawReviewItem(
    taskId: string,
    reviewItemId: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): WithdrawReviewItemResult;
  scheduleSave(workspaceId: string): void;
}

/** What this module reads about the board's project files. */
export interface RunOutputSource {
  /**
   * The project's markdown files as the board's Library lists them, with
   * their mtimes — the ones it offers to open and the ones a doc of the board
   * already holds, since a run may rewrite a file somebody opened. `null`
   * when the board has no project this server can list.
   */
  files(workspaceId: string): readonly { relPath: string; at?: number }[] | null;
}

type Actor = { id: string; name: string; kind?: string };

/** Longest folder or file name a headline carries. Two of them plus the
 *  fixed words stay well inside the store's one-line ceiling. */
const NAME_MAX_CHARS = 120;

/** The item's words. Exported so a test reads what a person would see. */
export function buildOutputReview(input: {
  workspaceId: string;
  rule: Task;
  folder: string;
  /** Newest first; the first `fresh` are this run's. */
  paths: readonly string[];
  fresh: number;
}): Record<string, unknown> {
  const { workspaceId, rule, folder, paths, fresh } = input;
  // A file name may hold a line break, and a folder segment may run to 512
  // characters: either would make the headline one the store refuses.
  const oneLine = (s: string) =>
    Array.from(s, (c) => (c < ' ' || c === '\x7f' ? ' ' : c))
      .join('')
      .replace(/[[\]]/g, '');
  const clip = (s: string) => (s.length > NAME_MAX_CHARS ? `${s.slice(0, NAME_MAX_CHARS)}…` : s);
  const base = (p: string) => clip(oneLine(p.split('/').pop() ?? p));
  const link = (p: string) =>
    `- [${base(p)}](/workspaces/${encodeURIComponent(workspaceId)}/library?open=${encodeURIComponent(p)})`;
  const newest = paths[0] ?? '';
  const more = fresh > 1 ? ` and ${fresh - 1} more` : '';
  const title = rule.title.replace(/[[\]]/g, '');
  const earlier = paths.slice(fresh);
  const detail = [
    `[${title}](${taskDeepLink(workspaceId, rule.id)}) wrote:`,
    '',
    ...paths.slice(0, fresh).map(link),
    ...(earlier.length > 0
      ? ['', 'Not opened yet from earlier runs:', '', ...earlier.map(link)]
      : []),
  ].join('\n');
  return {
    review_type: 'question',
    headline: `New in ${clip(oneLine(folder.split('/').pop() ?? folder))}: ${base(newest)}${more}`,
    detail,
  };
}

export type RunOutputObserver = (row: { taskId: string; workspaceId: string }, now: number) => void;

/**
 * The per-rule pass, built once and called by the scheduler for every rule on
 * every tick, after the run record. Mutates the live rule row and hands it to
 * `scheduleSave`, the store's own pattern.
 */
export function observeRunOutput(
  store: RunOutputStore,
  source: RunOutputSource,
  actor: Actor,
  report: (message: string) => void,
): RunOutputObserver {
  return (row, now) => {
    const rule = store.getTask(row.taskId);
    const schedule = rule?.schedule;
    if (!rule || !schedule) return;
    const state = schedule.state ?? {};
    const ws = row.workspaceId;
    let changed = false;
    const save = () => {
      if (!changed) return;
      schedule.state = state;
      store.scheduleSave(ws);
    };

    // The standing item: gone once a person answered or withdrew it. Opens
    // withdraw it as they happen (`noteOutputOpened`), not on a tick.
    const standing = state.output?.item;
    if (state.output && standing && !isStanding(store, rule.id, standing.id)) {
      state.output = { forSuccessAt: state.output.forSuccessAt };
      changed = true;
    }

    const output = schedule.output;
    const successAt = state.lastSuccessAt;
    if (!output || successAt === undefined || state.output?.forSuccessAt === successAt) {
      return save();
    }
    const last = lastInstanceOf(store, schedule);
    const instance = last ? store.getTask(last.id) : undefined;
    if (last?.status !== 'done' || last.closedAt === undefined || !instance) return save();
    // A writer may flush just after reporting done; look once that has passed.
    if (now < last.closedAt + OUTPUT_SLACK_MS) return save();

    const previous = state.output;
    const carriedItem = previous?.item;
    state.output = { forSuccessAt: successAt, ...(carriedItem ? { item: carriedItem } : {}) };
    changed = true;
    const files = source.files(ws);
    if (files === null) {
      report(`[scheduler] ${rule.id} declares output but its board has no project to list`);
      return save();
    }
    const fresh = runOutputPaths(files, output, {
      from: instance.createdAt,
      closedAt: last.closedAt,
    });
    if (fresh.length === 0) return save();
    const carried = carriedItem ? unread(carriedItem) : [];
    const paths = outputItemPaths(fresh, carried);
    const res = store.addReviewItem(
      rule.id,
      buildOutputReview({
        workspaceId: ws,
        rule,
        folder: output.folder,
        paths,
        fresh: Math.min(fresh.length, paths.length),
      }),
      { actor },
    );
    if (!res.ok) {
      // The success stays unconsumed, so the next tick tries this run again
      // rather than its news being lost.
      report(`[scheduler] ${rule.id} output item refused: ${res.error}`);
      state.output = previous;
      return save();
    }
    if (carriedItem) {
      const gone = store.withdrawReviewItem(rule.id, carriedItem.id, {
        actor,
        reason: 'a newer run replaced it',
      });
      if (!gone.ok) report(`[scheduler] ${rule.id} replaced item withdraw refused: ${gone.error}`);
    }
    state.output = { forSuccessAt: successAt, item: { id: res.item.id, paths, waitingOn: paths } };
    report(`[scheduler] ${rule.id} run output: filed review item ${res.item.id}`);
    return save();
  };
}

/** What an open reaches in the store. `TaskStore` satisfies it. */
export type RunOutputOpenStore = Pick<
  RunOutputStore,
  'listReviewItems' | 'withdrawReviewItem' | 'scheduleSave'
> & { listTasks(workspaceId: string): Task[] };

function isStanding(
  store: Pick<RunOutputStore, 'listReviewItems'>,
  ruleId: string,
  itemId: string,
): boolean {
  const item = store.listReviewItems(ruleId).find((i) => i.id === itemId);
  return item !== undefined && isReviewItemOpen(item) && !reviewWithdrawn(item.review);
}

/**
 * The files an item still waits on. An item filed before opens were counted
 * waited only on files no doc held, which for a writer that binds its digests
 * was none: it never withdrew. Empty, it waits on every file it links.
 */
function unread(item: ScheduleOutputItem): string[] {
  return item.waitingOn.length > 0 ? item.waitingOn : item.paths;
}

/** The standing run-output items on a board whose `files` hold `relPath`,
 *  each with the rule it is filed on. */
function standingOn(
  store: RunOutputOpenStore,
  workspaceId: string,
  relPath: string,
  files: (item: ScheduleOutputItem) => string[],
): { rule: Task; item: ScheduleOutputItem }[] {
  const out: { rule: Task; item: ScheduleOutputItem }[] = [];
  for (const rule of store.listTasks(workspaceId)) {
    const item = rule.schedule?.state?.output?.item;
    if (item && files(item).includes(relPath) && isStanding(store, rule.id, item.id)) {
      out.push({ rule, item });
    }
  }
  return out;
}

/** The ids of the standing run-output items that link `relPath` — what the
 *  file's doc page offers to mark read. */
export function itemsLinking(
  store: RunOutputOpenStore,
  workspaceId: string,
  relPath: string,
): Set<string> {
  return new Set(standingOn(store, workspaceId, relPath, (i) => i.paths).map((s) => s.item.id));
}

/**
 * A reader opened the project file at `relPath` on this board: through the
 * Library, or at the doc page of a doc that holds it. Each standing item
 * waiting on it stops waiting on it, and one with nothing left to wait on is
 * withdrawn now, so an open Home drops it on the withdrawal's own event.
 */
export function noteOutputOpened(
  store: RunOutputOpenStore,
  workspaceId: string,
  relPath: string,
  actor: Actor,
  report: (message: string) => void,
): void {
  for (const { rule, item } of standingOn(store, workspaceId, relPath, unread)) {
    const left = unread(item).filter((p) => p !== relPath);
    if (left.length === 0) {
      const res = store.withdrawReviewItem(rule.id, item.id, {
        actor,
        reason: 'every new file it links was opened',
      });
      if (!res.ok) {
        report(`[run-output] ${rule.id} output item withdraw refused: ${res.error}`);
        continue;
      }
      const state = rule.schedule?.state;
      if (state?.output) state.output = { forSuccessAt: state.output.forSuccessAt };
    } else item.waitingOn = left;
    store.scheduleSave(workspaceId);
  }
}
