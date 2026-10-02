/**
 * Only what answers the planning voice's question is written into the plan
 * (`interview-answer.ts`): a remark about the tool or the meeting after the
 * answer, or a sentence started and dropped, stays out of the plan and
 * reaches the meeting notes as usual. The model is a script that answers the
 * reader's and the judge's prompts apart; fixture names are the house ones.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { JUDGE_SYSTEM, clauses, parseJudge } from '../src/spoken-reply/interview-answer.ts';
import { READER_SYSTEM } from '../src/spoken-reply/interview-reader.ts';
import { MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import { DOC_ID, type Fixture, ON_DOC, planFixture } from './interview-fixture.ts';

const BERTH_PLAN = `# Harborlight berth plan

## Goal

Open the second Harborlight berth to Riverbend ferries by spring.

### Work

- Dredge the Saltmarsh channel to four metres before March.
`;

const ASK = JSON.stringify({ ask: 'Who signs off the dredging?', heading: 'Work' });
const NONE = '{"ask": null, "why": "Nothing is open."}';
const ANSWER = 'The Saltmarsh harbour office signs it off.';
const REMARK = 'Oh, that was really disruptive. Having that panel open is unnecessary.';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

function model(judged: Array<string | Error>) {
  const judges: string[] = [];
  return {
    judges,
    complete: async ({ system, user }: { system: string; user: string }) => {
      if (system.startsWith(READER_SYSTEM)) return judges.length === 0 ? ASK : NONE;
      if (!system.startsWith(JUDGE_SYSTEM)) return '';
      judges.push(user);
      const next = judged.shift();
      if (next instanceof Error || next === undefined) throw next ?? new Error('model down');
      return next;
    },
  };
}

/** A planning meeting on the fixture's plan, its notes recorded per turn. */
async function meeting(judged: Array<string | Error>) {
  const m = model(judged);
  const ears = new MeetingEars();
  fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete, ears });
  ears.started(DOC_ID);
  const notes: string[] = [];
  const f = fx;
  /** One settled meeting turn: lent to the notes, then heard at the pause. */
  let turnId = 0;
  const turn = (text: string) => {
    const t = { turn: ++turnId, text, final: true };
    ears.toNotes(DOC_ID, () => notes.push(text), t);
  };
  const pause = (text: string) => f.answerer.answer(text, { id: 'a', name: 'A' }, ON_DOC, true);
  const md = () => f.docStore.readOutline(DOC_ID)?.blocks.map((b) => b.text) ?? [];
  return { ...m, f, notes, turn, pause, md };
}

describe('clauses', () => {
  it('cuts off a false start before a new sentence, and keeps a trailing one', () => {
    expect(clauses('I noticed that there’s— Oh, that was really disruptive.')).toEqual([
      { text: 'I noticed that there’s—', cut: true },
      { text: 'Oh, that was really disruptive.', cut: false },
    ]);
    expect(clauses('We dredge first — then the office. And the crews...')).toEqual([
      { text: 'We dredge first — then the office.', cut: false },
      { text: 'And the crews...', cut: false },
    ]);
  });
});

describe('parseJudge', () => {
  it('takes the numbers of sentences that exist, and nothing else', () => {
    expect(parseJudge('{"answer": [1, 3]}', 3)).toEqual([0, 2]);
    expect(parseJudge('ok {"answer": []}', 3)).toEqual([]);
    expect(parseJudge('{"answer": [0, 4, "2"]}', 3)).toEqual([]);
    expect(parseJudge('no json', 3)).toBeNull();
  });
});

describe('the answer the planning voice writes', () => {
  it('writes the answer and leaves a remark about the tool to the notes', async () => {
    const m = await meeting(['{"answer": [1]}']);
    expect((await m.pause('We dredge first.')).spoken).toBe('Who signs off the dredging?');
    m.turn(ANSWER);
    m.turn(REMARK);
    const r = await m.pause(`${ANSWER} ${REMARK}`);
    expect(r.spoken).toBe('Written under Work.');
    expect(m.md()).toContain(ANSWER);
    expect(m.md().join('\n')).not.toContain('disruptive');
    // The judge was asked about the question, sentence by sentence.
    expect(m.judges[0]).toContain('Who signs off the dredging?');
    expect(m.judges[0]).toContain('2. Oh, that was really disruptive.');
    // The notes keep the remark; the answer the plan has stays out of them.
    expect(m.notes).toEqual([REMARK]);
    expect(m.f.rows.find((r) => r.type === 'gap')).toMatchObject({ outcome: 'filled', words: 7 });
  });

  it('writes nothing when nothing said answers the question, and the notes get all of it', async () => {
    const m = await meeting(['{"answer": []}']);
    await m.pause('We dredge first.');
    m.turn(REMARK);
    const r = await m.pause(REMARK);
    expect(r).toMatchObject({ spoken: '', asking: true, route: 'interview' });
    expect(m.md().join('\n')).not.toContain('disruptive');
    expect(m.notes).toEqual([REMARK]);
    expect(m.f.lines).toContain(`[interview] doc=${DOC_ID} section=2 after-answer=quiet`);
  });

  it('drops a false start without asking, and keeps the rest when the model fails', async () => {
    const m = await meeting([new Error('model down')]);
    await m.pause('We dredge first.');
    const r = await m.pause(`The harbour office— ${ANSWER}`);
    expect(r.spoken).toBe('Written under Work.');
    expect(m.md()).toContain(ANSWER);
    expect(m.md().join('\n')).not.toContain('office—');
  });
});
