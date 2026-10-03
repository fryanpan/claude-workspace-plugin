/**
 * "Claude, …" in a bot meeting, through the real relay: frames arrive on the
 * socket Recall dialled, and only the owner calling Claude by name gets an
 * answer into the call and a note in the meeting's section.
 *
 * Every silence case is followed by the owner asking properly, and the test
 * waits for THAT answer before counting. One answer then means the earlier
 * frame was heard and passed over, not that the test looked too soon.
 *
 * No network: the vendor, the board and the voice are fakes. Names and
 * addresses are invented — the house fixture names on example.test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingClaude } from '../src/meeting-claude.ts';
import type { NotesComposer, NotesUpdate, TickScheduler } from '../src/meeting-notes.ts';
import { MeetingStore } from '../src/meetings.ts';
import { RecallMeetingRelay } from '../src/recall-meeting.ts';
import type { CreateBotArgs, RecallBot, RecallClient, RecallConfig } from '../src/recall.ts';
import { SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import { waitFor } from './wait-for.ts';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const TOKEN = '0123456789abcdef0123456789abcdef';
const OWNER = 'riverbend@example.test';
const OWNER_NAME = 'Riverbend';
const ASK = 'Claude, what is waiting on me?';

class FakeRecall implements RecallClient {
  readonly created: CreateBotArgs[] = [];
  readonly played: Array<{ botId: string; said: string }> = [];
  readonly config: RecallConfig = {
    region: 'us-east-1',
    publicWsBase: 'wss://example.test',
    retentionHours: 24,
    separateStreams: true,
    botName: 'Meeting Assistant',
  };
  createBot(args: CreateBotArgs): Promise<RecallBot> {
    this.created.push(args);
    return Promise.resolve({ id: 'bot_1' });
  }
  getBot(botId: string): Promise<RecallBot> {
    return Promise.resolve({ id: botId });
  }
  leaveCall(): Promise<void> {
    return Promise.resolve();
  }
  checkKeyRegion() {
    return Promise.resolve({ ok: true as const, region: 'us-east-1' as const });
  }
  outputAudio(botId: string, mp3: Uint8Array): Promise<void> {
    this.played.push({ botId, said: new TextDecoder().decode(mp3) });
    return Promise.resolve();
  }
  requestRecordingPermission(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/** Says text as its own bytes, so a test reads back what was played. */
const voice: SpokenVoice = {
  name: 'fake-mp3',
  speak: async (text, onAudio) => onAudio(new TextEncoder().encode(text)),
};

const idle: TickScheduler = { set: () => 0, clear: () => {} };
const composer: NotesComposer = { name: 'stub', compose: () => Promise.resolve([]) };

function frame(args: { name: string | null; email: string | null; id: number; text: string }) {
  return JSON.stringify({
    event: 'transcript.data',
    data: {
      data: {
        words: args.text.split(' ').map((text) => ({ text })),
        participant: {
          id: args.id,
          name: args.name,
          is_host: false,
          platform: 'google_meet',
          email: args.email,
        },
      },
    },
  });
}

describe('the owner asking Claude in a bot meeting', () => {
  let dataDir: string;
  let vendor: FakeRecall;
  let asked: string[];
  let notes: string[];
  let relay: RecallMeetingRelay;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-claude-'));
    vendor = new FakeRecall();
    asked = [];
    notes = [];
    const board: SpokenBoard = {
      handle: async (_ws, req) => {
        asked.push(`${req.actor.name}: ${req.transcript}`);
        return {
          ok: true,
          route: 'fast-path',
          ack: 'Waiting on you: 2 — “Harborlight plan” on “Launch”. Saltmarsh is moving. Riverbend is blocked.',
        };
      },
      goalStatus: () => undefined,
      goals: () => [],
    };
    const claude = new MeetingClaude({
      ownerEmail: OWNER,
      answererFor: () => new SpokenAnswerer(board, 'w-riverbend'),
      actor: (s) => ({ id: 'known-owner', name: s.name ?? 'Owner', kind: 'known' }),
      voice,
      play: (botId, mp3) => vendor.outputAudio(botId, mp3),
    });
    relay = new RecallMeetingRelay({
      store: new MeetingStore(dataDir),
      notes: {
        composer,
        schedule: idle,
        notesHeadingId: () => 'h-meeting',
        onNotes: (u: NotesUpdate) => {
          for (const e of u.edits ?? []) if ('markdown' in e) notes.push(e.markdown);
        },
      },
      client: vendor,
      broadcast: () => {},
      broadcastTransient: () => {},
      mintToken: () => TOKEN,
      claude,
    });
    const invited = await relay.invite({ docId: 'doc-1', meetingUrl: MEET_URL });
    expect(invited.ok).toBe(true);
  });
  afterEach(async () => {
    await relay.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const say = (who: { name: string | null; email: string | null; id: number }, text: string) =>
    relay.onSocketText(TOKEN, frame({ ...who, text }));
  const owner = { name: OWNER_NAME, email: OWNER, id: 1 };
  const answers = (n: number) =>
    waitFor(() => vendor.played.length >= n, { describe: `${n} answer(s) played` });

  it('creates the bot able to speak', () => {
    expect(vendor.created[0]?.speaks).toBe(true);
  });

  it('answers the owner calling Claude: one line said, and a brief is never noted', async () => {
    say(owner, ASK);
    await answers(1);
    expect(asked).toEqual(['Riverbend: what is waiting on me?']);
    expect(vendor.played).toEqual([
      { botId: 'bot_1', said: 'Waiting on you: 2 — “Harborlight plan” on “Launch”.' },
    ]);
    // A minute would be written before the voice played; a brief has none.
    expect(notes.filter((n) => n.includes('Claude') || n.includes('waiting on me'))).toEqual([]);
  });

  it('stays silent for another speaker saying the same words', async () => {
    say({ name: 'Saltmarsh', email: 'saltmarsh@example.test', id: 2 }, ASK);
    say({ name: 'Harborlight', email: null, id: 3 }, ASK);
    // The owner's display name with no email behind it is anyone renamed.
    say({ name: OWNER_NAME, email: null, id: 4 }, ASK);
    say(owner, ASK);
    await answers(1);
    // A wrongly answered frame would hold the bot's one answer slot, so the
    // asker the board saw is what proves who was answered.
    expect(vendor.played).toHaveLength(1);
    expect(asked).toEqual(['Riverbend: what is waiting on me?']);
  });

  it('stays silent for the owner talking without the wake phrase', async () => {
    say(owner, 'What is waiting on me?');
    // Its own words, so an answer to it could not pass for the control's.
    say(owner, 'I think we should ask Claude, what is blocked?');
    say(owner, ASK);
    await answers(1);
    expect(vendor.played).toHaveLength(1);
    expect(asked).toEqual(['Riverbend: what is waiting on me?']);
  });

  it('stays silent for a near-miss of the wake word', async () => {
    for (const near of [
      'Cloud, what is waiting on me?',
      'Claudia, what is waiting on me?',
      'Clyde, what is waiting on me?',
      "Claude's notes say what is waiting on me.",
      'Claude is taking notes today.',
    ]) {
      say(owner, near);
    }
    say(owner, ASK);
    await answers(1);
    expect(vendor.played).toHaveLength(1);
    expect(asked).toEqual(['Riverbend: what is waiting on me?']);
  });
});
