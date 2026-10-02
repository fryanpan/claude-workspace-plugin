/**
 * A note the server cannot place or read gets one question, and the answer
 * edits that note: the same key comes back with its element or its words
 * changed, and no second note is made.
 *
 * Driven on a clock the test turns by hand, with the mock engine (one word
 * per audio chunk; a turn settles on the chunk after its last word), a fake
 * tidier answering from a queue and a fake voice. Nothing reaches the
 * network. All fixtures are synthetic — the Riverbend register.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceTarget } from '@claude-workspaces/core';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { VOICE_PAUSE_MS, VoiceFeedbackRelay, type VoiceWs } from '../src/voice-feedback-relay.ts';
import type { TidyComplete } from '../src/voice-feedback-tidy.ts';
import { manualClock } from './voice-manual-clock.ts';
import { waitFor } from './wait-for.ts';

/** Two Save buttons: "this one" cannot say which. */
const TARGETS: VoiceTarget[] = [
  { i: 0, tag: 'header', text: 'Riverbend' },
  { i: 1, tag: 'button', text: 'Save', parent: 0 },
  { i: 2, tag: 'footer', text: 'Harborlight' },
  { i: 3, tag: 'button', text: 'Save', parent: 2 },
];

const SCRIPT: MockScriptTurn[] = [
  { words: ['this', 'one', 'is', 'too', 'small'] },
  { words: ['the', 'second', 'one'] },
  { words: ['the', 'footer', 'text', 'is', 'faint'] },
];

const ASK = {
  question: 'Which Save button?',
  choices: [
    { label: 'Save in the header', element: 'e1' },
    { label: 'Save in the footer', element: 'e3' },
  ],
};

type Frame = { type: string; [k: string]: unknown };

