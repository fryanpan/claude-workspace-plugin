/**
 * The learning-goals doc as the coach reads it: an empty template has no
 * name and no goals; each bullet or paragraph under "What I want to do
 * better" is one goal, numbered in doc order; and the older four-part
 * layout still reads, its "Act differently when" folded into the goal.
 */
import { describe, expect, it } from 'bun:test';
import { goalTitle, goalsDocTemplate, nameFrom, readGoalsDoc } from '../src/coach/goals-doc.ts';
import { findPlanGaps } from '../src/spoken-reply/interview-gaps.ts';
import { GOALS_DOC, ONE_SECTION_GOALS_DOC, SPOKEN_GOALS_DOC } from './coach-fixtures.ts';

/** The outline the interview reads, built from markdown headings and lines. */
function outline(md: string) {
  return md
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      const h = l.match(/^(#+)\s+(.*)$/);
      return h
        ? {
            id: `b${i}`,
            kind: 'heading' as const,
            nodeName: 'heading',
            level: h[1]?.length,
            text: h[2] ?? '',
          }
        : { id: `b${i}`, kind: 'block' as const, nodeName: 'paragraph', text: l };
    });
}

describe('the template', () => {
  it('reads as no name and no goals yet', () => {
    expect(readGoalsDoc(goalsDocTemplate())).toEqual({ goals: [] });
  });

  it('asks for the coach’s name, then one section of goals', () => {
    const gaps = findPlanGaps(outline(goalsDocTemplate()) as never);
    expect(gaps.map((g) => g.heading)).toEqual(['Your coach’s name', 'What I want to do better']);
  });

  it('reads the goals once he writes them under its one section', () => {
    const md = `${goalsDocTemplate()}\n- If I polish for an hour, ask me why.\n- Reply to Bob the same day.\n`;
    expect(readGoalsDoc(md).goals.map(goalTitle)).toEqual([
      'If I polish for an hour, ask me why.',
      'Reply to Bob the same day.',
    ]);
  });
});

describe('a doc filled in by voice', () => {
  it('reads both bullets under Goal 1 as two goals, the empty parts as nothing', () => {
    const r = readGoalsDoc(SPOKEN_GOALS_DOC);
    expect(r.name).toBe('Riverbend');
    expect(r.goals.map((g) => g.text)).toEqual([
      'If I spend more than about an hour on a mock, ask me whether the Harborlight post is done.',
      'When I leave a Saltmarsh message unanswered at the end of the day, ask me to reply first.',
    ]);
  });
});

describe('the one-section layout', () => {
  it('takes each top-level bullet with its sub-bullets, and each paragraph, as one goal', () => {
    const r = readGoalsDoc(ONE_SECTION_GOALS_DOC);
    expect(r.name).toBe('Saltmarsh');
    expect(r.goals.map((g) => g.text)).toEqual([
      'If I polish styles while the Harborlight post is unfinished, ask me why.\nTwenty minutes is enough.',
      'When Alice waits on me, ask me to answer the same day.',
      'If I start a design before writing down why it matters, ask me who has the problem.',
    ]);
    expect(goalTitle(r.goals[0] as never)).toBe(
      'If I polish styles while the Harborlight post is unfinished, ask me why.',
    );
  });

  it('joins a paragraph’s wrapped lines and splits paragraphs on a blank line', () => {
    const md = '## What I want to do better\n\nFirst goal,\nwrapped.\n\nSecond goal.\n';
    expect(readGoalsDoc(md).goals.map((g) => g.text)).toEqual([
      'First goal,\nwrapped.',
      'Second goal.',
    ]);
  });
});

describe('the four-part layout', () => {
  it('reads one goal per section, its trigger part of the goal’s text', () => {
    const r = readGoalsDoc(GOALS_DOC);
    expect(r.name).toBe('Saltmarsh');
    expect(r.goals).toHaveLength(3);
    expect(goalTitle(r.goals[0] as never)).toBe(
      'Do the hard, important work before the easy polish.',
    );
    expect(r.goals[1]?.text).toBe(
      'Answer people who are waiting on me the same day.\nI read a message from someone waiting on me and move on without replying.',
    );
  });

  it('reads a section with only a trigger, and skips one with nothing in it', () => {
    const md = `${GOALS_DOC}\n## Goal 4\n\n### What I want to do better\n\n### Act differently when\n\nI open a third tab of the same mock.\n\n## Goal 5\n\n### How\n\nBreathe.\n`;
    const r = readGoalsDoc(md);
    expect(r.goals).toHaveLength(4);
    expect(r.goals[3]?.text).toBe('I open a third tab of the same mock.');
  });

  it('takes the name out of what he said', () => {
    expect(nameFrom('Let’s call it Saltmarsh.')).toBe('Saltmarsh');
    expect(nameFrom('Riverbend')).toBe('Riverbend');
    expect(nameFrom('I think it should be "Harborlight"!')).toBe('Harborlight');
    expect(nameFrom('')).toBeUndefined();
  });
});
