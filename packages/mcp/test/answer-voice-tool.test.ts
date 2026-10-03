/**
 * `answer_voice` — the lead's answer to a spoken request, said aloud on the
 * page that asked (`packages/server/src/spoken-reply/lead-answer.ts`).
 *
 * Driven from SOURCE (`bun run src/mcp.ts`), as post-status-tool.test.ts is,
 * against a stub that records what reached it. The assertions are the route
 * and the body, and what the agent is told when no page was waiting.
 *
 * Fixtures are synthetic; the agent name is fictional.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBackgroundRequest } from './harness/background-requests.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(HERE, '../src/mcp.ts');
const AGENT = 'Beacon Bot';

type Recorded = { method: string; path: string; body: Record<string, unknown> };
type Reply = {
  result?: { isError?: boolean; content?: Array<{ text: string }> };
  error?: { message: string };
};

const seen: Recorded[] = [];
let stub: Server;
let child: ChildProcess;
let nextId = 100;
let pending = '';
const waiters = new Map<number, (value: unknown) => void>();

/** A page waits for `vq-live`; nothing waits for any other row. */
function replyFor(path: string): unknown {
  return { ok: true, delivered: /\/voice-queue\/vq-live\/answer$/.test(path) };
}

function send(msg: unknown) {
  child.stdin?.write(`${JSON.stringify(msg)}\n`);
}

function rpc(method: string, params: unknown): Promise<Reply> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiters.set(id, (v) => resolve(v as Reply));
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  return rpc('tools/call', { name, arguments: args });
}

function payload(reply: Reply): Record<string, unknown> {
  expect(reply.result?.isError, reply.result?.content?.[0]?.text).not.toBe(true);
  return JSON.parse(reply.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

/**
 * Only the answer POSTs. The child also restores its watches against the stub
 * on initialize, redials its event stream on a backoff of its own, and fires
 * a heartbeat it does not await — all of which race a tool call. The recorder
 * drops that traffic (`background-requests.ts`); this narrows to the verb on
 * top of it.
 */
function answerPosts(): Recorded[] {
  return seen.filter((r) => r.method === 'POST' && /\/answer$/.test(r.path));
}

function last(): Recorded {
  const r = answerPosts().at(-1);
  expect(r, 'the stub server received no answer POST at all').toBeTruthy();
  return r as Recorded;
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const rec = { method: req.method ?? '', path, body };
      if (!isBackgroundRequest(rec)) seen.push(rec);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replyFor(path)));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as AddressInfo).port;

  child = spawn('bun', ['run', MCP_ENTRY], {
    env: {
      ...process.env,
      CW_BASE_URL: `http://127.0.0.1:${port}`,
      FEEDBACK_BASE_URL: `http://127.0.0.1:${port}`,
      CW_AGENT_NAME: AGENT,
      CW_WORKSPACE_ID: 'w-home',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => {
    pending += d.toString();
    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line.startsWith('{')) {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
        waiters.delete(msg.id as number);
      }
      nl = pending.indexOf('\n');
    }
  });

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'answer-voice-tool-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('answer_voice — the lead answers out loud', () => {
  it('posts the answer to the queue row it answers, and says it was heard', async () => {
    const out = payload(
      await call('answer_voice', {
        workspaceId: 'w-board',
        queueId: 'vq-live',
        text: '  Ferry fares start at twelve.  ',
      }),
    );
    expect(last().path).toBe('/workspaces/w-board/voice-queue/vq-live/answer');
    expect(last().body).toEqual({
      agentId: expect.stringMatching(/^agent-/),
      text: 'Ferry fares start at twelve.',
    });
    expect(out).toEqual({ delivered: true });
  });

  it('carries a minute for the meeting’s notes when the lead gives one, and only then', async () => {
    payload(
      await call('answer_voice', {
        workspaceId: 'w-board',
        queueId: 'vq-live',
        text: 'Two tasks made.',
        minute: '  Tasks created: Dredge the channel, Move the office  ',
      }),
    );
    expect(last().body).toEqual({
      agentId: expect.stringMatching(/^agent-/),
      text: 'Two tasks made.',
      minute: 'Tasks created: Dredge the channel, Move the office',
    });
    payload(
      await call('answer_voice', {
        workspaceId: 'w-board',
        queueId: 'vq-live',
        text: 'No.',
        minute: ' ',
      }),
    );
    expect(last().body).not.toHaveProperty('minute');
  });

  it('tells the agent where the answer goes when no page is waiting', async () => {
    const out = payload(
      await call('answer_voice', { workspaceId: 'w-board', queueId: 'vq-gone', text: 'Done.' }),
    );
    expect(out.delivered).toBe(false);
    expect(String(out.note)).toMatch(/task or a thread/);
  });

  it('refuses empty text and a missing row before anything leaves the process', async () => {
    const before = answerPosts().length;
    const empty = await call('answer_voice', {
      workspaceId: 'w-board',
      queueId: 'vq-live',
      text: ' ',
    });
    expect(empty.result?.isError).toBe(true);
    const noRow = await call('answer_voice', { workspaceId: 'w-board', text: 'Done.' });
    expect(noRow.result?.isError).toBe(true);
    expect(answerPosts().length).toBe(before);
  });
});
