/**
 * The reader's pass closes its own scheduled run, through the real server.
 *
 * `POST /inbox/rows` with `run: { workspaceId, taskId }` moves the run
 * instance to `done` through the task store's transition — only when the
 * instance is a scheduled run, the reader's own, on the board named, open
 * and not archived. A refused close still stores the rows and says why in
 * `run`. The wake path's own pass (`runScheduler`) is what reads the result
 * as answered. Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { setTaskSchedule } from '../src/task-scheduler.ts';
import type { Task } from '../src/tasks.ts';
import { row } from './inbox-fixtures.ts';

const READER = 'agent-reader';
const READER_NAME = 'Harborlight Reader';
const OTHER = 'agent-riverbend';
const OTHER_NAME = 'Riverbend Builder';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.now() - DAY - MINUTE;

let handle: ServerHandle;
let root: string;
let base: string;
let callerIs: string | null = null;
let now = T0;
let workspaceId: string;
let otherBoard: string;
let goalId: string;
let ruleId: string;

const local = () => `localhost:${handle.port}`;
const req = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { host: local(), ...((init.headers as Record<string, string>) ?? {}) },
  });

async function tokenFor(agentId: string): Promise<string> {
  callerIs = agentId;
  const res = await req(`/api/agents/${agentId}/token`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function post(body: Record<string, unknown>, as = READER) {
  const res = await req('/inbox/rows', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await tokenFor(as)}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, out: (await res.json()) as Record<string, unknown> };
}

const live = () => row({ receivedAt: Date.now() - 25 * MINUTE });

/** A run instance filed by hand, as the scheduler files one. */
function instance(over: { assignee?: string; scheduled?: boolean } = {}): Task {
  const res = handle.tasks.createTask(workspaceId, {
    title: 'Read the inbox',
    assignee: over.assignee ?? READER_NAME,
    assigneeKind: 'agent',
    goal: goalId,
    actor: { id: 'scheduler', name: 'Scheduler', kind: 'agent' },
    ...(over.scheduled === false ? {} : { recurrenceOf: { taskId: ruleId, occurrenceAt: T0 } }),
  });
  if (!res.ok) throw new Error(`create refused: ${res.error}`);
  return res.task;
}

const statusOf = (id: string) => handle.tasks.getTask(id)?.status;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'inbox-run-close-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  writeFileSync(join(dataDir, 'inbox', 'config.json'), JSON.stringify({ readerAgentId: READER }));
  handle = createServer({
    port: 0,
    dataDir,
    schedulerNow: () => now,
    identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
  });
  base = `http://127.0.0.1:${handle.port}`;
  handle.identities.upsertAgent(READER, READER_NAME);
  handle.identities.upsertAgent(OTHER, OTHER_NAME);
  const ws = handle.tasks.createWorkspace('Harborlight Desk');
  workspaceId = ws.id;
  otherBoard = handle.tasks.createWorkspace('Saltmarsh Desk').id;
  const actor = { id: READER, name: READER_NAME, kind: 'agent' };
  const goals = handle.tasks.setGoalList(workspaceId, [{ title: 'Answer what matters' }], {
    actor,
  });
  if (!goals.ok) throw new Error('goal list refused');
  goalId = goals.created[0]?.id ?? '';
  const rule = handle.tasks.createTask(workspaceId, {
    title: 'Read the inbox',
    assignee: READER_NAME,
    assigneeKind: 'agent',
    goal: goalId,
    actor,
  });
  if (!rule.ok) throw new Error('rule refused');
  ruleId = rule.task.id;
  const armed = setTaskSchedule(handle.tasks, ruleId, {
    rule: { kind: 'every', everyMs: DAY },
    armedAt: T0,
  });
  if (!armed.ok) throw new Error('arm refused');
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a reader’s pass closes its own scheduled run', () => {
  it('moves the instance to done with counts only, and the wake reads it as answered', async () => {
    now = T0 + DAY + MINUTE;
    handle.runScheduler();
    const state = () => handle.tasks.getTask(ruleId)?.schedule?.state;
    const instanceId = state()?.lastInstanceId;
    if (instanceId === undefined) throw new Error('no instance filed');
    // The reader holds no stream, so the first wake went unanswered.
    expect(state()?.wake?.attempts.length).toBe(1);
    expect(state()?.wake?.answeredAt).toBeUndefined();

    const secret = live();
    const { status, out } = await post({
      agentId: READER,
      pass: 'pass-7',
      rows: [secret, { ...live(), purpose: '<b>x</b>' }],
      run: { workspaceId, taskId: instanceId },
    });
    expect(status).toBe(200);
    expect(out).toMatchObject({ accepted: 1, run: { closed: true, taskId: instanceId } });

    const task = handle.tasks.getTask(instanceId);
    expect(task?.status).toBe('done');
    const last = task?.transitions.at(-1);
    expect(last?.by).toMatchObject({ id: READER, name: READER_NAME, kind: 'agent' });
    expect(last?.note).toBe('Inbox pass pass-7: 1 accepted, 1 rejected');

    now += MINUTE;
    handle.runScheduler();
    expect(state()?.wake?.answeredAt).toBeDefined();
    expect(state()?.wake?.answeredBy).toBe(READER_NAME);
  });

  it('closes with no rows when the pass found nothing new', async () => {
    const run = instance();
    const { status, out } = await post({
      agentId: READER,
      pass: 'pass-8',
      rows: [],
      run: { workspaceId, taskId: run.id },
    });
    expect(status).toBe(200);
    expect(out).toMatchObject({ accepted: 0, run: { closed: true } });
    expect(statusOf(run.id)).toBe('done');
    expect(handle.tasks.getTask(run.id)?.transitions.at(-1)?.note).toBe(
      'Inbox pass pass-8: 0 accepted, 0 rejected',
    );
  });

  it('still refuses an empty pass that names no run', async () => {
    const { status } = await post({ agentId: READER, pass: 'pass-9', rows: [] });
    expect(status).toBe(400);
  });
});

