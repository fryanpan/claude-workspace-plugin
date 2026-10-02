/**
 * What voice says back, over the whole router corpus (Bryan, 2026-10-02:
 * the replies were too long, and "sent to the lead agent" described the
 * plumbing instead of the answer).
 *
 *  - a quick action's spoken ack is six words or fewer;
 *  - so is the ack for a request handed to the lead;
 *  - no spoken reply names how it was routed.
 *
 * Every case runs through the real router over the eval fixture, with a
 * classifier that names the case's expected outcome, so the words checked are
 * the ones a right classification produces. No model is called.
 */
import { describe, expect, it } from 'bun:test';
import {
  ROUTER_CORPUS,
  type RouterCase,
  isQuickCase,
} from '../../../scripts/voice-router-corpus.ts';
import { BOARDS, DOCS, GOALS, TASKS } from '../../../scripts/voice-router-fixture.ts';
import { runCase, scored } from '../../../scripts/voice-router-run.ts';
import { shapeReply } from '../src/spoken-reply/reply-shape.ts';
import {
  AGENT_ACK,
  FEEDBACK_ASK,
  FEEDBACK_SAVED_ACK,
  HELP_SPOKEN,
  QUEUED_ACK,
  QUICK_ACK_MAX_WORDS,
  START_ACK,
  quickAckFits,
} from '../src/voice-quick.ts';

/** Words that describe the routing rather than the result. */
const ROUTING_WORDS =
  /\b(?:agents?|lead|queued?|sent|send(?:ing)?|rout(?:e|ed|ing)|fast path|classif\w*|model|forward(?:ed)?|handed|hand(?:ing)? (?:it|this) (?:off|over))\b/i;

const spokenOf = (ack: string): string => shapeReply(ack).spoken;

/** The fixture's own names, which may hold one of those words ("Harborlight
 *  Team Lead" is a board) and are what was asked for, not narration. */
const NAMES = [
  ...Object.values(BOARDS),
  ...Object.values(DOCS),
  ...Object.values(GOALS),
  ...Object.values(TASKS).map((t) => t.title),
].sort((a, b) => b.length - a.length);
const withoutNames = (spoken: string): string =>
  NAMES.reduce((s, name) => s.split(name).join('·'), spoken);

const runs = Promise.all(
  ROUTER_CORPUS.map(async (c: RouterCase) => ({ c, run: await runCase(c, 'oracle') })),
);

describe('spoken replies over the router corpus', () => {
  it('a right classification of every quick action does it, in six words or fewer', async () => {
    const quick = (await runs).filter(({ c }) => isQuickCase(c));
    expect(quick.length).toBeGreaterThanOrEqual(30);
    const wrong = quick.filter(({ c, run }) => !scored(c, run.observed)).map(({ c }) => c.said);
    expect(wrong).toEqual([]);
    const long = quick
      .map(({ c, run }) => ({ said: c.said, spoken: spokenOf(run.ack) }))
      .filter(({ spoken }) => !quickAckFits(spoken));
    expect(long).toEqual([]);
  });

  it('a request for the lead is acked in six words or fewer', async () => {
    const agent = (await runs).filter(({ run }) => run.path === 'agent');
    expect(agent.length).toBeGreaterThanOrEqual(10);
    for (const { c, run } of agent) {
      expect(quickAckFits(spokenOf(run.ack)), `${c.said} → ${spokenOf(run.ack)}`).toBe(true);
    }
  });

  it('nor do the fixed acks, including the live lead’s, which the fixture board has none of', () => {
    const acks = [
      AGENT_ACK,
      QUEUED_ACK,
      HELP_SPOKEN,
      FEEDBACK_ASK,
      FEEDBACK_SAVED_ACK,
      ...Object.values(START_ACK),
    ];
    for (const ack of acks) {
      expect(quickAckFits(ack), ack).toBe(true);
      expect(ROUTING_WORDS.test(ack), ack).toBe(false);
    }
  });

  it('no spoken reply names how it was routed', async () => {
    const narrating = (await runs)
      .map(({ c, run }) => ({ said: c.said, spoken: spokenOf(run.ack) }))
      .filter(({ spoken }) => ROUTING_WORDS.test(withoutNames(spoken)));
    expect(narrating).toEqual([]);
  });

  it('POSITIVE CONTROL: the checks fire on the replies they replaced', () => {
    expect(
      ROUTING_WORDS.test(spokenOf('Heard: "x". Nothing here matched — sent to the lead agent.')),
    ).toBe(true);
    expect(ROUTING_WORDS.test('Queued for the agent.')).toBe(true);
    expect(ROUTING_WORDS.test(withoutNames('Opening Harborlight Team Lead.'))).toBe(false);
    expect(quickAckFits('Opening the Harborlight winter berth allocation plan.')).toBe(false);
    expect(QUICK_ACK_MAX_WORDS).toBe(6);
  });
});
