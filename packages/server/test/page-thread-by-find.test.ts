/**
 * An agent opening a thread on a page it cannot see: an attached app or a
 * served mock, anchored by the words the page shows, through the REAL
 * server.
 *
 * `create_thread` with `find` used to answer 409 no-match on these docs,
 * because `find` searched markdown alone. What has to hold now is the shape
 * stored — the widget's own element anchor, with the page the frame reports
 * as its context — and the far end of a suggestion: Accept is a page edit on
 * the agent's stream, Reject is a resolve and nothing else.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PageEdit, suggestedEdit } from '@claude-workspaces/core/page-edits';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type DevServerFixture, startDevServer } from './app-dev-server-fixture.ts';
import { waitFor } from './wait-for.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const PERSON = { id: 'known-reviewer', name: 'Alice', kind: 'known', color: '#2e7dd7' };

type Frame = { event: string; data: Record<string, unknown> };

function listen(res: Response): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          if (raw.startsWith(':')) continue;
          const f: Frame = { event: 'message', data: {} };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) f.event = line.slice(6).trim();
            else if (line.startsWith('data:')) f.data = JSON.parse(line.slice(5).trim());
          }
          frames.push(f);
        }
      }
    } catch {
      // Cancelled with a read in flight; the frames collected still stand.
    }
  })();
  return { frames, stop: () => void reader.cancel().catch(() => {}) };
}

interface StoredThread {
  id: string;
  anchor: {
    kind: string;
    fingerprint?: { tag: string; text: string };
    snippet?: { text: string };
    context?: { url?: string };
  };
  comments: Array<{ text: string; pageSuggestion?: unknown; pageEdits?: PageEdit[] }>;
}

describe('an agent thread on a page, by its words', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let dev: DevServerFixture;
  let ws = '';
  let app = '';
  let mock = '';
  let md = '';

  const LOCAL = () => ({ host: `localhost:${handle.port}` });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...LOCAL() },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`, { headers: LOCAL() });
  const byFind = (docId: string, body: Record<string, unknown>) =>
    post(`/workspaces/${ws}/docs/${docId}/threads/by_find`, { author: AGENT, ...body });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'page-thread-'));
    dev = startDevServer();
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const created = await post('/workspaces', { name: 'Harborlight events', author: AGENT });
    ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const attached = await post(`/workspaces/${ws}/apps`, {
      docId: 'harborlight-site',
      origin: `${dev.origin}/`,
      title: 'Harborlight site',
    });
    expect(attached.status, await attached.clone().text()).toBe(200);
    app = ((await attached.json()) as { docId: string }).docId;

    const html = join(dataDir, 'riverbend.html');
    writeFileSync(html, '<!doctype html><html><body><h1>Riverbend walk</h1></body></html>');
    const m = await post(`/workspaces/${ws}/docs`, {
      docId: 'riverbend',
      type: 'mockup',
      sourceUrl: html,
    });
    expect(m.status, await m.clone().text()).toBe(200);
    mock = ((await m.json()) as { docId: string }).docId;

    const mdPath = join(dataDir, 'saltmarsh.md');
    writeFileSync(mdPath, '# Saltmarsh notes\n\nBody.\n');
    const d = await post(`/workspaces/${ws}/docs`, { docId: 'saltmarsh', sourceUrl: mdPath });
    md = ((await d.json()) as { docId: string }).docId;
  });
  afterAll(async () => {
    await handle.stop();
    await dev.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("anchors to an app page's words, on the page the frame reports", async () => {
    const res = await byFind(app, {
      text: 'Is this the right date?',
      find: 'Harborlight events',
      path: '/calendar?month=june#week-2',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { thread } = (await res.json()) as { thread: StoredThread };
    expect(thread.anchor.kind).toBe('element');
    expect(thread.anchor.fingerprint?.text).toBe('Harborlight events');
    expect(thread.anchor.snippet?.text).toBe('Harborlight events');
    // The widget inside the frame reads location: the board's prefix, the
    // page's own query with the frame flag after it, then the hash.
    expect(thread.anchor.context?.url).toBe(
      `/workspaces/${ws}/apps/${app}/calendar?month=june&cw-frame=1#week-2`,
    );
  });

  it('refuses an app thread that names no page', async () => {
    const res = await byFind(app, { text: 'Where is this?', find: 'Harborlight events' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('path');
  });

  it('anchors to a mock without a page: a mock is one page', async () => {
    const res = await byFind(mock, { text: 'Shorter?', find: 'Riverbend walk' });
    expect(res.status, await res.clone().text()).toBe(200);
    const { thread } = (await res.json()) as { thread: StoredThread };
    expect(thread.anchor.kind).toBe('element');
    expect(thread.anchor.context).toBeUndefined();
  });

  it('refuses a suggestion on a markdown doc, naming the verb that suggests there', async () => {
    const res = await byFind(md, {
      text: 'Tighter',
      find: 'Saltmarsh notes',
      suggest: { replacement: 'Saltmarsh' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('find_and_replace');
  });

  it('stores a suggestion; Accept reaches the agent as a page edit', async () => {
    const watch = await post(`/api/agents/${AGENT.id}/watches`, { add: [mock] });
    expect(watch.ok).toBe(true);
    const res = await byFind(mock, {
      text: 'Name the street?',
      find: 'Riverbend walk',
      suggest: { replacement: 'Riverbend Street walk' },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { thread } = (await res.json()) as { thread: StoredThread };
    const suggestion = thread.comments[0]?.pageSuggestion;
    expect(suggestion).toEqual({ find: 'Riverbend walk', replacement: 'Riverbend Street walk' });

    // What the widget's Accept posts: the edit a pencil send would carry.
    const heard = listen(await get(`/events/agent/${AGENT.id}`));
    const edit = suggestedEdit(
      {
        anchor: {
          kind: 'element',
          fingerprint: {
            tag: 'H1',
            stableAttrs: {},
            classes: [],
            text: 'Riverbend walk',
            path: 'H1[0] > BODY[0] > HTML[0]',
            dataAttrs: {},
          },
          snippet: { text: 'Riverbend walk' },
        },
        selector: 'h1',
        before: 'Riverbend walk',
      },
      { find: 'Riverbend walk', replacement: 'Riverbend Street walk' },
    );
    expect(edit?.after).toBe('Riverbend Street walk');
    const sent = await post(`/workspaces/${ws}/docs/${mock}/threads`, {
      author: PERSON,
      text: 'x',
      anchor: edit?.anchor,
      pageEdits: [edit],
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const frame = await waitFor(
      () =>
        heard.frames.find(
          (f) =>
            f.event === 'thread.created' &&
            JSON.stringify(f.data).includes('"after":"Riverbend Street walk"'),
        ),
      { describe: 'the accepted edit on the agent stream' },
    );
    heard.stop();
    expect(JSON.stringify(frame.data)).toContain('pageEdits');
  }, 30_000);

  it('Reject resolves the suggestion and files no page edit', async () => {
    const res = await byFind(mock, {
      text: 'Drop the word?',
      find: 'Riverbend walk',
      suggest: { replacement: 'Riverbend' },
    });
    const { thread } = (await res.json()) as { thread: StoredThread };
    const before = await (await get(`/workspaces/${ws}/docs/${mock}/threads`)).json();
    const count = (before as { threads: StoredThread[] }).threads.length;
    const resolved = await post(`/workspaces/${ws}/docs/${mock}/threads/${thread.id}/resolve`, {
      author: PERSON,
    });
    expect(resolved.status).toBe(200);
    const after = (await (await get(`/workspaces/${ws}/docs/${mock}/threads`)).json()) as {
      threads: Array<StoredThread & { status: string }>;
    };
    expect(after.threads.length).toBe(count);
    expect(after.threads.find((t) => t.id === thread.id)?.status).toBe('resolved');
    expect(after.threads.some((t) => t.comments.some((c) => c.pageEdits))).toBe(true);
    expect(
      after.threads.filter((t) => t.comments[0]?.pageEdits?.[0]?.after === 'Riverbend'),
    ).toEqual([]);
  });

  it('refuses a suggestion too long to apply whole', async () => {
    const res = await byFind(mock, {
      text: 'Long',
      find: 'Riverbend walk',
      suggest: { replacement: 'x'.repeat(5000) },
    });
    expect(res.status).toBe(400);
  });
});
