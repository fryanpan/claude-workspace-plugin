/**
 * `bun run meeting:say` against a stubbed Recall: the bot is sent able to
 * speak and hearing nothing, the sentence goes out only once the bot is in
 * the call, the verdict says whether Recall took it, and the bot leaves on
 * every way out.
 */
import { describe, expect, it } from 'bun:test';
import { SAY_BOT_NAME, SAY_TEXT, runRecallSay } from '../../../scripts/recall-say.ts';
import type { CreateBotArgs, RecallBot, RecallClient, RecallConfig } from '../src/recall.ts';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';

class StubRecall implements RecallClient {
  readonly created: CreateBotArgs[] = [];
  readonly calls: string[] = [];
  readonly config: RecallConfig = {
    region: 'us-east-1',
    publicWsBase: null,
    retentionHours: 1,
    separateStreams: true,
    botName: 'Meeting Assistant',
  };
  constructor(
    private readonly states: string[],
    private readonly refuse: string | null = null,
  ) {}
  createBot(args: CreateBotArgs): Promise<RecallBot> {
    this.created.push(args);
    this.calls.push('create');
    return Promise.resolve({ id: 'bot_1' });
  }
  getBot(botId: string): Promise<RecallBot> {
    const code = this.states.shift() ?? 'joining_call';
    this.calls.push(`get:${code}`);
    return Promise.resolve({ id: botId, status_changes: [{ code }] });
  }
  leaveCall(): Promise<void> {
    this.calls.push('leave');
    return Promise.resolve();
  }
  outputAudio(_botId: string, mp3: Uint8Array): Promise<void> {
    this.calls.push(`audio:${new TextDecoder().decode(mp3)}`);
    return this.refuse ? Promise.reject(new Error(this.refuse)) : Promise.resolve();
  }
  requestRecordingPermission(): Promise<boolean> {
    return Promise.resolve(true);
  }
  checkKeyRegion() {
    return Promise.resolve({ ok: true as const, region: 'us-east-1' as const });
  }
}

const deps = (client: StubRecall, speak = async (t: string) => new TextEncoder().encode(t)) => ({
  client,
  speak,
  sleep: async () => {},
  log: () => {},
  joinTimeoutMs: 10,
  pollMs: 2,
});

describe('meeting:say', () => {
  it('sends a speaking bot that hears nothing, and says the sentence once it is in', async () => {
    const recall = new StubRecall(['joining_call', 'in_waiting_room', 'in_call_recording']);
    const verdict = await runRecallSay(MEET_URL, deps(recall));
    expect(recall.created).toEqual([{ meetingUrl: MEET_URL, botName: SAY_BOT_NAME, speaks: true }]);
    expect(recall.calls).toEqual([
      'create',
      'get:joining_call',
      'get:in_waiting_room',
      'get:in_call_recording',
      `audio:${SAY_TEXT}`,
      'leave',
    ]);
    expect(verdict).toEqual({
      accepted: true,
      botId: 'bot_1',
      state: 'in_call_recording',
      bytes: new TextEncoder().encode(SAY_TEXT).length,
    });
  });

  it('reports Recall refusing the audio, and still leaves', async () => {
    const recall = new StubRecall(
      ['in_call_not_recording'],
      'Bot is not configured for audio output',
    );
    const verdict = await runRecallSay(MEET_URL, deps(recall));
    expect(verdict.accepted).toBe(false);
    expect(verdict.error).toBe('Bot is not configured for audio output');
    expect(recall.calls.at(-1)).toBe('leave');
  });

  it('sends no audio to a bot that never got in, and still leaves', async () => {
    const ended = new StubRecall(['joining_call', 'fatal']);
    const v1 = await runRecallSay(MEET_URL, deps(ended));
    expect(v1).toMatchObject({ accepted: false, state: 'fatal' });
    const waiting = new StubRecall([]);
    const v2 = await runRecallSay(MEET_URL, deps(waiting));
    expect(v2.error).toBe('timed out waiting to join');
    for (const r of [ended, waiting]) {
      expect(r.calls.some((c) => c.startsWith('audio:'))).toBe(false);
      expect(r.calls.at(-1)).toBe('leave');
    }
  });

  it('sends no bot at all when the voice fails', async () => {
    const recall = new StubRecall(['in_call_recording']);
    const verdict = await runRecallSay(
      MEET_URL,
      deps(recall, () => Promise.reject(new Error('no key'))),
    );
    expect(verdict).toMatchObject({ accepted: false, botId: null, error: 'voice: no key' });
    expect(recall.calls).toEqual([]);
  });
});
