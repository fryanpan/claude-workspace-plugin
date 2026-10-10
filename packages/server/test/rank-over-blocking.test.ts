/**
 * The lead's rank holds over an ask that stops work, and a stopping ask says
 * which goal it stops.
 *
 * Bryan, 2026-10-08: "Well team lead should still rank. But yeah agent should
 * be able to identify that an ask blocks work on a top goal." So a ranked
 * item keeps its place whether or not it blocks; among unranked items a
 * blocking one still leads; and a blocking ask filed on a task carries that
 * task's goal, which the lead's feed of new asks names by title.
 *
 * Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askFromReviewItemAdded, asksFromThreadEvent } from '../src/ask-feed.ts';
import { blockingFirst } from '../src/cross-review-queue.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight Bench', kind: 'agent' };
const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const stops = { what: 'the Saltmarsh re-run' };
const review = (headline: string, blocks?: { what: string; goalId?: string }) => ({
  shape: 'review' as const,
  headline,
  ...(blocks ? { blocks } : {}),
});

describe('the cross-board order', () => {
  it('keeps a ranked item in its place, and lifts a blocking ask among the unranked', () => {
    const items = [
      { key: 'ranked-plain', leadRank: 1, review: review('Riverbend chart') },
      { key: 'unranked-blocking', review: review('Saltmarsh date', stops) },
      { key: 'unranked-plain' },
      { key: 'ranked-blocking', leadRank: 2, review: review('Harborlight data', stops) },
      { key: 'unranked-blocking-2', review: review('Bob export', stops) },
    ];
    expect(blockingFirst(items).map((i) => i.key)).toEqual([
      'ranked-plain',
      'ranked-blocking',
      'unranked-blocking',
      'unranked-blocking-2',
      'unranked-plain',
    ]);
  });
});

describe('a blocking ask names the goal it stops', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';
  let goalId = '';
  let taskId = '';

  const send = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const ok = async <T>(res: Promise<Response>): Promise<T> => {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as T;
  };
  type Row = { ask: string; review?: { blocks?: { what: string; goalId?: string } } };
  const rowFor = async (ask: string): Promise<Row | undefined> =>
    (
      (await (await fetch(`${base}/workspaces/${ws}/review-items`)).json()) as { items: Row[] }
    ).items.find((r) => r.ask === ask);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'rank-over-blocking-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = (
      await ok<{ workspace: { id: string } }>(
        send('POST', '/workspaces', { name: 'Riverbend bench', author: AGENT }),
      )
    ).workspace.id;
    const goals = await ok<{ created: { id: string }[] }>(
      send('PUT', `/workspaces/${ws}/goals`, {
        goals: [{ title: 'Ship the Harborlight launch' }],
        author: PERSON,
      }),
    );
    goalId = goals.created[0]?.id ?? '';
    taskId = (
      await ok<{ task: { id: string } }>(
        send('POST', `/workspaces/${ws}/tasks`, {
          title: 'Re-run the Saltmarsh benchmark',
          goal: goalId,
          author: AGENT,
        }),
      )
    ).task.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("stores the task's goal on a ticket-borne blocking ask", async () => {
    await ok(
      send('POST', `/workspaces/${ws}/tasks/${taskId}/review-items`, {
        author: AGENT,
        review: review('Which Saltmarsh date counts?', stops),
      }),
    );
    expect((await rowFor('Which Saltmarsh date counts?'))?.review?.blocks).toEqual({
      ...stops,
      goalId,
    });
  });

  it("stores the task's goal on a thread-borne blocking ask, over the asker's own", async () => {
    await ok(
      send('POST', `/workspaces/${ws}/docs/task:${taskId}/threads`, {
        anchor: { kind: 'subject' },
        author: AGENT,
        text: 'Alice, I am idle until you pick a Riverbend source.',
        review: review('Which Riverbend source?', { ...stops, goalId: 'g-somewhere-else' }),
      }),
    );
    expect((await rowFor('Which Riverbend source?'))?.review?.blocks?.goalId).toBe(goalId);
  });

  it('leaves an ordinary ask without a goal (positive control on the blocking half)', async () => {
    await ok(
      send('POST', `/workspaces/${ws}/tasks/${taskId}/review-items`, {
        author: AGENT,
        review: review('Does the Bob chart read right?'),
      }),
    );
    const row = await rowFor('Does the Bob chart read right?');
    expect(row).toBeDefined();
    expect(row?.review?.blocks).toBeUndefined();
  });
});

describe("the lead's ranking read", () => {
  const titleOf = (id: string) => (id === 'g-harbor' ? 'Ship the Harborlight launch' : undefined);

  it("names the stopped goal by title on a ticket's ask", () => {
    const ask = askFromReviewItemAdded(
      {
        workspaceId: 'w-river',
        taskId: 't-1',
        reviewItemId: 'r-1',
        headline: 'Which Saltmarsh date counts?',
        blocks: { ...stops, goalId: 'g-harbor' },
        actor: { id: AGENT.id },
        ts: 10,
      },
      'Riverbend',
      titleOf,
    );
    expect(ask.stops).toEqual({ what: stops.what, goal: 'Ship the Harborlight launch' });
  });

  it("names it on a thread's ask, and says nothing for an ordinary one", () => {
    const comment = (id: string, blocks?: { what: string; goalId?: string }) => ({
      id,
      ts: 10,
      author: { id: AGENT.id, name: AGENT.name },
      text: 'x',
      review: review(`Ask ${id}`, blocks),
    });
    const thread = {
      id: 'th-1',
      comments: [comment('c-1', { ...stops, goalId: 'g-harbor' }), comment('c-2')],
    };
    const home = [{ workspaceId: 'w-river', kind: 'task-thread' as const, taskId: 't-1' }];
    const read = (commentId: string) =>
      asksFromThreadEvent(
        {
          event: 'thread.replied',
          docId: 'task:t-1',
          threadId: 'th-1',
          thread: thread as never,
          comment: { id: commentId } as never,
        },
        home,
        titleOf,
      )[0];
    expect(read('c-1')?.stops).toEqual({ what: stops.what, goal: 'Ship the Harborlight launch' });
    expect(read('c-2')).toBeDefined();
    expect(read('c-2')?.stops).toBeUndefined();
  });
});
