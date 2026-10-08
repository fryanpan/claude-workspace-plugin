/**
 * An open ask that stopped applying leaves the reader's queue, stays on its
 * thread, and its asker is told exactly once.
 *
 * Three layers, each driven directly: the queue builder over threads in each
 * state, the notifier with an injected sink and clock, and the real server
 * for the settled path end to end (file, reply, read Home, read the thread).
 * Fixtures are invented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Comment, Thread } from '@claude-workspaces/core';
import { getThreads } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { reviewThreadItems } from '../src/review-queue.ts';
import {
  REVIEW_ITEM_STALE_EVENT,
  type ReviewItemStaleFrame,
  createStaleAskNotifier,
  newlyOrphaned,
  orphanedThreadIds,
} from '../src/review-stale-notify.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const T0 = 1_800_000_000_000;
const AGENT = {
  id: 'agent-harborlight',
  name: 'Harborlight',
  kind: 'agent' as const,
  color: '#000',
};
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'person' as const, color: '#000' };

const declared = (over: Partial<Comment> = {}): Comment =>
  ({
    id: 'c-ask',
    author: AGENT,
    text: 'Alice, keep the Riverbend button?',
    ts: T0,
    review: { shape: 'review', headline: 'Keep the Riverbend button?' },
    ...over,
  }) as Comment;
const reply = (
  id: string,
  ts: number,
  text: string,
  author: typeof AGENT | typeof ALICE = AGENT,
): Comment => ({ id, author, text, ts }) as unknown as Comment;

function thread(comments: Comment[], anchor: Thread['anchor'] = { kind: 'subject' }): Thread {
  return {
    id: 'th-1',
    status: 'open',
    anchor,
    comments,
    commentCount: comments.length,
    lastActivity: T0,
    createdBy: AGENT,
  } as unknown as Thread;
}

const queue = (t: Thread) =>
  reviewThreadItems({
    tasks: [],
    docs: [{ docId: 'riverbend', title: 'Riverbend mock' }],
    source: { threadsOf: () => [t] },
  });

describe('the queue drops an ask that no longer applies', () => {
  it('keeps a live ask (positive control)', () => {
    expect(queue(thread([declared()])).map((r) => r.ask)).toEqual(['Keep the Riverbend button?']);
  });

  it("drops it once the asker's own reply settles it", () => {
    const t = thread([declared(), reply('c-2', T0 + 10, 'I removed the Riverbend button.')]);
    expect(queue(t)).toEqual([]);
  });

  it('drops it while its anchor is orphaned', () => {
    const orphan = {
      kind: 'orphan',
      original: null,
      lastSeenAt: T0 + 5,
    } as unknown as Thread['anchor'];
    expect(queue(thread([declared()], orphan))).toEqual([]);
  });

  it('keeps it when a person, not the asker, says the words', () => {
    const t = thread([declared(), reply('c-2', T0 + 10, 'I removed the Riverbend button.', ALICE)]);
    expect(queue(t).map((r) => r.ask)).toEqual(['Keep the Riverbend button?']);
  });
});

describe('the asker is told once', () => {
  function rig(t: Thread) {
    const sent: Array<{ channel: string; agentId: string; frame: ReviewItemStaleFrame }> = [];
    const notifier = createStaleAskNotifier({
      thread: () => t,
      workspaceOf: () => 'w-saltmarsh',
      titleOf: () => 'Riverbend mock',
      sendToAgent: (channel, agentId, frame) => sent.push({ channel, agentId, frame }),
      now: () => T0 + 99,
    });
    return { sent, notifier };
  }

  it('on the reply that settles it, and not on a later one', () => {
    const t = thread([
      declared(),
      reply('c-2', T0 + 10, 'I removed the Riverbend button.'),
      reply('c-3', T0 + 20, 'It is no longer needed.'),
    ]);
    const { sent, notifier } = rig(t);
    notifier.onCommentPosted({ docId: 'riverbend', threadId: 'th-1', commentId: 'c-2' });
    notifier.onCommentPosted({ docId: 'riverbend', threadId: 'th-1', commentId: 'c-3' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe('ws~w-saltmarsh');
    expect(sent[0]?.agentId).toBe(AGENT.id);
    expect(sent[0]?.frame).toMatchObject({
      event: REVIEW_ITEM_STALE_EVENT,
      rule: 'settled',
      commentId: 'c-ask',
      headline: 'Keep the Riverbend button?',
      ts: T0 + 99,
    });
    expect(sent[0]?.frame.withdraw).toContain('withdraw_review_item(docId="riverbend"');
  });

  it('sends nothing for a reply that does not settle it', () => {
    const t = thread([declared(), reply('c-2', T0 + 10, 'Here is the Riverbend chart.')]);
    const { sent, notifier } = rig(t);
    notifier.onCommentPosted({ docId: 'riverbend', threadId: 'th-1', commentId: 'c-2' });
    expect(sent).toEqual([]);
  });

  it('when a sweep newly orphans the thread', () => {
    const orphan = {
      kind: 'orphan',
      original: null,
      lastSeenAt: T0,
    } as unknown as Thread['anchor'];
    const { sent, notifier } = rig(thread([declared()], orphan));
    notifier.onThreadsOrphaned('riverbend', ['th-1']);
    expect(sent.map((s) => s.frame.rule)).toEqual(['orphaned']);
  });

  it('names only threads a sweep newly orphaned', () => {
    const doc = new Y.Doc();
    const threads = getThreads(doc);
    const add = (id: string, kind: string) => {
      const m = new Y.Map<unknown>();
      threads.set(id, m);
      m.set('anchor', { kind });
    };
    add('a', 'orphan');
    add('b', 'text-range');
    const before = orphanedThreadIds(doc);
    (threads.get('b') as Y.Map<unknown>).set('anchor', { kind: 'orphan' });
    expect(newlyOrphaned(before, orphanedThreadIds(doc))).toEqual(['b']);
  });
});

describe('through the real server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stale-asks-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return (await r.json()) as Record<string, unknown>;
  };

  it('drops a settled ask from Home and keeps its words on the thread', async () => {
    const ws = (
      (await post('/workspaces', { name: 'Saltmarsh', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const taskId = (
      (await post(`/workspaces/${ws}/tasks`, {
        title: 'Riverbend mock round',
        assignee: AGENT.name,
        author: AGENT,
      })) as { task: { id: string } }
    ).task.id;
    const docId = `task:${taskId}`;
    const { thread: opened } = (await post(`/workspaces/${ws}/docs/${docId}/threads`, {
      anchor: { kind: 'subject' },
      author: AGENT,
      text: 'Alice, keep the Riverbend button?',
      review: { shape: 'review', headline: 'Keep the Riverbend button?' },
    })) as { thread: { id: string } };
    const home = async () =>
      (
        (await (await fetch(`${base}/workspaces/${ws}/review-items`)).json()) as {
          items: Array<{ ask: string }>;
        }
      ).items.map((r) => r.ask);
    expect(await home()).toEqual(['Keep the Riverbend button?']);

    await post(`/workspaces/${ws}/docs/${docId}/threads/${opened.id}/comments`, {
      author: AGENT,
      text: 'I removed the Riverbend button in this round, so this is no longer needed.',
    });
    expect(await home()).toEqual([]);

    const threads = (await (
      await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`)
    ).json()) as {
      threads: Thread[];
    };
    const ask = threads.threads
      .find((t) => t.id === opened.id)
      ?.comments.find((c) => c.review !== undefined);
    expect(ask?.review?.headline).toBe('Keep the Riverbend button?');
    expect(ask?.review?.withdrawnAt).toBeUndefined();
  });
});
