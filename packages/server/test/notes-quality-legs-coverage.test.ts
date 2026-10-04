/**
 * A MEETING THAT RAN IN TWO LEGS IS JUDGED ON BOTH LEGS' NOTES.
 *
 * The shape of the failure (2026-10-04): a meeting on a person's own doc
 * filed "100% of what was said reached no note" beside "0 of 74 notes landed
 * over a minute late". The two numbers read different records. Lateness reads
 * the meeting's timing file, which every leg appends to. Coverage read the
 * doc for blocks still carrying the note-taker's authorship mark, plus the
 * section the meeting opened — and every recording leg RELEASES every mark
 * when it starts (`releaseNotesAuthorship`). So after a reconnect, the notes
 * the first leg filed under the doc's own headings read as the person's, the
 * last leg's one heading was all the reading found, and every sentence of the
 * meeting counted as uncovered.
 *
 * All fixtures are synthetic and every name is a house fixture name. The repo
 * is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import { meetingDirPath, meetingTranscriptPath } from '../src/meetings.ts';
import { readNotesQuality } from '../src/notes-quality-store.ts';
import { readTickWaits } from '../src/notes-tick-timing.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

const DOC = 'd-harbour';
/** One id for both legs: that is what a resume is. */
const MEETING = 'm-1760000000042';

/** The person's own doc: two sections they wrote before anybody recorded. */
const OWN_DOC = [
  '# Harbour plan',
  '',
  '## Ferry timetable',
  '',
  'What I want settled before the season opens.',
  '',
  '## Slipway signage',
  '',
  'The boards we have are older than the slipway.',
  '',
].join('\n');

/** What the first leg heard, each sentence one idea, each noted in its words. */
const SAID = [
  'The Harborlight ferry leaves at six every weekday morning.',
  'Riverbend passengers change boats at the northern pontoon.',
  'Winter timetable drops the late crossing after October.',
  'Saltmarsh cyclists need racks on the lower deck.',
  'Ticket prices rise by fifty pence in April.',
  'The slipway boards need replacing before the regatta.',
  'New signage goes up beside the harbour office.',
  'Lettering stays white on dark blue paint.',
  'The harbour master approves every sign before printing.',
  'Printing quotes arrive from three local workshops.',
  'Volunteers repaint the bollards during the spring weekend.',
  'The council grant covers half the signage budget.',
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The meeting's transcript, as the relay writes it: one settled turn a line. */
function writeTranscript(dataDir: string, lines: readonly string[]): void {
  mkdirSync(meetingDirPath(dataDir, DOC), { recursive: true });
  writeFileSync(
    meetingTranscriptPath(dataDir, DOC, MEETING),
    lines.map((text, turn) => JSON.stringify({ turn, text, ts: 1_000 + turn })).join('\n') + '\n',
  );
}

/** The id of the doc's own heading that reads `text`. */
function headingId(
  outline: readonly { id: string; kind: string; text: string }[],
  text: string,
): string {
  const id = outline.find((e) => e.kind === 'heading' && e.text === text)?.id;
  if (id === undefined) throw new Error(`no heading ${text}`);
  return id;
}

describe('a meeting that dropped and resumed', () => {
  it('reads the first leg’s notes too, so its coverage is not 100% by construction', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-legs-coverage-'));
    dirs.push(dataDir);
    writeTranscript(dataDir, [...SAID, 'Right, thanks everyone.']);
    const ydoc = new Y.Doc();
    const heading = createNotesHeadingMemory();
    const shared = { ydoc, heading, docId: DOC, meetingId: MEETING, dataDir } as const;

    // LEG ONE: every note filed under the doc's OWN headings, which is what
    // whole-doc note-taking asks for on a prepared doc. No section opened.
    const first = createNotesTickHarness({
      ...shared,
      doc: OWN_DOC,
      compose: (input, tick) => {
        if (tick !== 1) return [];
        const ferry = headingId(input.outline, 'Ferry timetable');
        const slip = headingId(input.outline, 'Slipway signage');
        return [
          {
            op: 'insert_under_heading',
            headingId: ferry,
            markdown: SAID.slice(0, 5)
              .map((s) => `- ${s}`)
              .join('\n'),
          },
          {
            op: 'insert_under_heading',
            headingId: slip,
            markdown: SAID.slice(5)
              .map((s) => `- ${s}`)
              .join('\n'),
          },
        ];
      },
    });
    await first.speak(...SAID);
    await first.end();
    first.legEnded(true);

    // LEG TWO, after the reconnect: one closing remark, which the note-taker
    // files under a heading of its own.
    const second = createNotesTickHarness({
      ...shared,
      compose: (_input, tick) =>
        tick === 1 ? [{ op: 'insert_at_end', markdown: '## Wrap-up\n\n- Meeting closed' }] : [],
    });
    await second.speak('Right, thanks everyone.');
    await second.end();
    second.legEnded(false);

    // Both legs' writes are in the timing record the lateness reading uses.
    const waits = readTickWaits(dataDir, DOC, MEETING) ?? [];
    expect(waits.length).toBeGreaterThanOrEqual(2);

    const record = readNotesQuality(dataDir, DOC, MEETING);
    expect(record?.coverageSource).toBe('notes');
    expect(record?.ideas).toBe(SAID.length);
    // Every sentence the first leg heard is in the doc in its own words.
    expect(record?.uncoveredIdeas).toBe(0);
    expect(record?.flags ?? []).not.toContain('coverage');
  });
});
