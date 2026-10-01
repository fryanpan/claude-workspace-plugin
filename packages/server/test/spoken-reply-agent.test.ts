/**
 * Setup 4's parts on their own: the ElevenLabs agent adapter against a fake
 * socket, the custom-LLM request checks, and the per-socket driver against a
 * fake agent. Nothing reaches ElevenLabs.
 */
import { describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import {
  AgentCallbacks,
  agentLlmResponse,
  bearerMatches,
  parseAgentLlmRequest,
} from '../src/spoken-reply/agent-llm.ts';
import { AgentTurns } from '../src/spoken-reply/agent-turns.ts';
import {
  type AgentEvents,
  type AgentSocketArgs,
  type ElevenLabsAgent,
  agentInitiation,
  createElevenLabsAgent,
  pcmRate,
} from '../src/spoken-reply/elevenlabs-agent.ts';
import { waitFor } from './wait-for.ts';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SECRET = 'fixture-llm-secret-0123456789abcdef';

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  let args: AgentSocketArgs | null = null;
  const factory = (a: AgentSocketArgs) => {
    args = a;
    queueMicrotask(() => a.onOpen());
    return { send: (d: string) => sent.push(JSON.parse(d)), close: () => {} };
  };
  return {
    factory,
    sent,
    get args(): AgentSocketArgs {
      if (!args) throw new Error('no socket yet');
      return args;
    },
    down: (m: unknown) => args?.onMessage(JSON.stringify(m)),
  };
}

const metadata = (input = 'pcm_16000', output = 'pcm_24000') => ({
  type: 'conversation_initiation_metadata',
  conversation_initiation_metadata_event: {
    conversation_id: 'conv_fixture',
    user_input_audio_format: input,
    agent_output_audio_format: output,
  },
});

function recorder(): AgentEvents & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    onUserTranscript: (t) => log.push(`heard:${t}`),
    onAgentResponse: (t) => log.push(`said:${t}`),
    onAudio: (p) => log.push(`audio:${p.length}`),
    onInterrupted: () => log.push('interrupted'),
    onError: (m) => log.push(`error:${m}`),
    onClose: () => log.push('close'),
  };
}

describe('ElevenLabs agent adapter', () => {
  it('opens with the token in the extra body and the key in a header only', async () => {
    const sock = fakeSocket();
    const agent = createElevenLabsAgent({
      apiKey: 'placeholder-key',
      agentId: 'agent_fixture01',
      socketFactory: sock.factory,
    });
    const events = recorder();
    const opening = agent.open({ callbackToken: TOKEN, events });
    await waitFor(() => sock.sent.length > 0, { describe: 'initiation sent' });
    expect(sock.args.url).toBe(
      'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_fixture01',
    );
    expect(sock.args.url).not.toContain('placeholder-key');
    expect(sock.args.headers).toEqual({ 'xi-api-key': 'placeholder-key' });
    expect(sock.sent[0]).toEqual(agentInitiation(TOKEN));
    expect(sock.sent[0]).toEqual({
      type: 'conversation_initiation_client_data',
      custom_llm_extra_body: { cw_session: TOKEN },
    });
    sock.down({ type: 'ping', ping_event: { event_id: 7, ping_ms: 40 } });
    sock.down(metadata());
    const session = await opening;
    expect(session.outputRate).toBe(24000);
    expect(sock.sent[1]).toEqual({ type: 'pong', event_id: 7 });
    session.sendAudio(new Uint8Array([1, 2]));
    session.sendText('the second one');
    expect(sock.sent.slice(2)).toEqual([
      { user_audio_chunk: 'AQI=' },
      { type: 'user_message', text: 'the second one' },
    ]);
    sock.down({ type: 'user_transcript', user_transcription_event: { user_transcript: 'hi' } });
    sock.down({ type: 'agent_response', agent_response_event: { agent_response: 'Hello.' } });
    sock.down({ type: 'audio', audio_event: { audio_base_64: 'AQIDBA==', event_id: 1 } });
    sock.down({ type: 'interruption', interruption_event: { event_id: 2 } });
    sock.args.onClose('code 1000');
    expect(events.log).toEqual([
      'heard:hi',
      'said:Hello.',
      'audio:4',
      'interrupted',
      'error:elevenlabs agent: closed (code 1000)',
      'close',
    ]);
  });

  it('refuses an agent whose audio formats the page cannot use', async () => {
    for (const [input, output, says] of [
      ['ulaw_8000', 'pcm_24000', 'input audio format'],
      ['pcm_16000', 'ulaw_8000', 'output audio format'],
    ] as const) {
      const sock = fakeSocket();
      const agent = createElevenLabsAgent({
        apiKey: 'placeholder-key',
        agentId: 'agent_fixture01',
        socketFactory: sock.factory,
      });
      const opening = agent.open({ callbackToken: TOKEN, events: recorder() });
      await waitFor(() => sock.sent.length > 0);
      sock.down(metadata(input, output));
      await expect(opening).rejects.toThrow(says);
    }
    expect(pcmRate('pcm_16000')).toBe(16000);
    expect(pcmRate('pcm_99')).toBeNull();
    expect(pcmRate(undefined)).toBeNull();
  });
});

