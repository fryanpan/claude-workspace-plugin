/**
 * The planning voice, always on: with voice on in a plan nobody says
 * "interview me". The first pause asks the top open question, the agent's
 * cursor sits on the words it means in the doc's presence, and each answer
 * ends in one of three things — written in, a follow-up, or silence until
 * the next pause — each logged as `after-answer`.
 *
 * Over the four-gap plan of `interview-fixture.ts`, in a real `DocStore`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  AGENT_FOCUS_FIELD,
  type AgentFocus,
  parseAgentFocus,
} from '@claude-workspaces/core/spoken-reply';
import { DOC_ID, type Fixture, planFixture } from './interview-fixture.ts';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

/** The agent's cursor as every open view of the doc reads it. */
function focus(f: Fixture): AgentFocus | null {
  const state = f.docStore.get(DOC_ID)?.awareness.getLocalState() as Record<string, unknown> | null;
  return parseAgentFocus(state?.[AGENT_FOCUS_FIELD]);
}

function blockText(f: Fixture, id: string | undefined): string | undefined {
  return f.docStore.readOutline(DOC_ID)?.blocks.find((b) => b.id === id)?.text;
}

const GOALS = 'Cut the crossing to twenty minutes so commuters switch from the bridge.';

describe('voice on in a plan', () => {
  it('the first pause asks the top open question; what was said before is not written', async () => {
    fx = await planFixture();
    const said = 'So the ferry plan starts at Harborlight and then Riverbend in May.';
    const r = await fx.say(said);
    expect(r).toMatchObject({
      spoken: 'I found 4 gaps. First: What goes under Goals?',
      asking: true,
      route: 'interview',
    });
    expect(fx.headingOf(said)).toBeNull();
  });

  it('a silence on opening is a pause too', async () => {
    fx = await planFixture();
    expect((await fx.say('')).spoken).toBe('I found 4 gaps. First: What goes under Goals?');
  });

  it('a plan with nothing open says nothing and keeps listening', async () => {
    fx = await planFixture({
      markdown:
        '# Plan\n\n## Goals\n\nShip the second ferry crossing before the spring timetable starts.\n',
    });
    expect(await fx.say('The crossing is from Riverbend.')).toMatchObject({
      spoken: '',
      asking: true,
      points: [],
    });
    expect(fx.interview.active).toBe(false);
  });
});

describe("the agent's cursor", () => {
  it('sits on the heading it asks about, then on the open question as written', async () => {
    fx = await planFixture();
    await fx.say('');
    const first = focus(fx);
    expect(first).toMatchObject({ quote: 'Goals', name: 'Claude', color: '#2e7dd7' });
    expect(blockText(fx, first?.blockId)).toBe('Goals');

    await fx.say(GOALS);
    expect(focus(fx)).toMatchObject({ quote: 'Design' });
    await fx.say('A drive-through deck with ramps at both ends.');
    const q = focus(fx);
    expect(q?.quote).toBe('Who signs off the berth design?');
    expect(blockText(fx, q?.blockId)).toBe('Who signs off the berth design?');
    expect(q?.seq).toBeGreaterThan(first?.seq ?? Number.POSITIVE_INFINITY);
  });

  it('comes off the doc when the run ends and when the socket goes', async () => {
    fx = await planFixture();
    await fx.say('');
    await fx.say("that's enough");
    expect(focus(fx)).toBeNull();

    await fx.say('interview me');
    expect(focus(fx)).not.toBeNull();
    fx.answerer.close();
    expect(focus(fx)).toBeNull();
  });
});

describe('after an answer', () => {
  it('edit: a real answer is written under its heading and the next question asked', async () => {
    fx = await planFixture();
    await fx.say('');
    const r = await fx.say(GOALS);
    expect(r.spoken).toBe('Written under Goals. Next: What goes under Design?');
    expect(fx.headingOf(GOALS)).toBe('Goals');
    expect(fx.lines).toContain('[interview] doc=d-plan section=1 after-answer=edit');
  });

  it('follow-up: a bare answer is asked about once more and nothing is written', async () => {
    fx = await planFixture();
    await fx.say('');
    const r = await fx.say('Maybe.');
    expect(r).toMatchObject({
      spoken: 'Can you say more? What goes under Goals?',
      asking: true,
    });
    expect(fx.headingOf('Maybe.')).toBeNull();
    expect(fx.lines).toContain('[interview] doc=d-plan section=1 after-answer=follow-up');
    expect(focus(fx)).toMatchObject({ quote: 'Goals' });

    expect((await fx.say(GOALS)).spoken).toStartWith('Written under Goals.');
    expect(fx.headingOf(GOALS)).toBe('Goals');
  });

  it('quiet: "I don\'t know yet" gets silence, and the next question waits for the next pause', async () => {
    fx = await planFixture();
    await fx.say('');
    const r = await fx.say("Um, I don't know yet.");
    expect(r).toMatchObject({ spoken: '', asking: true, points: [] });
    expect(fx.headingOf("Um, I don't know yet.")).toBeNull();
    expect(fx.lines).toContain('[interview] doc=d-plan section=1 after-answer=quiet');
    expect(focus(fx)).toBeNull();

    // Whatever comes next, said or not, the next pause asks the next question.
    const talk = 'Riverbend wants the timetable out by March.';
    expect((await fx.say(talk)).spoken).toBe('What goes under Design?');
    expect(fx.headingOf(talk)).toBeNull();
    expect(focus(fx)).toMatchObject({ quote: 'Design' });
  });

  it('quiet: a second bare answer is not pressed for again', async () => {
    fx = await planFixture();
    await fx.say('');
    await fx.say('probably');
    expect(await fx.say('yes')).toMatchObject({ spoken: '', asking: true });
    expect(fx.lines.filter((l) => l.includes('after-answer'))).toEqual([
      '[interview] doc=d-plan section=1 after-answer=follow-up',
      '[interview] doc=d-plan section=1 after-answer=quiet',
    ]);
  });

  it('a question put back comes round again after the others', async () => {
    fx = await planFixture();
    await fx.say('');
    await fx.say('not sure');
    await fx.say('');
    await fx.say('A drive-through deck.');
    await fx.say('The harbour board.');
    expect((await fx.say('Weekdays first.')).spoken).toBe(
      'Written under Rollout. Next: What goes under Goals?',
    );
  });
});

describe('once it is over', () => {
  it('"that\'s enough" stops it for good: what is said next goes to the board', async () => {
    fx = await planFixture();
    await fx.say('');
    await fx.say("that's enough");
    expect((await fx.say('give me a status update')).route).toBe('fast-path');
    expect(fx.interview.active).toBe(false);
  });

  it('"interview me" starts it again by name', async () => {
    fx = await planFixture();
    await fx.say('');
    await fx.say("that's enough");
    expect((await fx.say('interview me')).spoken).toBe(
      'I found 4 gaps. First: What goes under Goals?',
    );
  });
});
