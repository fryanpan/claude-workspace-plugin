/**
 * Claude's minute in a planning meeting goes under the plan section it is
 * about, like any other note (Bryan, 3 Oct: "Next to the topic"). A plan has
 * no notes section: its note-taker edits the plan itself, so a minute sent to
 * the notes waited for a section that never opened and was dropped.
 *
 * WHICH SECTION, in order:
 *  1. the one the request or the minute names: every word of its heading
 *     appears in what was asked or minuted ("create tasks for the Riverbend
 *     risks" names Risks). Of several, the heading with the most words.
 *  2. else the section the meeting last talked about: the last one the
 *     planning voice wrote an answer under, or a minute was placed in.
 *  3. else the last section of the plan.
 * The doc's title is never one: a level-1 heading above deeper ones, the
 * rule the planning voice's gap list uses (`interview-gaps.ts`).
 *
 * THE WRITE is the planning voice's own (`InterviewDocs.writeUnder`): one
 * `insert_under_heading` at the end of the section, so the minute is a block
 * of its own and never merged into one already there.
 *
 * `place` answers false for a doc that is not a plan, or one it could not
 * write, and the caller writes the minute into the meeting's notes as before.
 */
import type { prose } from '@claude-workspaces/core';
import { planHeadings } from './interview-gaps.ts';
import type { InterviewDocs } from './interview.ts';

/** Words too common to tell one heading from another; every minute opens
 *  with "Claude:", so that name names no section. */
const COMMON = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'about', 'claude']);

/** A text's words, lowercased, with a plural's trailing "s" dropped. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !COMMON.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/** The section a minute goes under: named, else talked about, else the last. */
export function minuteHeading(
  outline: readonly prose.OutlineEntry[],
  said: string,
  talkedAbout?: string,
): prose.OutlineEntry | undefined {
  const headings = planHeadings(outline);
  const heard = new Set(wordsOf(said));
  let named: prose.OutlineEntry | undefined;
  let most = 0;
  for (const h of headings) {
    const words = wordsOf(h.text);
    if (words.length > most && words.every((w) => heard.has(w))) {
      named = h;
      most = words.length;
    }
  }
  return named ?? headings.find((h) => h.id === talkedAbout) ?? headings.at(-1);
}

export class PlanMinutes {
  /** Per doc, the heading of the section the meeting last talked about. */
  private readonly topic = new Map<string, string>();

  constructor(
    private readonly docs: Pick<InterviewDocs, 'outline' | 'writeUnder'>,
    private readonly isPlan: (docId: string) => boolean,
  ) {}

  /** Something was written under `headingId` on `docId`. */
  talkedAbout(docId: string, headingId: string): void {
    this.topic.set(docId, headingId);
  }

  /** Writes `markdown` under its section; false when the notes should have it. */
  place(docId: string, markdown: string, about = ''): boolean {
    if (!this.isPlan(docId)) return false;
    const outline = this.docs.outline(docId);
    const heading =
      outline && minuteHeading(outline, `${about}\n${markdown}`, this.topic.get(docId));
    if (!heading || this.docs.writeUnder(docId, heading.id, markdown) !== 'written') return false;
    this.topic.set(docId, heading.id);
    return true;
  }
}
