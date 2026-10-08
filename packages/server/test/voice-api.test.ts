/**
 * The voice conversation API through the REAL server, driven as an OpenAI
 * client drives it: a bearer, `GET /v1/models`, then streamed
 * `POST /v1/chat/completions` turns whose `model` is the agent.
 *
 * Each turn reaches that agent's own stream and nobody else's; the agent
 * answers with the same route `answer_voice` calls, and the answer closes
 * the stream that asked. Fixture names are the house ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { voiceTokensPath } from '../src/voice-api/tokens.ts';
import { agentStream } from './agent-voice-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

/** A streamed answer, read as it arrives. */
function readStream(res: Response) {
  const out = { text: '', done: false };
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    if (!reader) return;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.text += decoder.decode(value, { stream: true });
    }
    out.done = true;
  })();
  return out;
}

/** The words a stream said, joined from its content deltas. */
function said(stream: string): string {
  return stream
    .split('\n\n')
    .filter((b) => b.startsWith('data: {'))
    .map((b) => JSON.parse(b.slice(6)) as { choices: Array<{ delta: { content?: string } }> })
    .map((c) => c.choices[0]?.delta.content ?? '')
    .join('');
}

describe('the voice conversation API', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let token = '';
  let tokenId = '';
  let lead: Awaited<ReturnType<typeof agentStream>>;
  let helper: Awaited<ReturnType<typeof agentStream>>;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const bearer = () => ({ authorization: `Bearer ${token}` });
  const chat = (body: unknown, headers: Record<string, string> = {}) =>
    post('/v1/chat/completions', body, { ...bearer(), ...headers });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-api-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    for (const [agentId, agentName] of [
      ['harborlight-lead', 'Harborlight Lead'],
      ['riverbend-helper', 'Riverbend Helper'],
      ['saltmarsh-away', 'Saltmarsh Away'],
    ] as const) {
      handle.tasks.attachAgent(boardId, { agentId, agentName, runtime: 'claude-code-local' });
    }
    lead = await agentStream(base, boardId, 'harborlight-lead');
    helper = await agentStream(base, boardId, 'riverbend-helper');
  });

  afterAll(async () => {
    lead.close();
    helper.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses every caller without a voice token, whatever else it carries', async () => {
    const tries: Array<Record<string, string>> = [{}, { authorization: 'Bearer vk1.nothing.here' }];
    for (const headers of tries) {
      const res = await fetch(`${base}/v1/models`, { headers });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_api_key',
      );
    }
  });

  it('mints a token for the owner once, and lists it without its value', async () => {
    const elsewhere = await post(
      '/api/voice/tokens',
      { label: 'x' },
      { origin: 'https://bob.example' },
    );
    expect(elsewhere.status).toBe(403);

    const res = await post('/api/voice/tokens', { label: 'Phone' });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string; token: string; label: string };
    expect(minted.label).toBe('Phone');
    expect(minted.token.startsWith('vk1.')).toBe(true);
    token = minted.token;
    tokenId = minted.id;
    const list = (await (await fetch(`${base}/api/voice/tokens`)).json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    expect(list.tokens.map((t) => t.id)).toEqual([tokenId]);
    expect(JSON.stringify(list)).not.toContain(token.split('.').at(-1) ?? '?');
    expect(statSync(voiceTokensPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it('lists one model per agent', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: bearer() });
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; name: string }>;
    };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id).sort()).toEqual([
      'harborlight-lead',
      'riverbend-helper',
      'saltmarsh-away',
    ]);
    expect(body.data.find((m) => m.id === 'riverbend-helper')?.name).toBe('Riverbend Helper');
  });

  it('streams a turn to the named agent only, and closes on its answer', async () => {
    const first = 'how far is Saltmarsh';
    const res = await chat({
      model: 'riverbend-helper',
      stream: true,
      messages: [{ role: 'user', content: first }],
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const stream = readStream(res);
    await waitFor(() => stream.text.includes('Working on it.'), { describe: 'interim line' });
    await waitFor(() => helper.voice.length === 1, { describe: 'helper got the turn' });
    const turn = helper.voice[0];
    expect(turn?.transcript).toBe(first);
    expect(turn?.to).toBe('riverbend-helper');
    expect(lead.voice.some((v) => v.transcript === first)).toBe(false);

    const queueId = turn?.queueId ?? '';
    const answer = (agentId: string, text: string) =>
      post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, { agentId, text });
    expect(await (await answer('harborlight-lead', 'Wrong one.')).json()).toEqual({
      ok: true,
      delivered: false,
    });
    const words = 'Twelve miles.';
    expect(await (await answer('riverbend-helper', words)).json()).toEqual({
      ok: true,
      delivered: true,
    });
    await waitFor(() => stream.done, { describe: 'stream closed' });
    expect(said(stream.text)).toBe(`Working on it. ${words}`);
    expect(stream.text.endsWith('data: [DONE]\n\n')).toBe(true);

    // The next turn carries the client's messages as the conversation,
    // without the interim line, under the same derived id.
    const next = readStream(
      await chat({
        model: 'riverbend-helper',
        stream: true,
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: first },
          { role: 'assistant', content: said(stream.text) },
          { role: 'user', content: [{ type: 'text', text: 'and the return trip' }] },
        ],
      }),
    );
    await waitFor(() => helper.voice.length === 2, { describe: 'second turn' });
    const second = helper.voice[1];
    expect(second?.conversationId).toBe(turn?.conversationId);
    expect(second?.conversation).toEqual([
      { from: 'owner', text: first },
      { from: 'agent', text: words },
    ]);
    await post(`/workspaces/${boardId}/voice-queue/${second?.queueId}/answer`, {
      agentId: 'riverbend-helper',
      text: 'The same.',
    });
    await waitFor(() => next.done, { describe: 'second stream closed' });

    // Switching is a different model: the other agent, a new conversation.
    const switched = readStream(
      await chat({
        model: 'harborlight-lead',
        stream: true,
        messages: [{ role: 'user', content: 'what is left this week' }],
      }),
    );
    await waitFor(() => lead.voice.length === 1, { describe: 'lead got the switched turn' });
    expect(lead.voice[0]?.conversationId).not.toBe(turn?.conversationId);
    expect(helper.voice).toHaveLength(2);
    await post(`/workspaces/${boardId}/voice-queue/${lead.voice[0]?.queueId}/answer`, {
      agentId: 'harborlight-lead',
      text: 'Two tasks.',
    });
    await waitFor(() => switched.done, { describe: 'switched stream closed' });
  });

  it('says at once when the agent is away, and queues the turn for it', async () => {
    const res = await chat({
      model: 'saltmarsh-away',
      messages: [{ role: 'user', content: 'book the noon boat' }],
    });
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe(
      'Saltmarsh Away is away. I’ll pass it on when they’re back.',
    );
    const row = handle.tasks
      .listQueuedComments(boardId)
      .find((r) => r.agentId === 'saltmarsh-away');
    expect(row?.text).toBe('book the noon boat');
  });

  it('answers 404 for an agent on none of the boards', async () => {
    const res = await chat({ model: 'bob-elsewhere', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_found');
  });

  it('refuses a revoked token', async () => {
    expect((await post(`/api/voice/tokens/${tokenId}/revoke`, {})).status).toBe(200);
    const res = await fetch(`${base}/v1/models`, { headers: bearer() });
    expect(res.status).toBe(401);
  });
});
