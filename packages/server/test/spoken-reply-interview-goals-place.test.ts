/**
 * Where what was said on a learning-goals doc belongs, without a doc: the
 * model's reply read back, the rule used when there is no model, and the
 * doc's goals read off an outline.
 */
import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import {
  goalsPrompt,
  parsePlacement,
  placeByRule,
  placeGoals,
} from '../src/spoken-reply/interview-goals-place.ts';
import { goalsShape } from '../src/spoken-reply/interview-goals.ts';

const HEARD = { name: '', goals: ['Ask for help after an hour.'], asked: null, heard: '' };

describe('parsePlacement', () => {
  it('keeps a name, new goals and in-range changes, and nothing else', () => {
    const raw = `Sure: {"name": " Saltmarsh ", "add": ["Stop at ten.", 3, ""], "change": [{"goal": 1, "text": "Ask after thirty minutes."}, {"goal": 4, "text": "x"}, {"goal": 1.5, "text": "y"}]}`;
    expect(parsePlacement(raw, 1)).toEqual({
      name: 'Saltmarsh',
      add: ['Stop at ten.'],
      change: [{ goal: 1, text: 'Ask after thirty minutes.' }],
    });
  });

  it('is null off-format', () => {
    expect(parsePlacement('no json here', 1)).toBeNull();
    expect(parsePlacement('{"name": ', 1)).toBeNull();
  });
});

describe('placeByRule', () => {
  it('reads "change the second one to …" as a revision of goal 2', () => {
    const two = {
      ...HEARD,
      goals: ['A.', 'B.'],
      heard: 'Actually, change the second one to ask Harborlight.',
    };
    expect(placeByRule(two)).toEqual({
      name: null,
      add: [],
      change: [{ goal: 2, text: 'Ask Harborlight.' }],
    });
  });

  it('a revision of a goal that does not exist is a new goal', () => {
    const r = placeByRule({ ...HEARD, heard: 'Change goal 5 to ask Harborlight.' });
    expect(r.change).toEqual([]);
    expect(r.add).toEqual(['Change goal 5 to ask Harborlight.']);
  });

  it('an answer to the name question is a name', () => {
    expect(placeByRule({ ...HEARD, asked: 'name', heard: 'Let’s call it Riverbend.' }).name).toBe(
      'Riverbend',
    );
  });
});

describe('placeGoals', () => {
  it('a model that throws falls back on the rule, keeping the words', async () => {
    const r = await placeGoals(
      async () => {
        throw new Error('down');
      },
      { ...HEARD, heard: 'Stop polishing slides at ten.' },
    );
    expect(r.add).toEqual(['Stop polishing slides at ten.']);
  });

  it('numbers the goals in the prompt', () => {
    expect(goalsPrompt({ ...HEARD, goals: ['A.', 'B.'] }).user).toContain('1. A.\n2. B.');
  });
});

describe('goalsShape', () => {
  const entry = (e: Partial<prose.OutlineEntry> & { id: string }): prose.OutlineEntry => ({
    kind: 'block',
    nodeName: 'paragraph',
    text: '',
    ...e,
  });

  it('counts top-level bullets under every goals heading, and no sub-bullet', () => {
    const shape = goalsShape([
      entry({ id: 'h1', kind: 'heading', level: 2, text: 'Goal 1' }),
      entry({ id: 'h2', kind: 'heading', level: 3, text: 'What I want to do better' }),
      entry({ id: 'g1', kind: 'listItem', depth: 0, text: 'A.', underHeadingId: 'h2' }),
      entry({ id: 's1', kind: 'listItem', depth: 1, text: 'detail', underHeadingId: 'h2' }),
      entry({ id: 'h3', kind: 'heading', level: 3, text: 'What’s behind it' }),
      entry({ id: 'x', text: 'not a goal', underHeadingId: 'h3' }),
      entry({ id: 'h4', kind: 'heading', level: 3, text: 'What I want to do better' }),
      entry({ id: 'g2', text: 'B.', underHeadingId: 'h4' }),
    ]);
    expect(shape?.goalsHeading.id).toBe('h2');
    expect(shape?.goals.map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  it('is null on a plan with no goals heading', () => {
    expect(goalsShape([entry({ id: 'h', kind: 'heading', level: 2, text: 'Goals' })])).toBeNull();
  });
});
