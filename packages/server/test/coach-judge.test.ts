/**
 * What the server accepts from the coach session: a moment reaches a page
 * only if it quotes words of the goal it names and has the card's shape;
 * anything else is refused with a reason the session can act on.
 */
import { describe, expect, it } from 'bun:test';
import { readGoalsDoc } from '../src/coach/goals-doc.ts';
import { checkMoment, quotesGoal } from '../src/coach/judge.ts';
import { GOALS_DOC, SPOKEN_GOALS_DOC } from './coach-fixtures.ts';

const goals = readGoalsDoc(GOALS_DOC).goals;

describe('quotesGoal', () => {
  it('wants a run of the goal’s own words, at least three of them', () => {
    const t = goals[0]?.text ?? '';
    expect(quotesGoal('more than twenty minutes on styling', t)).toBe(true);
    expect(quotesGoal('More than twenty minutes, on styling!', t)).toBe(true);
    expect(quotesGoal('on styling', t)).toBe(false);
    expect(quotesGoal('twenty minutes styling', t)).toBe(false);
    expect(quotesGoal('reads a message', t)).toBe(false);
  });
});

describe('checkMoment', () => {
  const moment = {
    goal: 3,
    matched: 'I start on a solution before',
    observed: 'Designing the importer in a spec that never says why',
    line: 'Hi, I’m noticing the importer design came before any **why**. Who has the problem?',
  };

  it('takes a moment that quotes its goal’s trigger, cleaned for the card', () => {
    expect(checkMoment(moment, goals)).toEqual({
      goalIndex: 2,
      matched: 'I start on a solution before',
      observed: 'Designing the importer in a spec that never says why',
      line: 'Hi, I’m noticing the importer design came before any why. Who has the problem?',
    });
  });

  it('refuses a quote of another goal’s trigger, or none, and says so', () => {
    expect(checkMoment({ ...moment, goal: 1 }, goals)).toContain('goal 1');
    expect(checkMoment({ ...moment, matched: 'solution first' }, goals)).toContain(
      'goal 3’s own words',
    );
  });

  it('refuses a goal not on the list, missing text, and a line that asks nothing', () => {
    expect(checkMoment(null, goals)).toContain('goal is a number');
    expect(checkMoment({ ...moment, goal: 4 }, goals)).toContain('1 to 3');
    expect(checkMoment({ ...moment, goal: 1.5 }, goals)).toContain('goal is a number');
    expect(checkMoment({ ...moment, line: 7 }, goals)).toContain('are text');
    expect(checkMoment({ ...moment, line: 'Write the why before the design.' }, goals)).toContain(
      'ends with a question',
    );
    expect(checkMoment({ ...moment, observed: 'x'.repeat(141) }, goals)).toContain('observed');
  });
});

describe('a doc filled in by voice', () => {
  const spoken = readGoalsDoc(SPOKEN_GOALS_DOC).goals;
  const moment = {
    goal: 1,
    matched: 'more than about an hour on a mock',
    observed: 'An hour and ten minutes on the hover mock',
    line: 'Hi, I’m noticing over an hour on the hover mock. Is the Harborlight post done?',
  };

  it('takes a moment that quotes the trigger written in the goal itself', () => {
    expect(checkMoment(moment, spoken)).toMatchObject({ goalIndex: 0 });
  });

  it('refuses one that quotes nothing of any goal', () => {
    expect(checkMoment({ ...moment, matched: 'spent too long on the design' }, spoken)).toContain(
      'goal 1’s own words',
    );
    expect(
      checkMoment({ ...moment, goal: 2, matched: 'more than about an hour' }, spoken),
    ).toContain('goal 2’s own words');
  });
});
