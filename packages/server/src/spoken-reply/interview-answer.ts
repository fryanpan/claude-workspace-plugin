/**
 * What, of the words heard after the planning voice's question, answers it.
 *
 * In a planning meeting the person answering is also talking to the room and
 * about the tool: "oh, that was really disruptive", "having that panel open
 * is unnecessary", a sentence started and dropped. Bryan's first planning
 * meeting wrote all 67 words after a question into the plan, remarks about
 * the tool included. Only the answer belongs in the plan; the rest reaches
 * the meeting notes like any other words (`meeting-ears.ts`).
 *
 * Two passes. A false start, a clause broken off on a dash or an ellipsis
 * before a new sentence begins, is dropped without asking. Then, when the
 * server has a model, one call names which of the remaining sentences answer
 * the question, by number, so what is written is always the speaker's own
 * words and never a paraphrase. None of them: nothing is written. A model
 * that fails or answers off-format keeps every sentence but the false starts.
 */
import type { PlanComplete } from './interview-reader.ts';

export interface Clause {
  text: string;
  /** Broken off before the next clause began: a false start. */
  cut: boolean;
}

/** A sentence's end, or a dash or ellipsis breaking off before a capital. */
const BREAK = /(?:[.!?]+["'’”)\]]*|\.\.\.|…)(?=\s|$)|(?:—|–|\s--?)(?=\s+\p{Lu})/gu;
const BROKEN = /(?:\.\.\.|…|—|–|-)$/;

/** `text` as clauses, in order. A clause is cut only when another follows it. */
export function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  let last = 0;
  for (const m of text.matchAll(BREAK)) {
    const end = (m.index ?? 0) + m[0].length;
    const piece = text.slice(last, end).trim();
    if (piece) out.push({ text: piece, cut: BROKEN.test(piece) });
    last = end;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ text: rest, cut: false });
  const tail = out.at(-1);
  if (tail) tail.cut = false;
  return out;
}

export const JUDGE_SYSTEM = [
  'A person is answering a question about their plan out loud, in a meeting.',
  'Some of what they said answers the question. Some may not: a remark about the tool, the voice,',
  'the screen or the meeting itself, an aside to someone else, or talk about something else.',
  'Reply with JSON only: {"answer": [<the numbers of the sentences that answer the question>]},',
  'or {"answer": []} when none of them does.',
].join('\n');

export function judgePrompt(
  question: string,
  said: readonly string[],
): { system: string; user: string } {
  return {
    system: JUDGE_SYSTEM,
    user: `QUESTION: ${question}\n\nSAID:\n${said.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
  };
}

/** The model's picks as indexes into `n` sentences, or null off-format. */
export function parseJudge(raw: string, n: number): number[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const answer = (parsed as { answer?: unknown } | null)?.answer;
  if (!Array.isArray(answer)) return null;
  const picked = answer.filter(
    (x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= n,
  );
  return [...new Set(picked)].sort((a, b) => a - b).map((x) => x - 1);
}

/** The words of `heard` that answer `question`, or '' when none do. */
export async function answerPart(
  complete: PlanComplete | undefined,
  question: string,
  heard: string,
): Promise<string> {
  const kept = clauses(heard)
    .filter((c) => !c.cut)
    .map((c) => c.text);
  if (kept.length === 0 || !complete) return kept.join(' ');
  try {
    const picks = parseJudge(await complete(judgePrompt(question, kept)), kept.length);
    if (picks) return picks.map((i) => kept[i]).join(' ');
  } catch {
    // A model that fails loses the check, not the answer.
  }
  return kept.join(' ');
}
