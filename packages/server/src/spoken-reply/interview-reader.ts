/**
 * The planning voice's one question, chosen by reading the plan.
 *
 * The gap list (`interview-gaps.ts`) finds only empty, TBD or thin sections
 * and lines ending in "?". A plan with real words in every section and a
 * decision still open has none of those, so the voice used to say nothing.
 * At a pause, this asks the model one thing: given the plan, the gaps, what
 * was just said and what was already asked, is there ONE question worth
 * asking now — and if so, under which heading does its answer go, and which
 * words of the plan is it about?
 *
 * One call per pause, made only when somebody has spoken since the last ask
 * (`interview.ts` decides that). The model's heading is matched back to the
 * outline, so the answer is written under a real heading and the cursor sits
 * on real words; a reply that names neither is no question at all.
 */
import type { prose } from '@claude-workspaces/core';
import { type PlanGap, gapLine } from './interview-gaps.ts';

export type PlanComplete = (args: { system: string; user: string }) => Promise<string>;

export interface PlanReading {
  outline: readonly prose.OutlineEntry[];
  gaps: readonly PlanGap[];
  /** What was said since the last question, as heard. */
  heard: string;
  /** Questions this socket already asked on the doc. */
  asked: readonly string[];
  /** The speaker asked whether there are any questions. */
  invited: boolean;
}

/** A question, or none and the one-sentence reason. */
export type ReadResult = { ask: PlanGap } | { none: string };

const PLAN_CHARS = 8_000;
const HEARD_CHARS = 2_000;

export const READER_SYSTEM = [
  'You listen while a person talks through a plan out loud.',
  'At a pause you may ask them ONE spoken question, or stay quiet.',
  'Ask rarely, and only when one of these is true:',
  '1. why the plan exists, or the outcome it is for, is unclear;',
  '2. who it is for, or the workflow it changes, is unclear;',
  '3. a decision the plan depends on is still unanswered.',
  'Otherwise stay quiet, even when something smaller is missing.',
  'Never ask about what the plan already settles, and never repeat a question already asked.',
  'The question is one plain sentence under 25 words.',
  'Reply with JSON only, one of:',
  '{"ask": "<question>", "heading": "<the exact heading its answer belongs under>", "quote": "<exact words from the plan it is about, or empty>"}',
  '{"ask": null, "why": "<one short sentence: why there is nothing to ask>"}',
].join('\n');

const INVITED =
  'They just asked whether you have any questions. Ask your best one if any is worth asking; otherwise say why not.';

/** The plan as the model reads it: headings marked, every block on a line. */
export function planText(outline: readonly prose.OutlineEntry[]): string {
  return outline
    .map((b) =>
      b.kind === 'heading'
        ? `${'#'.repeat(b.level ?? 1)} ${b.text}`
        : b.kind === 'listItem'
          ? `${'  '.repeat(b.depth ?? 0)}- ${b.text}`
          : b.text,
    )
    .join('\n')
    .slice(0, PLAN_CHARS);
}

export function readingPrompt(r: PlanReading): { system: string; user: string } {
  const list = (lines: readonly string[]) =>
    lines.length ? lines.map((l) => `- ${l}`).join('\n') : '(none)';
  return {
    system: r.invited ? `${READER_SYSTEM}\n${INVITED}` : READER_SYSTEM,
    user: [
      `PLAN:\n${planText(r.outline)}`,
      `GAPS THE OUTLINE SHOWS:\n${list(r.gaps.map(gapLine))}`,
      `ALREADY ASKED:\n${list(r.asked)}`,
      `JUST SAID:\n${r.heard.trim().slice(-HEARD_CHARS) || '(nothing)'}`,
    ].join('\n\n'),
  };
}

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `quote` as `text` spells it, or the whole of `text` when the spacing
 *  differs: the cursor needs words that are really there. */
function spelled(text: string, quote: string): string {
  const i = text.toLowerCase().indexOf(quote.toLowerCase());
  return i >= 0 ? text.slice(i, i + quote.length) : text;
}

/** The model's reply as a question placed in the outline, or null when it
 *  is not one this voice can ask. */
export function parseReading(
  raw: string,
  outline: readonly prose.OutlineEntry[],
): ReadResult | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  const ask = typeof m.ask === 'string' ? m.ask.replace(/\s+/g, ' ').trim() : '';
  if (!ask) return { none: typeof m.why === 'string' ? m.why.replace(/\s+/g, ' ').trim() : '' };
  const headings = outline.filter((b) => b.kind === 'heading' && b.text.trim());
  const want = typeof m.heading === 'string' ? flat(m.heading.replace(/^#+\s*/, '')) : '';
  const quote = typeof m.quote === 'string' ? m.quote.trim() : '';
  const quoted = quote ? outline.find((b) => flat(b.text).includes(flat(quote))) : undefined;
  const heading =
    headings.find((h) => flat(h.text) === want) ??
    (quoted?.kind === 'heading' ? quoted : headings.find((h) => h.id === quoted?.underHeadingId)) ??
    headings.find((h) => (h.level ?? 1) > 1) ??
    headings[0];
  if (!heading) return null;
  return {
    ask: {
      headingId: heading.id,
      heading: heading.text.trim(),
      kind: 'read',
      asks: ask,
      ...(quoted ? { asksId: quoted.id, quote: spelled(quoted.text, quote) } : {}),
      ordinal: headings.indexOf(heading),
      rank: 0,
    },
  };
}

/** One model call: the question worth asking now, or none. A model that
 *  fails or answers off-format asks nothing. */
export async function readPlan(complete: PlanComplete, r: PlanReading): Promise<ReadResult> {
  try {
    return parseReading(await complete(readingPrompt(r)), r.outline) ?? { none: '' };
  } catch {
    return { none: '' };
  }
}