describe('a clarifying question edits the note it is about', () => {
  let dataDir: string;
  let relay: VoiceFeedbackRelay;
  let clock: ReturnType<typeof manualClock>;
  let prompts: string[];
  let replies: string[];
  let frames: Frame[];
  let audio: number;
  let spoken: string[];
  let ws: VoiceWs;

  const of = (type: string) => frames.filter((f) => f.type === type);
  const notes = (key?: string) => of('comment').filter((f) => key === undefined || f.key === key);
  const speak = (chunks: number) => {
    for (let i = 0; i < chunks; i++) relay.onAudio(ws, new Uint8Array(640));
  };
  const send = (msg: unknown) => relay.onText(ws, JSON.stringify(msg));
  const until = <T>(probe: () => T, describe: string) => waitFor(probe, { describe });

  const start = async (withVoice = true) => {
    const tidy: TidyComplete = async ({ user }) => {
      prompts.push(user);
      return { text: replies.shift() ?? '{"comments":[]}' };
    };
    relay = new VoiceFeedbackRelay({
      engines: [createMockTranscriptionEngine(SCRIPT)],
      tidy,
      voice: withVoice
        ? {
            async speak(text, onAudio) {
              spoken.push(text);
              onAudio(new Uint8Array(480));
            },
          }
        : null,
      dataDir,
      timers: clock.timers,
      now: clock.now,
    });
    ws = {
      data: { docId: 'riverbend-mock', workspaceId: 'riverbend' },
      send: (p) => {
        if (typeof p === 'string') frames.push(JSON.parse(p) as Frame);
        else audio++;
      },
      close: () => {},
    };
    send({ type: 'start', sampleRate: 16_000, targets: TARGETS });
    await until(() => of('ready')[0], 'ready');
  };

  /** "this one is too small", and the model cannot tell which Save. */
  const askedNote = async () => {
    replies.push(
      JSON.stringify({
        comments: [{ text: 'This Save button is too small.', element: 'e1', ask: ASK }],
      }),
    );
    speak(6);
    clock.advance(VOICE_PAUSE_MS);
    return until(() => of('ask').find((f) => f.question), 'the question');
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-ask-'));
    clock = manualClock();
    prompts = [];
    replies = [];
    frames = [];
    audio = 0;
    spoken = [];
  });
  afterEach(async () => {
    await relay?.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('asks once, says the question aloud, and a tapped answer moves the same note', async () => {
    await start();
    const ask = await askedNote();
    expect(ask).toMatchObject({
      key: 'v1',
      question: 'Which Save button?',
      choices: ['Save in the header', 'Save in the footer'],
      about: 'anchor',
    });
    await until(() => of('ask-audio').length === 2, 'the question said');
    expect(spoken).toEqual(['Which Save button?']);
    expect(audio).toBe(1);
    expect(of('ask-audio').map((f) => f.on)).toEqual([true, false]);

    send({ type: 'answer', key: 'v1', choice: 1 });
    const moved = await until(() => notes('v1').find((f) => f.target === 3), 'v1 moved');
    expect(moved.text).toBe('This Save button is too small.');
    expect(
      notes().every((f) => f.key === 'v1'),
      'no second note',
    ).toBe(true);
    expect(of('ask').at(-1)?.question, 'the question comes down').toBe('');
  });

  it('a short spoken answer is matched without a model call, and edits the same note', async () => {
    await start(false);
    await askedNote();
    expect(of('ask-audio'), 'no voice: shown, not said').toEqual([]);
    speak(4); // "the second one"
    clock.advance(VOICE_PAUSE_MS);
    await until(() => notes('v1').find((f) => f.target === 3), 'v1 moved by voice');
    expect(prompts, 'the answer needed no tidy call').toHaveLength(1);
    expect(notes().every((f) => f.key === 'v1')).toBe(true);
  });

  it('a note is asked only once, however often the model proposes it', async () => {
    await start();
    await askedNote();
    speak(4); // "the second one"
    clock.advance(VOICE_PAUSE_MS);
    await until(() => notes('v1').find((f) => f.target === 3), 'v1 moved');
    // More on the same note, and the model proposes the question again.
    replies.push(
      JSON.stringify({
        comments: [
          {
            continues: true,
            text: 'The footer Save button is too small.',
            element: 'e3',
            ask: ASK,
          },
        ],
      }),
    );
    speak(6); // "the footer text is faint"
    clock.advance(VOICE_PAUSE_MS);
    await until(
      () => notes('v1').find((f) => f.text === 'The footer Save button is too small.'),
      'v1 grown',
    );
    expect(
      of('ask').filter((f) => f.question),
      'one question per note',
    ).toHaveLength(1);
  });

  it('shows the question beside the words when they are not plainly an answer', async () => {
    const script: MockScriptTurn[] = [
      SCRIPT[0] as MockScriptTurn,
      { words: ['i', 'meant', 'the', 'one', 'down', 'by', 'harborlight', 'at', 'the', 'bottom'] },
    ];
    const tidy: TidyComplete = async ({ user }) => {
      prompts.push(user);
      return { text: replies.shift() ?? '{"comments":[]}' };
    };
    relay = new VoiceFeedbackRelay({
      engines: [createMockTranscriptionEngine(script)],
      tidy,
      dataDir,
      timers: clock.timers,
      now: clock.now,
    });
    ws = {
      data: { docId: 'riverbend-mock', workspaceId: 'riverbend' },
      send: (p) => {
        if (typeof p === 'string') frames.push(JSON.parse(p) as Frame);
      },
      close: () => {},
    };
    send({ type: 'start', sampleRate: 16_000, targets: TARGETS });
    await until(() => of('ready')[0], 'ready');
    await askedNote();
    replies.push(
      JSON.stringify({
        comments: [
          { continues: true, text: 'The footer Save button is too small.', element: 'e3' },
        ],
      }),
    );
    speak(11);
    clock.advance(VOICE_PAUSE_MS);
    const moved = await until(() => notes('v1').find((f) => f.target === 3), 'v1 moved');
    expect(prompts[1]).toContain(
      '<asked question="Which Save button?"><choice>Save in the header</choice><choice>Save in the footer</choice></asked>',
    );
    expect(moved.text).toBe('The footer Save button is too small.');
    expect(notes().every((f) => f.key === 'v1')).toBe(true);
    expect(of('ask').at(-1)?.question).toBe('');
  });

  it('a note the person placed is never asked where it goes', async () => {
    await start();
    send({ type: 'pin', target: 1 });
    // The tap is applied once the words before it are folded: a turn of the loop.
    await new Promise((r) => setTimeout(r, 0));
    replies.push(
      JSON.stringify({ comments: [{ text: 'This is too small.', element: 'e1', ask: ASK }] }),
    );
    speak(6);
    clock.advance(VOICE_PAUSE_MS);
    await until(() => notes('v1')[0], 'v1');
    expect(prompts[0]).toContain('<pinned>e1</pinned>');
    expect(of('ask')).toEqual([]);
  });

  it('a skipped question keeps the note as it was', async () => {
    await start();
    await askedNote();
    send({ type: 'answer', key: 'v1', choice: null });
    await until(() => of('ask').at(-1)?.question === '', 'the question down');
    expect(notes('v1').every((f) => f.target === 1)).toBe(true);
  });
});
