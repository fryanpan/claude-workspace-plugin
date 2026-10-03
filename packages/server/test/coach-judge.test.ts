/**
 * What the coach reads and what it accepts back: the day folded per doc
 * from the activity file's tail, the prompt built from it, and a reply
 * refused unless it is exactly the verdict shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestActivity, digestLines, readJsonlTail } from '../src/coach/digest.ts';
import { coachPrompt, parseCoachReply } from '../src/coach/judge.ts';
import { DRIFTING_WEEK, GOALS, ZONE, at } from './coach-fixtures.ts';

describe('readJsonlTail', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coach-tail-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads only the tail, dropping the line the window cut and any that do not parse', () => {
    const path = join(dir, 'activity.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({ n: 1, pad: 'x'.repeat(40) })}\n{broken\n${JSON.stringify({ n: 2 })}\n`,
    );
    expect(readJsonlTail(path, 30)).toEqual([{ n: 2 }]);
    expect(readJsonlTail(path)).toEqual([{ n: 1, pad: 'x'.repeat(40) }, { n: 2 }]);
    expect(readJsonlTail(join(dir, 'absent.jsonl'))).toEqual([]);
  });
});

describe('the day as the prompt reads it', () => {
  const wednesday = () =>
    digestActivity(
      DRIFTING_WEEK.filter((r) => Date.parse(r.ts) < at(3, 0)),
      at(2, 0),
      (id) => (id === 'd-fonts' ? { board: 'Harborlight' } : {}),
    );

  it('folds the owner’s rows per doc: minutes read, edits, comments, the board', () => {
    const docs = wednesday();
    expect(docs.map((d) => d.title)).toEqual([
      'Harborlight launch post draft',
      'Board colour tokens',
      'Button hover states mock',
      'Font size experiments',
    ]);
    const lines = digestLines(docs, ZONE);
    expect(lines[0]).toBe('09:20–10:00 markdown "Harborlight launch post draft": read 60 min');
    expect(lines[2]).toContain('commented: "Try a softer shadow on hover, and a 2px lift."');
    expect(lines[3]).toBe(
      '15:20–17:20 mockup "Font size experiments" on board "Harborlight": read 140 min; edited (1×)',
    );
  });

  it('the prompt carries the goals in order, today’s nudges with answers, and the lines', () => {
    const user = coachPrompt({
      goals: GOALS,
      today: [
        {
          id: 'cn-aaaaaaaaaaaa',
          at: at(2, 12),
          day: '2026-10-07',
          goalIndex: 0,
          goal: GOALS[0] ?? '',
          drift: 'Colour tokens all morning',
          question: 'Still on the post?',
          state: 'plans-changed',
        },
      ],
      lines: digestLines(wednesday(), ZONE),
      now: at(2, 15),
      timeZone: ZONE,
    });
    expect(user).toContain('It is Wednesday 2026-10-07, 15:00 his time.');
    expect(user).toContain(
      '1. Publish the Harborlight launch post\n2. Ship the Riverbend booking flow',
    );
    expect(user).toContain(
      '12:00 about goal 1: "Colour tokens all morning" — his answer: plans changed',
    );
    expect(user).toContain('"Font size experiments"');
  });
});

describe('parseCoachReply', () => {
  const drift = {
    verdict: 'drift',
    goal: 2,
    drift: 'The afternoon went to font experiments',
    question: 'Is the booking flow still the plan for today?',
  };

  it('takes the two verdict shapes, fenced or bare', () => {
    expect(parseCoachReply('{"verdict":"on-track"}', 3)).toEqual({ verdict: 'on-track' });
    expect(parseCoachReply(`\`\`\`json\n${JSON.stringify(drift)}\n\`\`\``, 3)).toEqual({
      verdict: 'drift',
      goalIndex: 1,
      drift: 'The afternoon went to font experiments',
      question: 'Is the booking flow still the plan for today?',
    });
  });

  it('refuses prose, a goal that is not on the list, and a question that is not one', () => {
    expect(parseCoachReply(null, 3)).toBeNull();
    expect(parseCoachReply('You are drifting.', 3)).toBeNull();
    expect(parseCoachReply(JSON.stringify({ ...drift, goal: 4 }), 3)).toBeNull();
    expect(parseCoachReply(JSON.stringify({ ...drift, goal: 1.5 }), 3)).toBeNull();
    expect(
      parseCoachReply(JSON.stringify({ ...drift, question: 'Get back to work.' }), 3),
    ).toBeNull();
    expect(parseCoachReply(JSON.stringify({ ...drift, drift: 'x'.repeat(141) }), 3)).toBeNull();
    expect(parseCoachReply('[{"verdict":"on-track"}]', 3)).toBeNull();
  });
});
