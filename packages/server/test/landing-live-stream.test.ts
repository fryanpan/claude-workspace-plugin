/**
 * An open workspaces list hears every board change it draws.
 *
 * `/landing/events:stream` sends `landing.changed` when a task, a goal or an
 * ask moves on any board, and the page re-reads `/`
 * (`packages/workspaces-app/src/landing-live.ts`). These drive the real
 * routes: a stream opened first, then a change made through REST the way an
 * agent or another tab makes it, then the frame, then `/` showing the change.
 *
 * All fixtures are invented. Port 0, temp data dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'person' };

/** Count `landing.changed` frames off an open response until stopped. */
function countFrames(res: Response): { count: () => number; stop: () => void } {
  let n = 0;
  let buf = '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          if (buf.slice(0, sep).includes('event: landing.changed')) n += 1;
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
        }
      }
    } catch {
      // Cancelled with a read in flight.
    }
  })();
  return { count: () => n, stop: () => void reader.cancel() };
}

describe('the workspaces list change feed', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';
  const host = () => ({ host: `localhost:${handle.port}` });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...host(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const landing = async () => (await fetch(`${base}/`, { headers: host() })).text();

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'landing-live-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base, { name: 'Harborlight' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('tells an open list about a task and a goal made elsewhere', async () => {
    const res = await fetch(`${base}/landing/events:stream`, { headers: host() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const feed = countFrames(res);
    try {
      const page = await landing();
      expect(page).toContain('id="landing-boards"');
      expect(page).toContain('id="landing-review"');

      await post(`/workspaces/${WS}/tasks`, {
        title: 'Agent can rebuild the Riverbend index nightly',
        author: PERSON,
      });
      await waitFor(() => feed.count() >= 1, { describe: 'a frame for the new task' });

      const before = feed.count();
      const goal = await post(`/workspaces/${WS}/goals/add`, {
        title: 'Ship Saltmarsh',
        author: PERSON,
      });
      expect(goal.status).toBe(200);
      await waitFor(() => feed.count() > before, { describe: 'a frame for the new goal' });
    } finally {
      feed.stop();
    }
  });

  it('carries a board made after the list opened, and the re-read shows it', async () => {
    const feed = countFrames(await fetch(`${base}/landing/events:stream`, { headers: host() }));
    try {
      const other = await seedBoard(base, { name: 'Riverbend' });
      await post(`/workspaces/${other}/tasks`, {
        title: 'Agent can file the Riverbend notes',
        author: PERSON,
      });
      await waitFor(() => feed.count() >= 1, { describe: 'a frame from the new board' });
      expect(await landing()).toContain('Riverbend');
    } finally {
      feed.stop();
    }
  });

  it('answers only GET', async () => {
    const res = await fetch(`${base}/landing/events:stream`, { method: 'POST', headers: host() });
    expect(res.status).toBe(405);
  });
});
