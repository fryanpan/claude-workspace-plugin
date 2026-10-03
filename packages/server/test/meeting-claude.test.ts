/**
 * The meeting Claude's two rules and what it does once both pass, with the
 * board, the voice and the call all fakes.
 */
import { describe, expect, it } from 'bun:test';
import {
  MEETING_SPOKEN_MAX_WORDS,
  MeetingClaude,
  type MeetingUtterance,
  createMeetingClaude,
  isOwner,
  spokenLine,
  wakeRequest,
} from '../src/meeting-claude.ts';
import type { RecallClient } from '../src/recall.ts';
import { type SpokenAnswerer, type SpokenBoard, shapedAnswer } from '../src/spoken-reply/answer.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';

const OWNER = 'riverbend@example.test';

describe('the wake phrase', () => {
  it('takes the request after "Claude," and its spoken variants', () => {
    expect(wakeRequest('Claude, what is next?')).toBe('what is next?');
    expect(wakeRequest('Hey Claude, what is next?')).toBe('what is next?');
    expect(wakeRequest('Okay, Claude. Status update.')).toBe('Status update.');
    expect(wakeRequest('claude — what is blocked?')).toBe('what is blocked?');
  });

  it('is not a mention, a near-miss, or the name with nothing asked', () => {
    for (const text of [
      'What is next?',
      'Ask Claude, what is next?',
      'Cloud, what is next?',
      'Claudia, what is next?',
      "Claude's list says what is next.",
      'Claude is taking notes.',
      'Claude,',
      'Claude.',
    ]) {
      expect(wakeRequest(text), text).toBeNull();
    }
  });
});

describe('who counts as the owner', () => {
  it('is the participant whose email matches, in any case', () => {
    expect(isOwner({ name: null, email: 'Riverbend@Example.test' }, OWNER)).toBe(true);
  });

  it('fails closed: no email, another email, or no owner configured', () => {
    expect(isOwner({ name: 'Riverbend', email: null }, OWNER)).toBe(false);
    expect(isOwner({ name: 'Riverbend', email: 'saltmarsh@example.test' }, OWNER)).toBe(false);
    expect(isOwner({ name: 'Riverbend', email: null }, null)).toBe(false);
    expect(isOwner({ name: 'Riverbend', email: '' }, '')).toBe(false);
  });
});

describe('the line said', () => {
  it('is the first point, cut at the word cap', () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const said = spokenLine({
      spoken: long,
      points: [{ say: long }],
      detail: [],
      asking: false,
      route: 'x',
    });
    expect(said.split(' ')).toHaveLength(MEETING_SPOKEN_MAX_WORDS);
    expect(said.endsWith('…')).toBe(true);
  });
});

function utterance(text: string, notes: string[]): MeetingUtterance {
  return {
    docId: 'd-1',
    botId: 'bot_1',
    speaker: { name: 'Riverbend', email: OWNER },
    text,
    note: (m) => notes.push(m),
  };
}

const answerer = (said: string, route = 'fast-path', gate?: Promise<void>): SpokenAnswerer =>
  ({
    answer: async () => {
      await gate;
      return shapedAnswer(said, route, ['More below.']);
    },
  }) as unknown as SpokenAnswerer;

describe('answering', () => {
  it('writes the minute even when the voice fails, and nothing for an answer with none', async () => {
    const notes: string[] = [];
    const broken: SpokenVoice = {
      name: 'broken',
      speak: () => Promise.reject(new Error('voice down')),
    };
    const logged: string[] = [];
    const claude = new MeetingClaude({
      ownerEmail: OWNER,
      answererFor: () => answerer('Moved "Berth" from todo to done.', 'fast-path-action'),
      actor: () => ({ id: 'o', name: 'Riverbend' }),
      voice: broken,
      play: () => Promise.reject(new Error('never reached')),
      log: (l) => logged.push(l),
    });
    expect(await claude.heard(utterance('Claude, mark the berth done.', notes))).toBe('answered');
    expect(notes).toEqual(['- Claude: “Berth”: todo → done']);
    expect(logged.join(' ')).toContain('voice down');

    const quiet = new MeetingClaude({
      ownerEmail: OWNER,
      answererFor: () => answerer('Two tasks wait on you.'),
      actor: () => ({ id: 'o', name: 'Riverbend' }),
      voice: null,
      play: async () => {},
    });
    const none: string[] = [];
    expect(await quiet.heard(utterance('Claude, what waits?', none))).toBe('answered');
    expect(none).toEqual([]);
  });

  it('drops a second request while the first is still being said', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const played: number[] = [];
    const claude = new MeetingClaude({
      ownerEmail: OWNER,
      answererFor: () => answerer('Done.', 'fast-path', gate),
      actor: () => ({ id: 'o', name: 'Riverbend' }),
      voice: { name: 'v', speak: async (t, on) => on(new TextEncoder().encode(t)) },
      play: async (_b, mp3) => {
        played.push(mp3.length);
      },
    });
    const first = claude.heard(utterance('Claude, one?', []));
    expect(await claude.heard(utterance('Claude, two?', []))).toBe('busy');
    release();
    expect(await first).toBe('answered');
    expect(played).toHaveLength(1);
  });

  it('says so when no board holds the meeting', async () => {
    const notes: string[] = [];
    const said: string[] = [];
    const claude = new MeetingClaude({
      ownerEmail: OWNER,
      answererFor: () => null,
      actor: () => ({ id: 'o', name: 'Riverbend' }),
      voice: {
        name: 'v',
        speak: async (t, on) => {
          said.push(t);
          on(new Uint8Array(4));
        },
      },
      play: async () => {},
    });
    await claude.heard(utterance('Claude, what is next?', notes));
    expect(said[0]).toContain('not on a board');
    expect(notes).toEqual([]);
  });
});

describe('the server switch', () => {
  const client = { outputAudio: async () => {} } as unknown as RecallClient;
  const base = {
    client,
    voice: null,
    board: () => ({}) as SpokenBoard,
    boardOf: () => 'w-1',
    ownerId: () => 'known-owner',
  };

  it('is off unless switched on, with an owner email and a Recall client', () => {
    expect(createMeetingClaude({ ...base, enabled: false, ownerEmail: OWNER })).toBeNull();
    expect(createMeetingClaude({ ...base, enabled: true, ownerEmail: '' })).toBeNull();
    expect(
      createMeetingClaude({ ...base, enabled: true, ownerEmail: OWNER, client: null }),
    ).toBeNull();
    expect(createMeetingClaude({ ...base, enabled: true, ownerEmail: OWNER })).not.toBeNull();
  });

  it('says in one log line whether it is on, and why not', () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    createMeetingClaude({ ...base, enabled: false, ownerEmail: OWNER, log });
    createMeetingClaude({ ...base, enabled: true, ownerEmail: '', log });
    createMeetingClaude({ ...base, enabled: true, ownerEmail: OWNER, client: null, log });
    createMeetingClaude({ ...base, enabled: true, ownerEmail: OWNER, log });
    expect(lines).toEqual([
      '[meeting-claude] off: switched off',
      '[meeting-claude] off: no owner email',
      '[meeting-claude] off: no Recall client',
      '[meeting-claude] on',
    ]);
  });
});
