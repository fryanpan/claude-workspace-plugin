/**
 * `closeInboxRun` on its own, over a stand-in board store: the checks run in
 * order, a refusal moves nothing, and a refusal from the store's own
 * transition gate is passed back by name rather than swallowed.
 */
import { describe, expect, it } from 'bun:test';
import { type RunCloseStore, closeInboxRun } from '../src/inbox/run-close.ts';
import type { Task } from '../src/tasks.ts';

const READER = { id: 'agent-reader', name: 'Harborlight Reader' };
const COUNTS = { pass: 'p1', accepted: 2, rejected: 1 };

function board(task: Partial<Task>, answer: { ok: true } | { ok: false; error: string }) {
  const moves: Array<{ taskId: string; to: string; actor: unknown; note?: string }> = [];
  const store: RunCloseStore = {
    getWorkspace: (id) => (id === 'ws-harbor' ? {} : undefined),
    getTask: (id) =>
      id === 't-run1'
        ? ({
            id,
            workspaceId: 'ws-harbor',
            status: 'todo',
            recurrenceOf: { taskId: 't-rule', occurrenceAt: 1 },
            transitions: [],
            ...task,
          } as Task)
        : undefined,
    ownerIdOf: (t) => t.assigneeId,
    transition: (taskId, to, opts) => {
      moves.push({ taskId, to, ...opts });
      return answer;
    },
  };
  return { store, moves };
}

describe('closeInboxRun', () => {
  const run = { workspaceId: 'ws-harbor', taskId: 't-run1' };

  it('moves the reader’s own open run to done, as the reader, with counts only', () => {
    const { store, moves } = board({ assigneeId: READER.id }, { ok: true });
    expect(closeInboxRun(store, run, READER, COUNTS)).toEqual({ closed: true, taskId: 't-run1' });
    expect(moves).toEqual([
      {
        taskId: 't-run1',
        to: 'done',
        actor: { ...READER, kind: 'agent' },
        note: 'Inbox pass p1: 2 accepted, 1 rejected',
      },
    ]);
  });

  it('passes the transition gate’s refusal back by name', () => {
    const { store } = board({ assigneeId: READER.id }, { ok: false, error: 'blocked' });
    expect(closeInboxRun(store, run, READER, COUNTS)).toEqual({
      closed: false,
      error: 'run-transition-refused: blocked',
    });
  });

  it('moves nothing for a run that is not the reader’s', () => {
    const { store, moves } = board({ assigneeId: 'agent-riverbend' }, { ok: true });
    expect(closeInboxRun(store, run, READER, COUNTS)).toEqual({
      closed: false,
      error: 'not-the-readers-run',
    });
    expect(moves).toEqual([]);
  });

  it('refuses an unowned run rather than matching undefined to undefined', () => {
    const { store, moves } = board({}, { ok: true });
    expect(closeInboxRun(store, run, READER, COUNTS).closed).toBe(false);
    expect(moves).toEqual([]);
  });
});
