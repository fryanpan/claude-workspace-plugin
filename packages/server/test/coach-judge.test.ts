/**
 * What the coach asks and what it accepts back: the prompt carries his
 * goals with their "act differently when", today's moments with answers and
 * the last hour; a reply raises a moment only if it quotes the trigger of
 * the goal it names, and anything else is quiet.
 */
import { describe, expect, it } from 'bun:test';
import { readGoalsDoc } from '../src/coach/goals-doc.ts';
import { coachPrompt, coachSystem, parseCoachReply, quotesTrigger } from '../src/coach/judge.ts';
import { GOALS_DOC, ZONE, at } from './coach-fixtures.ts';

const goals = readGoalsDoc(GOALS_DOC).goals;

describe('the prompt', () => {
  it('speaks as the coach’s name and says quiet is the default', () => {
    const system = coachSystem('Saltmarsh');
    expect(system).toContain('You are Saltmarsh');
    expect(system).toContain('Your default is to stay quiet.');
  });

  it('carries the goals, today’s moments with his answers, and the last hour', () => {
    const user = coachPrompt({
      goals,
      today: [
        {
          id: 'cm-aaaaaaaaaaaa',
          at: at(10, 10),
          day: '2026-10-07',
          goalIndex: 0,
          goal: 'Do the hard work first',
          matched: 'more than twenty minutes on styling',
          observed: 'Half an hour on hover states',
          line: 'Hi, I’m noticing half an hour on hover states. Back to the post?',
          state: 'not-now',
        },
      ],
      now: 'Since 10:44 on "Board colour tokens": 6 min active.',
      where: ['09:41–10:31 "Button hover states mock": 49 min active'],
      did: [],
      at: at(10, 50),
      timeZone: ZONE,
    });
    expect(user).toContain('It is Wednesday, 10:50 his time.');
    expect(user).toContain(
      'Act differently when: I spend more than twenty minutes on styling or polish while the launch post is unfinished.',
    );
    expect(user).toContain(
      '10:10 about goal 1 ("Half an hour on hover states") — his answer: not now',
    );
    expect(user).toContain('Right now: Since 10:44 on "Board colour tokens"');
    expect(user).toContain('What he did in the last hour, one line per doc:\n(nothing)');
  });
});

describe('quotesTrigger', () => {
  it('wants a run of the trigger’s own words, at least three of them', () => {
    const t = goals[0]?.when ?? '';
    expect(quotesTrigger('more than twenty minutes on styling', t)).toBe(true);
    expect(quotesTrigger('More than twenty minutes, on styling!', t)).toBe(true);
    expect(quotesTrigger('on styling', t)).toBe(false);
    expect(quotesTrigger('twenty minutes styling', t)).toBe(false);
    expect(quotesTrigger('reads a message', t)).toBe(false);
  });
});

describe('parseCoachReply', () => {
  const moment = {
    verdict: 'moment',
    goal: 1,
    matched: 'more than twenty minutes on styling',
    observed: 'Half an hour on the button hover mock',
    line: 'Hi, I’m noticing half an hour on hover states while the post waits. Back to the post?',
  };

  it('takes quiet, and a moment that quotes its goal’s trigger, fenced or bare', () => {
    expect(parseCoachReply('{"verdict":"quiet"}', goals)).toEqual({ verdict: 'quiet' });
    expect(parseCoachReply(`\`\`\`json\n${JSON.stringify(moment)}\n\`\`\``, goals)).toEqual({
      verdict: 'moment',
      goalIndex: 0,
      matched: 'more than twenty minutes on styling',
      observed: 'Half an hour on the button hover mock',
      line: 'Hi, I’m noticing half an hour on hover states while the post waits. Back to the post?',
    });
  });

  it('is quiet for a quote of another goal’s trigger, or none', () => {
    expect(parseCoachReply(JSON.stringify({ ...moment, goal: 2 }), goals)).toBeNull();
    expect(
      parseCoachReply(JSON.stringify({ ...moment, matched: 'drifting off track' }), goals),
    ).toBeNull();
  });

  it('refuses prose, a goal not on the list, and a line that asks nothing', () => {
    expect(parseCoachReply(null, goals)).toBeNull();
    expect(parseCoachReply('You are drifting.', goals)).toBeNull();
    expect(parseCoachReply(JSON.stringify({ ...moment, goal: 3 }), goals)).toBeNull();
    expect(parseCoachReply(JSON.stringify({ ...moment, goal: 1.5 }), goals)).toBeNull();
    expect(
      parseCoachReply(JSON.stringify({ ...moment, line: 'Get back to the post now.' }), goals),
    ).toBeNull();
    expect(
      parseCoachReply(JSON.stringify({ ...moment, observed: 'x'.repeat(141) }), goals),
    ).toBeNull();
    expect(parseCoachReply('[{"verdict":"quiet"}]', goals)).toBeNull();
  });
});
