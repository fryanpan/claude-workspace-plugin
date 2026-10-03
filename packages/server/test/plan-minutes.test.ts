/**
 * Which plan section a planning meeting's minute goes under
 * (`spoken-reply/plan-minutes.ts`), and that every path writing a minute
 * places it the same way: a "Claude, …" answered at once, a lead's late
 * answer, and a Recall call's. Fixture names are the house ones.
 */
import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { MeetingClaude, type MeetingUtterance } from '../src/meeting-claude.ts';
import { type SpokenAnswerer, shapedAnswer } from '../src/spoken-reply/answer.ts';
import type { InterviewWrite } from '../src/spoken-reply/interview.ts';
import { LeadAnswers } from '../src/spoken-reply/lead-answer.ts';
import { MeetingErrands } from '../src/spoken-reply/meeting-errands.ts';
import { PlanMinutes, minuteHeading } from '../src/spoken-reply/plan-minutes.ts';

const OWNER = 'riverbend@example.test';

function entry(id: string, text: string, level?: number): prose.OutlineEntry {
  return level === undefined
    ? { id, kind: 'paragraph', nodeName: 'paragraph', text }
    : { id, kind: 'heading', nodeName: 'heading', text, level };
}

const OUTLINE = [
  entry('h-title', 'Harborlight launch', 1),
  entry('h-goals', 'Goals', 2),
  entry('p-1', 'Open the Saltmarsh berth in spring.'),
  entry('h-risks', 'Risks', 2),
  entry('p-2', 'The Riverbend channel silts up.'),
  entry('h-open', 'Open questions', 2),
  entry('p-3', 'Who runs the ticket office?'),
];

describe('the section a minute goes under', () => {
  it('is the one the request names, a plural matching its singular', () => {
    expect(minuteHeading(OUTLINE, 'create tasks for the Riverbend risks')?.id).toBe('h-risks');
    expect(minuteHeading(OUTLINE, 'Claude: one risk is the tide')?.id).toBe('h-risks');
    expect(minuteHeading(OUTLINE, 'list the open questions')?.id).toBe('h-open');
  });

  it('needs every word of a heading, and takes the most specific of several', () => {
    // "questions" alone is not "Open questions".
    expect(minuteHeading(OUTLINE, 'any questions?', 'h-goals')?.id).toBe('h-goals');
    expect(minuteHeading(OUTLINE, 'the goals and the open questions')?.id).toBe('h-open');
  });

  it('never the title, even when the request says its words', () => {
    expect(minuteHeading(OUTLINE, 'the Harborlight launch date', 'h-goals')?.id).toBe('h-goals');
  });

  it('else the section last talked about, else the last section', () => {
    expect(minuteHeading(OUTLINE, 'book the ferry', 'h-goals')?.id).toBe('h-goals');
    expect(minuteHeading(OUTLINE, 'book the ferry', 'h-gone')?.id).toBe('h-open');
    expect(minuteHeading(OUTLINE, 'book the ferry')?.id).toBe('h-open');
    expect(minuteHeading([], 'book the ferry')).toBeUndefined();
  });
});

/** A plan doc that records each write. */
function planDocs(plans: Set<string>) {
  const writes: Array<{ docId: string; headingId: string; markdown: string }> = [];
  const minutes = new PlanMinutes(
    {
      outline: (docId) => (plans.has(docId) ? OUTLINE : null),
      writeUnder: (docId, headingId, markdown): InterviewWrite => {
        writes.push({ docId, headingId, markdown });
        return 'written';
      },
    },
    (docId) => plans.has(docId),
  );
  return { minutes, writes };
}

