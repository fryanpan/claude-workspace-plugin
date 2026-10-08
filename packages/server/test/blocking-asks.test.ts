/**
 * An ask that STOPS work, through the real server: filed with `blocks`, it
 * leads the Home queue over older asks, and it sends one push whose title
 * says what is stopped.
 *
 * The story it pins: an agent asked whether to re-run a benchmark against a
 * deadline, stopped working, and the item sat on Home for two days looking
 * like every other one. The push service is a stub; fixtures are invented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockingFirst } from '../src/cross-review-queue.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { decryptPush, pushDevice } from './push-decrypt.ts';
import { waitFor } from './wait-for.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight Bench', kind: 'agent' };
const BASE_URL = 'https://board.example.com';

interface Row {
  kind: string;
  ask: string;
  review?: { blocks?: { what: string; hours?: number } };
}

describe('a review item that stops work', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let device: Awaited<ReturnType<typeof pushDevice>>;
  const sent: Uint8Array<ArrayBuffer>[] = [];
  let ws = '';
  let taskId = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rows = async (): Promise<Row[]> =>
    ((await (await fetch(`${base}/workspaces/${ws}/review-items`)).json()) as { items: Row[] })
      .items;
  const pushed = async (from: number): Promise<{ title: string; body: string }> => {
    const body = await waitFor(() => sent[from], { describe: 'a push was sent' });
    return JSON.parse(await decryptPush(device, body)) as { title: string; body: string };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'blocking-asks-'));
    handle = createServer({
      port: 0,
      dataDir,
      publicBaseUrl: BASE_URL,
      pushFetch: async (_url, init) => {
        sent.push(init.body);
        return new Response(null, { status: 201 });
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    device = await pushDevice('https://push.example.com/s/riverbend-1');
    expect(
      (await post('/api/push/subscriptions', { author: AGENT, subscription: device.subscription }))
        .ok,
    ).toBe(true);
    const created = await post('/workspaces', { name: 'Riverbend bench', author: AGENT });
    ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const task = await post(`/workspaces/${ws}/tasks`, {
      title: 'Re-run the Saltmarsh benchmark',
      assignee: 'Harborlight Bench',
      author: AGENT,
    });
    taskId = ((await task.json()) as { task: { id: string } }).task.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('leads the Home queue over older asks, ticket-borne and thread-borne alike', async () => {
    // The older, ordinary ask first: oldest-first would put it on top.
    const plain = await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: { shape: 'review', headline: 'Does the Riverbend chart read right?' },
    });
    expect(plain.status).toBe(200);
    // The send is fire-and-forget, so the first push is waited for before
    // the second is counted from.
    await waitFor(() => sent[0], { describe: 'the first push' });
    const from = sent.length;
    const blocking = await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: {
        shape: 'review',
        headline: 'The Saltmarsh run misses Friday; which date counts?',
        blocks: { what: 'the Saltmarsh benchmark re-run', hours: 48 },
      },
    });
    expect(blocking.status).toBe(200);

    const queue = await rows();
    expect(queue.map((r) => r.ask)).toEqual([
      'The Saltmarsh run misses Friday; which date counts?',
      'Does the Riverbend chart read right?',
    ]);
    expect(queue[0]?.review?.blocks).toEqual({ what: 'the Saltmarsh benchmark re-run', hours: 48 });

    // The push says what is stopped, and the question rides in the body.
    const note = await pushed(from);
    expect(note.title).toBe('Stopped until you answer: the Saltmarsh benchmark re-run');
    expect(note.body).toContain('The Saltmarsh run misses Friday; which date counts?');

    // A comment-borne declaration carries the field the same way.
    const opened = await post(`/workspaces/${ws}/docs/task:${taskId}/threads`, {
      anchor: { kind: 'subject' },
      author: AGENT,
      text: 'Alice, the Harborlight data is stale; I am idle until you pick.',
      review: {
        shape: 'review',
        headline: 'Use the stale Harborlight data or wait for Monday?',
        blocks: { what: 'the Harborlight import' },
      },
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const threadNote = await pushed(from + 1);
    expect(threadNote.title).toBe('Stopped until you answer: the Harborlight import');
    const after = await rows();
    expect(after.slice(0, 2).map((r) => r.ask)).toEqual([
      'The Saltmarsh run misses Friday; which date counts?',
      'Use the stale Harborlight data or wait for Monday?',
    ]);
    expect(after[2]?.ask).toBe('Does the Riverbend chart read right?');
  });

  it('sends exactly one push per filing, and an ordinary ask keeps its usual title', async () => {
    const from = sent.length;
    await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: { shape: 'review', headline: 'Is the Bob export column order right?' },
    });
    // Positive control for "one, not two": three filings so far made exactly
    // three pushes, and this one's push is the next slot, so a second copy of
    // either blocking push would have landed in it.
    expect(from).toBe(3);
    const note = await pushed(from);
    expect(note.title).toBe('Is the Bob export column order right?');
  });

  it('drops a malformed blocks value instead of refusing the ask', async () => {
    const res = await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: { shape: 'review', headline: 'Riverbend label check', blocks: { what: '   ' } },
    });
    expect(res.status).toBe(200);
    const row = (await rows()).find((r) => r.ask === 'Riverbend label check');
    expect(row).toBeDefined();
    expect(row?.review?.blocks).toBeUndefined();
  });
});

describe('the cross-board order', () => {
  it('puts every blocking item first and keeps the order within each half', () => {
    const items = [
      { key: 'a', review: { shape: 'review' as const, headline: 'Riverbend' } },
      {
        key: 'b',
        review: { shape: 'review' as const, headline: 'Saltmarsh', blocks: { what: 'x' } },
      },
      { key: 'c' },
      {
        key: 'd',
        review: { shape: 'review' as const, headline: 'Harborlight', blocks: { what: 'y' } },
      },
    ];
    expect(blockingFirst(items).map((i) => i.key)).toEqual(['b', 'd', 'a', 'c']);
  });
});
