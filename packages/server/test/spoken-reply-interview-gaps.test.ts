/**
 * Which sections of a plan are gaps, in what order they are asked, and the
 * question each is asked with — over hand-built outlines, so each rule is
 * one row. Also the timing file the interview writes.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { prose } from '@claude-workspaces/core';
import { findPlanGaps, questionFor } from '../src/spoken-reply/interview-gaps.ts';
import { INTERVIEW_TIMINGS_FILE, InterviewLog } from '../src/spoken-reply/interview-log.ts';
import { answerMarkdown } from '../src/spoken-reply/interview-phrases.ts';

let n = 0;
function h(text: string, level = 2): prose.OutlineEntry {
  return { id: `h${n++}`, kind: 'heading', nodeName: 'heading', level, text };
}
function p(text: string): prose.OutlineEntry {
  return { id: `b${n++}`, kind: 'block', nodeName: 'paragraph', text };
}

const LONG = 'The ferry runs every twenty minutes from Riverbend in the morning peak.';

describe('findPlanGaps', () => {
  it('names each kind of gap and leaves full sections alone', () => {
    const gaps = findPlanGaps([
      h('Harborlight plan', 1),
      p('An introduction under the title is never asked about.'),
      h('Background'),
      p(LONG),
      h('Notes'),
      h('Budget'),
      p('…'),
      h('Owners'),
      p(LONG),
      p('Who runs the night sailings?'),
      h('Timeline'),
      p('Spring.'),
    ]);
    expect(gaps.map((g) => [g.heading, g.kind])).toEqual([
      // A timeline supports a plan, so even short it outranks the gaps
      // under headings that name nothing.
      ['Timeline', 'thin'],
      ['Notes', 'empty'],
      ['Budget', 'placeholder'],
      ['Owners', 'question'],
    ]);
    expect(gaps.find((g) => g.kind === 'question')?.asks).toBe('Who runs the night sailings?');
  });

  it('a heading whose words are all in its subsections is not a gap', () => {
    const gaps = findPlanGaps([h('Design'), h('Deck', 3), p(LONG), h('Ramps', 3)]);
    expect(gaps.map((g) => g.heading)).toEqual(['Ramps']);
  });

  it('a doc of level-1 headings only asks about them', () => {
    expect(findPlanGaps([h('Goals', 1), h('Risks', 1), p(LONG)]).map((g) => g.heading)).toEqual([
      'Goals',
    ]);
  });

  it('ranks what a plan is for above what supports it, then by emptiness, then doc order', () => {
    const gaps = findPlanGaps([
      h('Appendix'),
      h('Risks'),
      h('Requirements'),
      p('Spring.'),
      h('Goals'),
      h('Glossary'),
    ]);
    expect(gaps.map((g) => g.heading)).toEqual([
      'Goals', // core, empty
      'Requirements', // core, thin
      'Risks', // support, empty
      'Appendix', // neither, empty — before Glossary by doc order
      'Glossary',
    ]);
  });
});

describe('questionFor', () => {
  it('asks a written question as written, and marks TBD lines as questions', () => {
    const [q, tbd] = findPlanGaps([
      h('Owners'),
      p(LONG),
      p('Who runs the night sailings?'),
      h('Pricing'),
      p(LONG),
      p('TBD: the off-peak fare'),
    ]);
    expect(q && questionFor(q)).toBe('Under Owners: Who runs the night sailings?');
    expect(tbd && questionFor(tbd)).toBe('Under Pricing, what about: the off-peak fare?');
  });
});

describe('answerMarkdown', () => {
  it('keeps a spoken answer one paragraph', () => {
    expect(answerMarkdown('  - two\n ramps  ')).toBe('\\- two ramps');
    expect(answerMarkdown('# of cars is twelve')).toBe('\\# of cars is twelve');
    expect(answerMarkdown('1. weekdays')).toBe('\\1. weekdays');
  });
});

describe('InterviewLog', () => {
  it('appends one JSON row per record to the timings file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cw-ivlog-')), INTERVIEW_TIMINGS_FILE);
    const lines: string[] = [];
    const log = new InterviewLog(file, (l) => lines.push(l));
    log.record({
      type: 'gap',
      interview: 'iv-1',
      docId: 'd-1',
      section: 2,
      kind: 'empty',
      outcome: 'filled',
      ms: 42_000,
      words: 9,
      at: 5,
    });
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([expect.objectContaining({ section: 2, outcome: 'filled', ms: 42_000 })]);
    expect(lines).toEqual([
      '[interview] doc=d-1 section=2 kind=empty outcome=filled ms=42000 words=9',
    ]);
  });
});