describe('PlanMinutes', () => {
  it('writes into a plan only; any other doc is left to its notes', () => {
    const { minutes, writes } = planDocs(new Set(['d-plan']));
    expect(minutes.place('d-talk', '- Claude: Decided: ferry on Friday', 'book the ferry')).toBe(
      false,
    );
    expect(writes).toEqual([]);
    expect(minutes.place('d-plan', '- Claude: Tasks created: Dredge', 'the Riverbend risks')).toBe(
      true,
    );
    expect(writes).toEqual([
      { docId: 'd-plan', headingId: 'h-risks', markdown: '- Claude: Tasks created: Dredge' },
    ]);
  });

  it('remembers what was talked about: the planning voice’s write, then its own', () => {
    const { minutes, writes } = planDocs(new Set(['d-plan']));
    minutes.talkedAbout('d-plan', 'h-goals');
    minutes.place('d-plan', '- Claude: Decided: ferry on Friday', 'book the ferry');
    minutes.place('d-plan', '- Claude: Tasks created: Dredge', 'the risks');
    minutes.place('d-plan', '- Claude: Decided: signs from Saltmarsh Print', 'order signs');
    expect(writes.map((w) => w.headingId)).toEqual(['h-goals', 'h-risks', 'h-risks']);
  });
});

describe('a lead’s late answer carries what was asked', () => {
  it('so its minute is placed by the request', () => {
    const errands = new MeetingErrands();
    errands.started('q-1', 'create tasks for the Riverbend risks');
    const done = errands.answered('q-1', {
      ...shapedAnswer('Done.', 'lead-answer'),
      minute: 'Tasks created: Dredge',
    });
    expect(done).toEqual({
      note: '- Claude: Tasks created: Dredge',
      about: 'create tasks for the Riverbend risks',
      label: null,
    });
  });
});

describe('a Recall call in a planning meeting', () => {
  function call(answers: () => SpokenAnswerer, leads?: LeadAnswers) {
    const { minutes, writes } = planDocs(new Set(['d-plan']));
    const claude = new MeetingClaude({
      ownerEmail: OWNER,
      answererFor: answers,
      actor: () => ({ id: 'o', name: 'Riverbend' }),
      voice: null,
      play: async () => {},
      planMinute: (docId, markdown, about) => minutes.place(docId, markdown, about),
      ...(leads ? { lead: { answers: leads, boardOf: () => 'w-1' } } : {}),
    });
    const notes: string[] = [];
    const heard = (docId: string, text: string): MeetingUtterance => ({
      docId,
      botId: 'bot_1',
      speaker: { name: 'Riverbend', email: OWNER },
      text,
      note: (m) => notes.push(m),
    });
    return { claude, writes, notes, heard };
  }

  it('places an answer’s minute under the section the request names', async () => {
    const answerer = {
      ask: async () => shapedAnswer('Moved "Dredge" from todo to done.', 'fast-path-action'),
    } as unknown as SpokenAnswerer;
    const c = call(() => answerer);
    await c.claude.heard(c.heard('d-plan', 'Claude, mark the Riverbend risks work done.'));
    expect(c.writes.map((w) => [w.headingId, w.markdown])).toEqual([
      ['h-risks', '- Claude: “Dredge”: todo → done'],
    ]);
    expect(c.notes).toEqual([]);
  });

  it('places the lead’s minute the same way, and a discussion keeps its notes', async () => {
    const leads = new LeadAnswers();
    const answerer = {
      ask: async () => ({ ...shapedAnswer('On it.', 'agent'), awaiting: 'q-1' }),
    } as unknown as SpokenAnswerer;
    const c = call(() => answerer, leads);
    await c.claude.heard(c.heard('d-plan', 'Claude, create tasks for the open questions.'));
    expect(leads.answer('w-1', 'q-1', 'Done.', 'Tasks created: Name the office')).toBe(true);
    expect(c.writes.map((w) => [w.headingId, w.markdown])).toEqual([
      ['h-open', '- Claude: Tasks created: Name the office'],
    ]);

    const fast = {
      ask: async () => shapedAnswer('Moved "Dredge" from todo to done.', 'fast-path-action'),
    } as unknown as SpokenAnswerer;
    const discussion = call(() => fast);
    await discussion.claude.heard(discussion.heard('d-talk', 'Claude, mark the risks done.'));
    expect(discussion.writes).toEqual([]);
    expect(discussion.notes).toEqual(['- Claude: “Dredge”: todo → done']);
  });
});