describe('a run close the server refuses: rows kept, nothing moved', () => {
  const refused = async (run: unknown, error: string, taskId?: string) => {
    const before = taskId === undefined ? undefined : handle.tasks.getTask(taskId);
    const trail = before?.transitions.length;
    const status0 = before?.status;
    const { status, out } = await post({ agentId: READER, pass: 'pass-r', rows: [live()], run });
    expect(status).toBe(200);
    expect(out).toMatchObject({ accepted: 1, created: 1, run: { closed: false, error } });
    if (taskId !== undefined) {
      expect(statusOf(taskId)).toBe(status0);
      expect(handle.tasks.getTask(taskId)?.transitions.length).toBe(trail);
    }
  };

  it('an instance owned by another agent', async () => {
    const run = instance({ assignee: OTHER_NAME });
    await refused({ workspaceId, taskId: run.id }, 'not-the-readers-run', run.id);
  });

  it('a task that is not a scheduled instance', async () => {
    const run = instance({ scheduled: false });
    await refused({ workspaceId, taskId: run.id }, 'not-a-scheduled-run', run.id);
  });

  it('an instance already done', async () => {
    const run = instance();
    const moved = handle.tasks.transition(run.id, 'done', {
      actor: { id: READER, name: READER_NAME, kind: 'agent' },
    });
    expect(moved.ok).toBe(true);
    await refused({ workspaceId, taskId: run.id }, 'run-already-done', run.id);
  });

  it('an archived instance', async () => {
    const run = instance();
    const archived = handle.tasks.archiveTask(run.id, {
      actor: { id: READER, name: READER_NAME, kind: 'agent' },
    });
    expect(archived.ok).toBe(true);
    await refused({ workspaceId, taskId: run.id }, 'run-archived', run.id);
  });

  it('the right task id under another board’s id', async () => {
    const run = instance();
    await refused({ workspaceId: otherBoard, taskId: run.id }, 'run-not-found', run.id);
  });

  it('malformed ids, and a run that is not an object', async () => {
    const run = instance();
    await refused({ workspaceId: '../etc', taskId: run.id }, 'bad-run-ids', run.id);
    await refused({ workspaceId, taskId: 'a b/c' }, 'bad-run-ids', run.id);
    await refused({ workspaceId, taskId: run.id, extra: 1 }, 'bad-run', run.id);
    await refused('t-1', 'bad-run', run.id);
  });

  it('a board that does not exist', async () => {
    const run = instance();
    await refused({ workspaceId: 'ws-nowhere', taskId: run.id }, 'run-board-not-found', run.id);
  });
});

describe('the post’s gates are unchanged by run', () => {
  it('refuses a non-reader naming a run before anything is read or moved', async () => {
    const run = instance({ assignee: OTHER_NAME });
    const { status, out } = await post(
      { agentId: OTHER, pass: 'pass-x', rows: [], run: { workspaceId, taskId: run.id } },
      OTHER,
    );
    expect(status).toBe(403);
    expect(out.error).toBe('not-the-inbox-reader');
    expect(statusOf(run.id)).toBe('todo');
  });
});
