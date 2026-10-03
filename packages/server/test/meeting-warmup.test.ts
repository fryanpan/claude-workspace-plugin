/**
 * The planning voice does not cut in during a meeting's first minute (Bryan,
 * 3 Oct: it cut in too soon early on, and was better later). A replay of a
 * meeting's opening 60s: small talk in short finished sentences, each one a
 * pause, with a plan reader that always has a question. The voice stays
 * quiet through the opening, then asks at the first pause after it, having
 * heard all of it. "Any questions?" is answered at once whenever it is asked.
 * Fixture names are the house ones.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MEETING_WARMUP_MS } from '../src/spoken-reply/interview-state.ts';
import { type HeardMeeting, heardMeeting } from './meeting-session-harness.ts';
import { waitFor } from './wait-for.ts';

const QUESTION = 'Who is this plan for?';

/** A meeting's first minute, as the transcriber finalized it: seconds in, words. */
const OPENING: ReadonlyArray<readonly [number, string]> = [
  [2, 'Hi everyone.'],
  [5, 'Hey Alice, can you hear me?'],
  [9, 'Yes, loud and clear.'],
  [14, 'Great.'],
  [20, 'Bob is joining in a minute.'],
  [27, 'How was the Harborlight trip?'],
  [34, 'Good, the ferry was on time.'],
  [42, 'Nice.'],
  [50, 'Okay, shall we start?'],
  [57, 'So this is the Riverbend berth plan.'],
];

let m: HeardMeeting | null = null;
afterEach(() => {
  m?.stop();
  m = null;
});

async function meeting() {
  const read: string[] = [];
  const made = await heardMeeting({
    plan: true,
    warmup: true,
    complete: async ({ user }) => {
      read.push(user);
      return JSON.stringify({ ask: QUESTION, heading: 'Goals' });
    },
  });
  m = made;
  let now = 0;
  /** Both clocks: the pause gate's and the interview's. */
  const at = (s: number) => {
    made.fx.tick(s * 1000 - now);
    now = s * 1000;
    made.clock.advanceTo(now);
  };
  /** One finished sentence at `s` seconds, and the reply to its pause. */
  const say = async (turn: number, s: number, text: string) => {
    at(s);
    const before = made.replies().length;
    made.listen();
    made.hear(turn, text, true);
    await waitFor(() => made.replies().length > before, { describe: `the pause after "${text}"` });
    return made.replies().at(-1);
  };
  made.listen();
  await made.ready();
  return { made, read, say };
}

describe('a planning meeting’s first minute', () => {
  it('is heard without a question, and the first pause after it asks one', async () => {
    const { made, read, say } = await meeting();
    let turn = 1;
    for (const [s, text] of OPENING) {
      const reply = await say(turn++, s, text);
      expect(reply?.spoken, `at ${s}s`).toBe('');
    }
    expect(made.said).toEqual([]);
    expect(read).toEqual([]);

    const asked = await say(turn++, 64, 'The berth opens in spring.');
    expect(asked?.spoken).toBe(QUESTION);
    expect(made.said).toEqual([QUESTION]);
    // The reading heard the opening too, not only the last sentence.
    expect(read).toHaveLength(1);
    expect(read[0]).toContain('Hi everyone.');
    expect(read[0]).toContain('The berth opens in spring.');
    expect(64_000).toBeGreaterThanOrEqual(MEETING_WARMUP_MS);
  });

  it('answers “any questions?” in the first minute', async () => {
    const { made, say } = await meeting();
    await say(1, 2, 'Hi everyone.');
    const asked = await say(2, 6, 'Claude, any questions?');
    expect(asked?.spoken).toBe(QUESTION);
    expect(made.said).toEqual([QUESTION]);
  });
});
