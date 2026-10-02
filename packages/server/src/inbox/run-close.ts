/**
 * The reader's pass closes the scheduled run it was filed for.
 *
 * The inbox reader runs from a board schedule row, and each run is a task
 * instance whose wake counts as answered only once it leaves `todo`
 * (`task-scheduled-wake.ts`). The reader may call no workspaces verb but
 * `post_inbox_rows`, so the post carries `run: { workspaceId, taskId }` and
 * the server moves the instance to `done` — after checking the instance is
 * the reader's own scheduled run, open, on the board named.
 *
 * The move goes through the task store's own `transition`, as any agent's
 * would: same gates, same trail, same event. The note carries counts only,
 * never a word of a row.
 */
import { isValidWatchKey } from '../agent-watches.ts';
import { isValidDispatchTaskId } from '../dispatch-registry.ts';
import type { Task, TaskStatus } from '../tasks.ts';

export interface RunCloseStore {
  getWorkspace(id: string): unknown;
  getTask(taskId: string): Task | undefined;
  ownerIdOf(task: Pick<Task, 'assignee' | 'assigneeId'>): string | undefined;
  transition(
    taskId: string,
    to: TaskStatus,
    opts: { actor: { id: string; name: string; kind?: string }; note?: string },
  ): { ok: true } | { ok: false; error: string };
}

export type RunCloseResult = { closed: true; taskId: string } | { closed: false; error: string };

const RUN_KEYS = new Set(['workspaceId', 'taskId']);

/** Close `run` for `reader`, or say by name why not. Nothing is moved on a
 *  refusal. */
export function closeInboxRun(
  store: RunCloseStore,
  run: unknown,
  reader: { id: string; name: string },
  counts: { pass: string; accepted: number; rejected: number },
): RunCloseResult {
  if (!run || typeof run !== 'object' || Array.isArray(run))
    return { closed: false, error: 'bad-run' };
  const r = run as Record<string, unknown>;
  if (Object.keys(r).some((k) => !RUN_KEYS.has(k))) return { closed: false, error: 'bad-run' };
  const { workspaceId, taskId } = r;
  if (!isValidWatchKey(workspaceId) || !isValidDispatchTaskId(taskId)) {
    return { closed: false, error: 'bad-run-ids' };
  }
  if (store.getWorkspace(workspaceId) === undefined)
    return { closed: false, error: 'run-board-not-found' };
  const task = store.getTask(taskId);
  // A task id that exists on ANOTHER board reads exactly as a missing one.
  if (!task || task.workspaceId !== workspaceId) return { closed: false, error: 'run-not-found' };
  if (task.recurrenceOf === undefined) return { closed: false, error: 'not-a-scheduled-run' };
  if (store.ownerIdOf(task) !== reader.id) return { closed: false, error: 'not-the-readers-run' };
  if (task.archivedAt !== undefined) return { closed: false, error: 'run-archived' };
  if (task.status === 'done') return { closed: false, error: 'run-already-done' };
  const moved = store.transition(taskId, 'done', {
    actor: { id: reader.id, name: reader.name, kind: 'agent' },
    note: `Inbox pass ${counts.pass}: ${counts.accepted} accepted, ${counts.rejected} rejected`,
  });
  if (!moved.ok) return { closed: false, error: `run-transition-refused: ${moved.error}` };
  return { closed: true, taskId };
}
