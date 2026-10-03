/**
 * The link an agent hands a person for its thread on a page, and the page
 * the thread is pinned to, through the REAL server.
 *
 * Two things went wrong on an attached app. `threadUrl` was the app's root,
 * so the link opened neither the page nor the comment. And an agent's `path`
 * was stored as typed: `/calendar` where the dev server answers
 * `/calendar/`, which is the address the frame ends up on and the one a
 * person's thread on that page is keyed by.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type DevServerFixture, startDevServer } from './app-dev-server-fixture.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };

interface Created {
  thread: { id: string; anchor: { context?: { url?: string } } };
  threadUrl?: string;
}

describe("an agent's page thread: its link and its page", () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let ws = '';
  let app = '';
  let mock = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });
  const byFind = async (docId: string, body: Record<string, unknown>): Promise<Created> => {
    const res = await post(`/workspaces/${ws}/docs/${docId}/threads/by_find`, {
      author: AGENT,
      text: 'Is this right?',
      ...body,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Created;
  };
  /** The part of a link a browser sends to this server, plus its fragment. */
  const address = (link: string | undefined): string => {
    const u = new URL(link ?? 'http://none/');
    return u.pathname + u.search + u.hash;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'page-thread-links-'));
    dev = startDevServer();
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
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

  it('links an app thread to its page, with the thread selected', async () => {
    const got = await byFind(app, { find: 'Harborlight events', path: '/?month=june#week-2' });
    expect(address(got.threadUrl)).toBe(
      `/workspaces/${ws}/apps/${app}/?month=june&thread=${got.thread.id}#week-2`,
    );
  });

  it('links a mock thread to the mock, with the thread selected', async () => {
    const got = await byFind(mock, { find: 'Riverbend walk' });
    expect(address(got.threadUrl)).toBe(
      `/workspaces/${ws}/mockups/${mock}?thread=${got.thread.id}`,
    );
  });

  it('pins a path to the address the dev server answers it at', async () => {
    // The fixture answers /about with a redirect to /about/.
    const got = await byFind(app, { find: 'Harborlight events', path: '/about' });
    expect(got.thread.anchor.context?.url).toBe(`/workspaces/${ws}/apps/${app}/about/?cw-frame=1`);
    expect(address(got.threadUrl)).toBe(
      `/workspaces/${ws}/apps/${app}/about/?thread=${got.thread.id}`,
    );
  });

  it("drops the board's own query from a path, whichever spelling the agent copied", async () => {
    const spellings = ['/about/?cw-frame=1', '/about?thread=t-old', '/about/'];
    for (const path of spellings) {
      const got = await byFind(app, { find: 'Harborlight events', path });
      expect(got.thread.anchor.context?.url, path).toBe(
        `/workspaces/${ws}/apps/${app}/about/?cw-frame=1`,
      );
    }
  });
});
