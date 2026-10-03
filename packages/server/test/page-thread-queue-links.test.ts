/**
 * Where a review item on an app page's thread sends the reader, through the
 * REAL server: the Home queue's row and the push a device is sent.
 *
 * Both used to send an app thread to the app's root (the push) or to the
 * markdown editor (Home, which had no page to send it to). The row now names
 * the page its thread is pinned to, and the push opens that page with
 * `?thread=`, the form `threadUrl` has had since the agent's link was fixed.
 *
 * All fixtures synthetic; port 0; the push service is a stub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type DevServerFixture, startDevServer } from './app-dev-server-fixture.ts';
import { decryptPush, pushDevice } from './push-decrypt.ts';
import { waitFor } from './wait-for.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const BASE_URL = 'https://board.example.com';

describe("a review item on an app page's thread", () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let device: Awaited<ReturnType<typeof pushDevice>>;
  const sent: Uint8Array<ArrayBuffer>[] = [];
  let ws = '';
  let app = '';
  let mock = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** File a declared ask on a page by its words; the thread's id and page. */
  const ask = async (docId: string, body: Record<string, unknown>) => {
    const res = await post(`/workspaces/${ws}/docs/${docId}/threads/by_find`, {
      author: AGENT,
      text: 'Bryan, does the bike page read right?',
      review: { shape: 'review', headline: 'Does the bike page read right?' },
      ...body,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (
      (await res.json()) as { thread: { id: string; anchor: { context?: { url?: string } } } }
    ).thread;
  };
  /** The link in the one push sent since `from`. */
  const pushedLink = async (from: number): Promise<string> => {
    const body = await waitFor(() => sent[from], { describe: 'a push was sent' });
    return (JSON.parse(await decryptPush(device, body)) as { url: string }).url;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'page-thread-queue-'));
    dev = startDevServer();
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
    device = await pushDevice('https://push.example.com/s/harborlight-1');
    expect(
      (await post('/api/push/subscriptions', { author: AGENT, subscription: device.subscription }))
        .ok,
    ).toBe(true);
    const created = await post('/workspaces', { name: 'Harborlight events', author: AGENT });
    ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const attached = await post(`/workspaces/${ws}/apps`, {
      docId: 'harborlight-site',
      origin: `${dev.origin}/`,
    });
    app = ((await attached.json()) as { docId: string }).docId;
    const html = join(dataDir, 'riverbend.html');
    writeFileSync(html, '<!doctype html><html><body><h1>Riverbend walk</h1></body></html>');
    const m = await post(`/workspaces/${ws}/docs`, {
      docId: 'riverbend',
      type: 'mockup',
      sourceUrl: html,
    });
    mock = ((await m.json()) as { docId: string }).docId;
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('pushes a link to the page, with the thread selected', async () => {
    const from = sent.length;
    const thread = await ask(app, { find: 'Harborlight events', path: '/about/?day=sun#week-2' });
    expect(await pushedLink(from)).toBe(
      `${BASE_URL}/workspaces/${ws}/apps/${app}/about/?day=sun&thread=${thread.id}#week-2`,
    );
  });

  it('pushes a mock thread to the mock, as before', async () => {
    const from = sent.length;
    const thread = await ask(mock, { find: 'Riverbend walk' });
    expect(await pushedLink(from)).toBe(
      `${BASE_URL}/workspaces/${ws}/mockups/${mock}?thread=${thread.id}`,
    );
  });

  it("puts the thread's page on its Home row", async () => {
    const thread = await ask(app, { find: 'Harborlight events', path: '/' });
    const res = await fetch(`${base}/workspaces/${ws}/review-items`);
    const { items } = (await res.json()) as {
      items: Array<{ threadId?: string; docType?: string; pageUrl?: string }>;
    };
    const row = items.find((i) => i.threadId === thread.id);
    expect(row?.docType).toBe('app');
    expect(row?.pageUrl).toBe(thread.anchor.context?.url);
    expect(row?.pageUrl).toBe(`/workspaces/${ws}/apps/${app}/?cw-frame=1`);
  });
});
