/**
 * The two things the reader's first pass against a live server tripped on,
 * through the real server: a config written after boot takes effect on the
 * next post, and a row may carry the sender's own id, which the server
 * hashes and never keeps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { senderKeyFor } from '../src/inbox/sender-key.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { row } from './inbox-fixtures.ts';

const READER = 'agent-reader';
// Built at runtime so no address sits in the source.
const ALICE = ['alice', 'example.com'].join('@');
const BOB = ['bob', 'example.com'].join('@');

let handle: ServerHandle;
let root: string;
let dataDir: string;
let base: string;
let token: string;

const configFile = () => join(dataDir, 'inbox', 'config.json');
const writeConfig = (body: string) => {
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  writeFileSync(configFile(), body);
};
const live = (over: Record<string, unknown> = {}) =>
  row({ receivedAt: Date.now() - 25 * 60_000, ...over });
const post = (rows: unknown[], pass = 'pass-1') =>
  fetch(`${base}/inbox/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agentId: READER, pass, rows }),
  });
const storedRows = () => {
  const path = join(dataDir, 'inbox', 'rows.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'inbox-reader-live-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  handle = createServer({
    port: 0,
    dataDir,
    identifyAgentCaller: async () => ({ ok: true, agentId: READER, via: 'session' }),
  });
  base = `http://127.0.0.1:${handle.port}`;
  const res = await fetch(`${base}/api/agents/${READER}/token`);
  expect(res.status).toBe(200);
  token = ((await res.json()) as { token: string }).token;
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a config written after boot', () => {
  it('is refused before the file exists and accepted once it is written', async () => {
    expect(existsSync(configFile())).toBe(false);
    const before = await post([live()]);
    expect(before.status).toBe(503);
    expect(((await before.json()) as { error: string }).error).toBe('inbox-reader-unset');

    writeConfig(JSON.stringify({ readerAgentId: READER }));
    const after = await post([live()]);
    expect(after.status).toBe(200);
    expect(((await after.json()) as { accepted: number }).accepted).toBe(1);
  });

  it('keeps the last good config when rewritten with something that is not JSON', async () => {
    writeConfig('{"readerAgentId": ');
    const res = await post([live()]);
    expect(res.status).toBe(200);
    writeConfig(JSON.stringify({ readerAgentId: READER }));
  });
});

describe('a row carrying senderId', () => {
  it('gets the server’s key, the same one however the address is spelled', async () => {
    writeConfig(JSON.stringify({ readerAgentId: READER }));
    const rows = [
      live({ senderKey: undefined, senderId: ALICE }),
      live({ senderKey: undefined, senderId: `  ${ALICE.toUpperCase()} ` }),
      live({ senderKey: undefined, senderId: BOB }),
    ];
    const res = await post(rows, 'pass-ids');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).accepted).toBe(3);
    const stored = JSON.parse(storedRows()) as { rows: Array<Record<string, unknown>> };
    const keyOf = (r: Record<string, unknown>) =>
      stored.rows.find((s) => s.dedupeKey === r.dedupeKey)?.senderKey;
    const [a, b, c] = rows.map((r) => keyOf(r as Record<string, unknown>));
    expect(a).toBe(senderKeyFor('gmail', ALICE) ?? 'missing');
    expect(b).toBe(a);
    expect(c).toBe(senderKeyFor('gmail', BOB) ?? 'missing');
    expect(c).not.toBe(a);
    for (const raw of [ALICE, BOB]) {
      expect(storedRows().toLowerCase()).not.toContain(raw);
      expect(text.toLowerCase()).not.toContain(raw);
    }
    expect(stored.rows.every((s) => !('senderId' in s))).toBe(true);
  });

  it('is refused alongside a senderKey, and a row with neither is refused, neither echoing the id', async () => {
    const res = await post(
      [
        live({ senderId: ALICE }),
        live({ senderKey: undefined }),
        live({ senderKey: undefined, senderId: `${ALICE}\u0000` }),
        live(),
      ],
      'pass-refusals',
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      accepted: 1,
      rejected: [
        { index: 0, reason: 'senderId and senderKey are both given' },
        { index: 1, reason: 'senderId is required' },
        { index: 2, reason: 'senderId' },
      ],
    });
    expect(text.toLowerCase()).not.toContain(ALICE);
    expect(storedRows().toLowerCase()).not.toContain(ALICE);
  });
});