describe('custom-LLM request checks', () => {
  it('matches only the exact bearer secret', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    for (const h of [
      null,
      '',
      SECRET,
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(0, -1)}`,
      `bearer ${SECRET}`,
      `Bearer  ${SECRET}`,
      `Basic ${SECRET}`,
    ]) {
      expect(bearerMatches(h, SECRET)).toBe(false);
    }
  });

  it('reads the last user message and the callback token, and nothing malformed', () => {
    const body = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        model: 'claude-workspaces',
        stream: true,
        messages: [
          { role: 'system', content: 'You are a helpful agent.' },
          { role: 'user', content: 'how is the goal going' },
          { role: 'assistant', content: 'Which goal?' },
          { role: 'user', content: [{ type: 'text', text: 'the second one' }] },
        ],
        elevenlabs_extra_body: { cw_session: TOKEN },
        ...over,
      });
    expect(parseAgentLlmRequest(body())).toEqual({
      token: TOKEN,
      question: 'the second one',
      stream: true,
    });
    expect(parseAgentLlmRequest(body({ stream: false }))?.stream).toBe(false);
    for (const bad of [
      'not json',
      'null',
      body({ messages: 'hi' }),
      body({ messages: [{ role: 'system', content: 'x' }] }),
      body({ messages: [null] }),
      body({ elevenlabs_extra_body: undefined }),
      body({ elevenlabs_extra_body: { cw_session: 'short' } }),
      body({ elevenlabs_extra_body: { cw_session: TOKEN.toUpperCase() } }),
    ]) {
      expect(parseAgentLlmRequest(bad)).toBeNull();
    }
  });

  it('answers a streamed request as chunks ending in [DONE]', async () => {
    const r = agentLlmResponse('Harborlight: 3 open.', true, 1_700_000_000_000);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const events = (await r.text()).split('\n\n').filter((e) => e);
    expect(events.at(-1)).toBe('data: [DONE]');
    const first = JSON.parse(events[0]?.slice('data: '.length) ?? '{}');
    expect(first.object).toBe('chat.completion.chunk');
    expect(first.choices[0].delta).toEqual({ role: 'assistant', content: 'Harborlight: 3 open.' });
    const whole = await agentLlmResponse('Hi.', false).json();
    expect(whole.choices[0].message).toEqual({ role: 'assistant', content: 'Hi.' });
  });

  it('forgets a token once revoked', async () => {
    const cbs = new AgentCallbacks();
    const token = cbs.mint(async (q) => `said ${q}`);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await cbs.answer(token, 'x')).toBe('said x');
    expect(cbs.answer(TOKEN, 'x')).toBeNull();
    cbs.revoke(token);
    expect(cbs.answer(token, 'x')).toBeNull();
    expect(cbs.size).toBe(0);
  });
});

/** An agent whose conversation the test drives. */
function fakeAgent() {
  const opens: Array<{ token: string; events: AgentEvents }> = [];
  const up: string[] = [];
  let closes = 0;
  const agent: ElevenLabsAgent = {
    name: 'fake',
    async open({ callbackToken, events }) {
      opens.push({ token: callbackToken, events });
      return {
        outputRate: 16000,
        sendAudio: (pcm) => up.push(`audio:${pcm.length}`),
        sendText: (t) => up.push(`text:${t}`),
        close: () => {
          closes++;
        },
      };
    },
  };
  return {
    agent,
    opens,
    up,
    get closes() {
      return closes;
    },
  };
}

function driver() {
  const fake = fakeAgent();
  const callbacks = new AgentCallbacks();
  const json: SpokenServerMessage[] = [];
  const audio: number[] = [];
  const turns = new AgentTurns({
    agent: fake.agent,
    callbacks,
    answer: async (text) => ({
      spoken: `Heard ${text}.`,
      detail: ['More.'],
      asking: false,
      route: 'fast-path',
    }),
    sendJson: (m) => json.push(m),
    sendAudio: (p) => audio.push(p.length),
    audioQuietMs: 20,
  });
  return { fake, callbacks, json, audio, turns, types: () => json.map((m) => m.type) };
}

describe('setup 4 on one socket', () => {
  it('answers the agent’s call from the answerer and voices what comes back', async () => {
    const d = driver();
    d.turns.start();
    d.turns.audio(new Uint8Array(4)); // held while the conversation connects
    await waitFor(() => d.fake.up.length > 0, { describe: 'held audio sent' });
    expect(d.fake.up).toEqual(['audio:4']);
    const open = d.fake.opens[0];
    if (!open) throw new Error('not opened');
    open.events.onUserTranscript('status please');
    const spoken = await d.callbacks.answer(open.token, 'status please');
    expect(spoken).toBe('Heard status please.');
    open.events.onAgentResponse('Heard status please.'); // already shown: not repeated
    open.events.onAudio(new Uint8Array(6));
    open.events.onAudio(new Uint8Array(6));
    await waitFor(() => d.types().includes('audio-end'), { describe: 'quiet ends the voice' });
    expect(d.json).toEqual([
      { type: 'heard', text: 'status please' },
      { type: 'turn-end', text: 'status please' },
      {
        type: 'reply',
        spoken: 'Heard status please.',
        detail: ['More.'],
        asking: false,
        route: 'fast-path',
      },
      { type: 'audio-start', sampleRate: 16000 },
      { type: 'audio-end' },
    ]);
    expect(d.audio).toEqual([6, 6]);
  });

  it('calls the turn over on the agent’s call when no transcript came first', async () => {
    const d = driver();
    d.turns.start();
    await waitFor(() => d.fake.opens.length > 0);
    await d.callbacks.answer(d.fake.opens[0]?.token ?? '', 'what is waiting on me');
    expect(d.types()).toEqual(['turn-end', 'reply']);
  });

  it('shows what the agent said on its own, drops audio after a stop, and pads a release', async () => {
    const d = driver();
    d.turns.start();
    await waitFor(() => d.turns.connected, { describe: 'connected' });
    const ev = d.fake.opens[0]?.events;
    ev?.onAgentResponse('Hello there.');
    expect(d.json.at(-1)).toEqual({
      type: 'reply',
      spoken: 'Hello there.',
      detail: [],
      asking: false,
      route: 'agent',
    });
    ev?.onAudio(new Uint8Array(2));
    d.turns.stop();
    ev?.onAudio(new Uint8Array(2));
    expect(d.audio).toEqual([2]);
    expect(d.types().slice(-2)).toEqual(['audio-start', 'audio-end']);
    d.turns.start();
    d.turns.end();
    expect(d.fake.up.length).toBe(15);
    expect(d.fake.opens.length).toBe(1);
  });

  it('revokes its token when the socket closes', async () => {
    const d = driver();
    d.turns.start();
    await waitFor(() => d.fake.opens.length > 0);
    const token = d.fake.opens[0]?.token ?? '';
    expect(d.callbacks.size).toBe(1);
    d.turns.close();
    expect(d.callbacks.answer(token, 'x')).toBeNull();
    expect(d.fake.closes).toBe(1);
  });

  it('sends a tapped choice as text', async () => {
    const d = driver();
    d.turns.start();
    await waitFor(() => d.turns.connected, { describe: 'connected' });
    d.turns.say('the second one');
    expect(d.fake.up).toEqual(['text:the second one']);
    expect(d.json.at(-1)).toEqual({ type: 'turn-end', text: 'the second one' });
  });
});
