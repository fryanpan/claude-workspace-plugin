/**
 * Where a plan has gaps, and the one question that asks about each — the
 * reading half of interview mode (`interview.ts`).
 *
 * Read off the doc's outline, the same block list `read_doc_outline` hands an
 * agent, so a gap is named by its heading's block id and the answer can be
 * written back under that id through `applyBlockEdits`.
 *
 * A section is the blocks between a heading and the next heading of any
 * level. Four kinds of gap, by what the section holds:
 *
 *  - `empty`: nothing, and no deeper heading under it either (a parent whose
 *    words are all in its subsections is not a gap);
 *  - `placeholder`: only words like "TBD", "TODO" or "…";
 *  - `question`: an open question written into it — a line ending in "?",
 *    or one marked TBD, TODO or "open question". The question is asked as
 *    written;
 *  - `thin`: fewer than `THIN_WORDS` words.
 *
 * MOST IMPORTANT FIRST. A gap's rank is how much its heading matters to a
 * plan (requirements and design above risks, risks above an appendix), then
 * how empty it is, with the doc's own order breaking ties — so a thin
 * Requirements is asked before an empty Risks. No model: the outline is enough, and
 * this costs nothing per interview.
 *
 * A level-1 heading is the doc's title when deeper headings exist, so it is
 * never asked about then.
 */
import type { prose } from '@claude-workspaces/core';
import { capWords } from '../voice-status.ts';

/** `read`: not found here but chosen by reading the plan
 *  (`interview-reader.ts`); its question is the model's, asked as given. */
export type GapKind = 'empty' | 'placeholder' | 'question' | 'thin' | 'read';

export interface PlanGap {
  /** The section's heading block — where the answer is written. */
  headingId: string;
  heading: string;
  kind: GapKind;
  /** The open question as written, for `question` gaps. */
  asks?: string;
  /** The block holding that question. */
  asksId?: string;
  /** The words in that block the cursor sits on, when they are not
   *  `asks` itself (a `read` gap's question is not the plan's words). */
  quote?: string;
  /** The section's place among the doc's headings, from 0 — what the
   *  timing record names instead of the heading's words. */
  ordinal: number;
  rank: number;
}

/** A section with fewer words than this is thin. */
export const THIN_WORDS = 8;
/** Heading words a spoken question names. */
const HEADING_WORDS = 8;
/** Words of a written question said aloud. */
const QUESTION_WORDS = 28;

const PLACEHOLDER =
  /^(?:tbd|tbc|todo|tk|n\/?a|\.{2,}|…|-+|\?+|to be (?:decided|determined|written|confirmed)|fill (?:this )?in|coming soon)[.!:]*$/i;
const OPEN_MARK = /\b(?:tbd|todo|open question|to be decided|to be determined|undecided)\b/i;

/** Heading words that name what a plan is for, and what supports it. */
const CORE =
  /\b(?:goals?|requirements?|problem|scope|success|acceptance|criteria|users?|outcome|design|approach|solution|decisions?|why)\b/i;
const SUPPORT =
  /\b(?:risks?|open questions?|questions|dependenc(?:y|ies)|rollout|launch|test(?:ing)?|metrics?|measure|timeline|milestones?|plan|cost|security|alternatives?)\b/i;

const KIND_WEIGHT: Record<GapKind, number> = {
  empty: 3,
  placeholder: 3,
  question: 2,
  thin: 1,
  read: 0,
};

function words(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function headingWeight(heading: string): number {
  if (CORE.test(heading)) return 2;
  if (SUPPORT.test(heading)) return 1;
  return 0;
}

function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith('?') || OPEN_MARK.test(t);
}

/** The plan's sections, by heading, in the doc's order: every heading but
 *  the title (a level-1 heading above deeper ones). */
export function planHeadings(blocks: readonly prose.OutlineEntry[]): prose.OutlineEntry[] {
  const headings = blocks.filter((b) => b.kind === 'heading' && b.text.trim());
  const titled = headings.some((h) => (h.level ?? 1) > 1);
  return headings.filter((h) => !titled || (h.level ?? 1) > 1);
}

/** The gaps in `blocks`, most important first. */
export function findPlanGaps(blocks: readonly prose.OutlineEntry[]): PlanGap[] {
  const headings = blocks.filter((b) => b.kind === 'heading');
  const titled = headings.some((h) => (h.level ?? 1) > 1);
  const gaps: PlanGap[] = [];
  let ordinal = -1;
  for (let i = 0; i < blocks.length; i++) {
    const h = blocks[i];
    if (!h || h.kind !== 'heading') continue;
    ordinal++;
    const level = h.level ?? 1;
    if (titled && level === 1) continue;
    const heading = h.text.trim();
    if (!heading) continue;
    const body: prose.OutlineEntry[] = [];
    let next: prose.OutlineEntry | undefined;
    for (let j = i + 1; j < blocks.length; j++) {
      const b = blocks[j];
      if (!b) continue;
      if (b.kind === 'heading') {
        next = b;
        break;
      }
      body.push(b);
    }
    const said = body.filter((b) => b.text.trim().length > 0);
    let gap: Pick<PlanGap, 'kind' | 'asks' | 'asksId'> | null = null;
    if (said.length === 0) {
      // A parent heading whose words are all in its subsections.
      if (next && (next.level ?? 1) > level) continue;
      gap = { kind: 'empty' };
    } else if (said.every((b) => PLACEHOLDER.test(b.text.trim()))) {
      gap = { kind: 'placeholder' };
    } else {
      const q = said.find((b) => isQuestion(b.text));
      if (q) gap = { kind: 'question', asks: q.text.trim(), asksId: q.id };
      else if (words(said.map((b) => b.text).join(' ')) < THIN_WORDS) gap = { kind: 'thin' };
    }
    if (!gap) continue;
    gaps.push({
      headingId: h.id,
      heading,
      ordinal,
      rank: headingWeight(heading) * 3 + KIND_WEIGHT[gap.kind],
      ...gap,
    });
  }
  // Stable: equal ranks keep the doc's order.
  return gaps.sort((a, b) => b.rank - a.rank);
}

/** The heading as it is said: its words, capped. */
export function spokenHeading(gap: PlanGap): string {
  return capWords(gap.heading.replace(/[.:]+$/, ''), HEADING_WORDS);
}

/** The one question a gap is asked with. */
export function questionFor(gap: PlanGap): string {
  const h = spokenHeading(gap);
  switch (gap.kind) {
    case 'empty':
    case 'placeholder':
      return `What goes under ${h}?`;
    case 'thin':
      return `What else goes under ${h}?`;
    case 'question': {
      const asked = capWords(
        (gap.asks ?? '').replace(/^(?:open question|tbd|todo)\s*[:-]\s*/i, ''),
        QUESTION_WORDS,
      );
      return /\?$/.test(asked) ? `Under ${h}: ${asked}` : `Under ${h}, what about: ${asked}?`;
    }
    case 'read':
      return capWords(gap.asks ?? '', QUESTION_WORDS);
  }
}

/** A gap as the page lists it, written and never said. */
export function gapLine(gap: PlanGap): string {
  const what: Record<GapKind, string> = {
    empty: 'empty',
    placeholder: 'placeholder only',
    question: 'open question',
    thin: 'short',
    read: gap.asks ?? 'asked',
  };
  return `${gap.heading} — ${what[gap.kind]}`;
}
