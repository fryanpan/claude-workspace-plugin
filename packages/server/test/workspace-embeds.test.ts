/**
 * The board's embed mapping over its REST route: stored whole, read back, and
 * a hostile template refused before anything is written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const SFWORKS = {
  sfworks: { appDocId: 'd-app1', pathTemplate: '{mount}/embed/bike/{block}/' },
};

describe('/workspaces/<ws>/embeds', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-embeds-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const put = (embeds: unknown): Promise<Response> =>
    fetch(`${base}/workspaces/${ws}/embeds`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds }),
    });

  it('reads an empty mapping on a board nobody has set', async () => {
    const res = await fetch(`${base}/workspaces/${ws}/embeds`);
    expect(await res.json()).toEqual({ workspaceId: ws, embeds: {} });
  });

  it('stores a mapping and reads it back', async () => {
    expect((await put(SFWORKS)).status).toBe(200);
    const res = await fetch(`${base}/workspaces/${ws}/embeds`);
    expect(await res.json()).toEqual({ workspaceId: ws, embeds: SFWORKS });
  });

  it('refuses a template that leaves the app mount, and keeps the old mapping', async () => {
    const res = await put({
      sfworks: { appDocId: 'd-app1', pathTemplate: 'https://x/{block}' },
    });
    expect(res.status).toBe(400);
    const read = await fetch(`${base}/workspaces/${ws}/embeds`);
    expect(((await read.json()) as { embeds: unknown }).embeds).toEqual(SFWORKS);
  });

  it('stores an entry at an allowlisted origin, and refuses any other origin', async () => {
    const atOrigin = {
      sfworks: { origin: 'https://harborlight.example', pathTemplate: '{origin}/embed/{block}/' },
    };
    const other = {
      sfworks: { origin: 'https://saltmarsh.example', pathTemplate: '{origin}/{block}/' },
    };
    // No file: the allowlist is empty, so every origin is refused.
    expect((await put(atOrigin)).status).toBe(400);
    expect((await put(other)).status).toBe(400);
    // The owner writes the file; the same server takes it on the next call.
    writeFileSync(join(dataDir, 'embed-origins.json'), '["https://harborlight.example"]');
    expect((await put(atOrigin)).status).toBe(200);
    const res = await put(other);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('allowlist');
    const read = await fetch(`${base}/workspaces/${ws}/embeds`);
    expect(((await read.json()) as { embeds: unknown }).embeds).toEqual(atOrigin);
  });

  it('leaves a stored origin entry out of a read once the file drops it, or stops parsing', async () => {
    const file = join(dataDir, 'embed-origins.json');
    for (const body of ['["https://riverbend.example"]', '{not json']) {
      writeFileSync(file, body);
      const res = await fetch(`${base}/workspaces/${ws}/embeds`);
      expect(((await res.json()) as { embeds: unknown }).embeds).toEqual({});
    }
    rmSync(file);
  });

  it('takes CW_EMBED_ORIGINS over the file', async () => {
    process.env.CW_EMBED_ORIGINS = 'https://saltmarsh.example';
    try {
      const res = await put({
        sfworks: { origin: 'https://saltmarsh.example', pathTemplate: '{origin}/{block}/' },
      });
      expect(res.status).toBe(200);
    } finally {
      Reflect.deleteProperty(process.env, 'CW_EMBED_ORIGINS');
    }
  });

  it('clears with an empty object', async () => {
    expect((await put({})).status).toBe(200);
    const res = await fetch(`${base}/workspaces/${ws}/embeds`);
    expect(((await res.json()) as { embeds: unknown }).embeds).toEqual({});
  });
});
