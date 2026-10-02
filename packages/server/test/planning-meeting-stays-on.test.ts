/**
 * In a planning meeting the planning voice stays on for as long as the
 * meeting records: after its first question is answered it reads the plan
 * again at every later pause somebody spoke into, asks when it has a real
 * question, and never logs its run as done until the socket goes. The model
 * is a script that answers only the reader's prompt; fixture names are the
 * house ones.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { READER_SYSTEM } from '../src/spoken-reply/interview-reader.ts';
import { DOC_ID, type Fixture, ON_DOC, planFixture } from './interview-fixture.ts';

const BERTH_PLAN = `# Harborlight berth plan

## Goal

Open the second Harborlight berth to Riverbend ferries by spring.

### Work

- Dredge the Saltmarsh channel to four metres before March.
- Move the ticket office to the new pier.
`;

const ASK_SIGNOFF = JSON.stringify({ ask: 'Who signs off the dredging?', heading: 'Work' });
const ASK_DATE = JSON.stringify({ ask: 'When does the ticket office move?', heading: 'Work' });
const NONE = '{"ask": null, "why": "Nothing is open."}';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

/** Reader calls only; anything else the voice asks the model gets nothing. */
function reader(replies: string[]) {
  const reads: string[] = [];
  return {
    reads,
    complete: async ({ system, user }: { system: string; user: string }) => {
      if (!system.startsWith(READER_SYSTEM)) return '';
      reads.push(user);
      return replies.shift() ?? NONE;
    },
  };
}

describe('the planning voice in a meeting stays on', () => {
  it('reads again at each later pause, asks its next question, and is never done while recording', async () => {
    const m = reader([ASK_SIGNOFF, NONE, NONE, ASK_DATE]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    const f = fx;
    const heard = (text: string) => f.answerer.answer(text, { id: 'a', name: 'A' }, ON_DOC, true);

    expect((await heard('We dredge first and then move the office.')).spoken).toBe(
      'Who signs off the dredging?',
    );
    expect((await heard('The Saltmarsh harbour office signs it off.')).spoken).toBe(
      'Written under Work.',
    );
    // Recording goes on: the voice has not declared itself done.
    expect(f.rows.filter((r) => r.type === 'end')).toEqual([]);
    expect(f.lines.some((l) => l.startsWith('[interview] done'))).toBe(false);

    // A later pause with nothing worth asking: read, and quiet.
    const quiet = await heard('The crews train in February.');
    expect(quiet).toMatchObject({ spoken: '', asking: true, route: 'interview' });
    // And a later one with a real question: asked.
    const next = await heard('The office move waits on the pier.');
    expect(next).toMatchObject({ spoken: 'When does the ticket office move?', asking: true });
    expect(m.reads).toHaveLength(4);
    // What was said at the quiet pause reaches the next reading too.
    expect(m.reads[3]).toContain('The crews train in February.');
    expect(m.reads[3]).toContain('The office move waits on the pier.');
    expect(f.rows.filter((r) => r.type === 'end')).toEqual([]);

    // The socket goes with the meeting: one end row for the whole meeting.
    f.answerer.close();
    const ends = f.rows.filter((r) => r.type === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ docId: DOC_ID, filled: 1 });
  });

  it('a meeting’s question carries no interview commands; off a meeting it still does', async () => {
    const m = reader([ASK_SIGNOFF, ASK_SIGNOFF]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    const f = fx;
    const asked = await f.answerer.answer('We dredge first.', { id: 'a', name: 'A' }, ON_DOC, true);
    expect(asked).toMatchObject({ spoken: 'Who signs off the dredging?', detail: [] });
    f.answerer.close();
    const tapped = await f.say('We dredge first.');
    expect(tapped.detail).toEqual(['Say skip, come back to that, or that’s enough.']);
  });

  it('off a meeting, a reading run still ends as it did', async () => {
    const m = reader([ASK_SIGNOFF, NONE]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    await fx.say('The Saltmarsh harbour office signs it off.');
    expect(fx.rows.filter((r) => r.type === 'end')).toHaveLength(1);
  });
});
