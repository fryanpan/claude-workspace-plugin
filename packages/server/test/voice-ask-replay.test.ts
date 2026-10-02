/**
 * The sample-notes eval, replayed with no model call: the tidier's recorded
 * replies to sixteen labelled notes (`scripts/voice-ask-eval.ts --record`)
 * put through the rule the relay applies. A clear note must never be asked
 * about; the counts for the ambiguous ones are the recorded run's, so a
 * change to the rule that loses a question it used to ask shows here.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceTarget } from '@claude-workspaces/core';
import { askVerdictFor } from '../src/voice-feedback-question.ts';

const dir = join(import.meta.dir, '../../../scripts/fixtures/voice-ask');
const fixture = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')) as {
  targets: VoiceTarget[];
  notes: Array<{ id: string; words: string; pinned?: number; ask: boolean; about?: string }>;
};
const replies = JSON.parse(readFileSync(join(dir, 'replies.json'), 'utf8')) as Record<
  string,
  string
>;

const verdicts = fixture.notes.map((n) => ({
  note: n,
  v: askVerdictFor(
    {
      targets: fixture.targets,
      open: null,
      words: n.words,
      ...(n.pinned !== undefined ? { pinned: n.pinned } : {}),
    },
    replies[n.id] ?? '',
  ),
}));

describe('the recorded sample notes', () => {
  it('holds at least twelve notes, clear and ambiguous', () => {
    expect(fixture.notes.length).toBeGreaterThanOrEqual(12);
    expect(fixture.notes.filter((n) => n.ask).length).toBeGreaterThan(0);
    expect(fixture.notes.filter((n) => !n.ask).length).toBeGreaterThan(0);
  });

  it('asks about no clear note', () => {
    const asked = verdicts.filter(({ note, v }) => !note.ask && v.ask).map(({ note }) => note.id);
    expect(asked).toEqual([]);
  });

  it('asks about the ambiguous notes the recorded run asked about', () => {
    const asked = verdicts.filter(({ note, v }) => note.ask && v.ask).map(({ note }) => note.id);
    expect(asked).toEqual([
      'anchor-save',
      'anchor-chip',
      'anchor-card',
      'anchor-that-one',
      'meaning-pop',
    ]);
  });
});
