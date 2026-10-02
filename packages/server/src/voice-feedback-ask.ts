/**
 * The one clarifying question a voice note may get, and its answer.
 *
 * A note is asked about only when the server cannot tell which element it is
 * about ("this one", with two Save buttons on the page) or what it asks for
 * ("make it pop": bolder, or bigger?). Everything else lands as said, because
 * a question costs the speaker a turn and a note that is nearly right costs
 * them nothing until they read it.
 *
 * Two halves decide it. The tidy call (`voice-feedback-tidy.ts`) already
 * reads the words against the catalog, so it proposes a question when it sees
 * two equal readings. This file is the cheap rule over that proposal: it
 * drops a question the person already answered by pointing (a tapped or moved
 * note), a second question on one note, an element question whose words named
 * the element plainly, and anything too long to say in a breath. The model
 * proposes; the rule decides.
 *
 * The answer edits the same note — its element, or its words — and never
 * starts another (`voice-feedback-relay.ts`). A short answer said aloud ("the
 * second one", "the footer") is matched here without a model call; any other
 * goes to the next tidy call with the question beside it.
 */
import type { VoiceTarget } from '@claude-workspaces/core';

/** As `normWord` in the tidier, which imports this file. */
const normWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

export interface AskChoice {
  label: string;
  /** An element question: the catalog index this choice names. */
  element?: number;
  /** A meaning question: the whole note, rewritten for this reading. */
  text?: string;
}

export interface AskProposal {
  question: string;
  choices: AskChoice[];
}

export interface PendingAsk {
  key: string;
  question: string;
  choices: AskChoice[];
  about: 'anchor' | 'meaning';
}

/** Longest question said aloud, in words. The board's spoken reply caps a
 *  whole answer at forty; a question is one breath. */
export const ASK_MAX_WORDS = 12;
const MAX_LABEL = 40;
const MAX_TEXT = 600;
/** The longest spoken answer matched without a model call. */
const SHORT_ANSWER_WORDS = 8;

/** Words that point at something without naming it. */
const VAGUE = /\b(this|that|these|those|it|here|there|one|thing|ones)\b/i;

/** A proposal off the model's reply, or null for anything that is not one. */
export function readAskProposal(raw: unknown, known: ReadonlySet<number>): AskProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.question !== 'string' || !Array.isArray(m.choices)) return null;
  const choices: AskChoice[] = [];
  for (const c of m.choices) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (typeof r.label !== 'string' || !r.label.trim()) continue;
    const id = typeof r.element === 'string' ? /^e(\d+)$/.exec(r.element)?.[1] : undefined;
    const element = id !== undefined && known.has(Number(id)) ? Number(id) : undefined;
    const text = typeof r.text === 'string' && r.text.trim() ? r.text.trim() : undefined;
    choices.push({
      label: r.label.trim(),
      ...(element !== undefined ? { element } : {}),
      ...(text ? { text } : {}),
    });
  }
  return { question: m.question.trim(), choices };
}

export interface AskContext {
  key: string;
  /** The note was placed by the person — tapped, pinned or moved. */
  fixed: boolean;
  /** It was asked about already. */
  asked: boolean;
  /** The words said for it. */
  words: string;
  targets: readonly VoiceTarget[];
}

/** The rule's answer: the question to ask, or why none is asked. */
export type AskVerdict = { ask: PendingAsk } | { ask: null; why: string };

const looksAlike = (a: VoiceTarget, b: VoiceTarget): boolean =>
  a.tag === b.tag && a.text.trim().toLowerCase() === b.text.trim().toLowerCase();

/** The cheap rule over the model's proposal. */
export function decideAsk(proposal: AskProposal | null | undefined, ctx: AskContext): AskVerdict {
  if (!proposal) return { ask: null, why: 'none proposed' };
  if (ctx.asked) return { ask: null, why: 'already asked' };
  const q = proposal.question;
  const words = q.split(/\s+/).filter(Boolean).length;
  if (!q.endsWith('?') || words === 0 || words > ASK_MAX_WORDS) {
    return { ask: null, why: 'not a short question' };
  }
  const choices = proposal.choices.filter((c) => c.label.length <= MAX_LABEL);
  if (choices.length < 2 || choices.length > 3 || choices.length !== proposal.choices.length) {
    return { ask: null, why: 'not two or three choices' };
  }
  if (choices.every((c) => c.element !== undefined)) {
    if (ctx.fixed) return { ask: null, why: 'placed by the person' };
    const ids = new Set(choices.map((c) => c.element));
    if (ids.size !== choices.length) return { ask: null, why: 'choices repeat' };
    const els = choices.flatMap((c) => ctx.targets.filter((t) => t.i === c.element));
    const alike = els.some((a, i) => els.some((b, j) => j > i && looksAlike(a, b)));
    if (!VAGUE.test(ctx.words) && !alike) return { ask: null, why: 'element named' };
    return { ask: { key: ctx.key, question: q, choices, about: 'anchor' } };
  }
  if (choices.every((c) => c.text !== undefined && c.text.length <= MAX_TEXT)) {
    if (new Set(choices.map((c) => c.text)).size !== choices.length) {
      return { ask: null, why: 'choices repeat' };
    }
    return { ask: { key: ctx.key, question: q, choices, about: 'meaning' } };
  }
  return { ask: null, why: 'mixed choices' };
}

const ORDINALS: Array<[RegExp, (n: number) => number]> = [
  [/\b(first|1st|top|former)\b/, () => 0],
  [/\b(second|2nd|latter)\b/, () => 1],
  [/\b(third|3rd)\b/, () => 2],
  [/\b(last|bottom)\b/, (n) => n - 1],
];

const SKIP = /\b(neither|never ?mind|keep it|leave it|skip|as it is|none)\b/;

const FILLER = new Set('the one and that this its button'.split(' '));

/**
 * A short spoken answer to `ask`: the choice it picks, `'skip'`, or null when
 * the words are not plainly one — those go to the model with the question.
 */
export function answerFromWords(ask: PendingAsk, said: string): number | 'skip' | null {
  const list = said.split(/\s+/).map(normWord).filter(Boolean);
  if (list.length === 0 || list.length > SHORT_ANSWER_WORDS) return null;
  const text = list.join(' ');
  if (SKIP.test(text)) return 'skip';
  const n = ask.choices.length;
  for (const [re, pick] of ORDINALS) {
    if (re.test(text)) {
      const i = pick(n);
      return i < n ? i : null;
    }
  }
  const heard = new Set(list);
  const keys = ask.choices.map(
    (c) =>
      new Set(
        c.label
          .split(/\s+/)
          .map(normWord)
          .filter((w) => w.length >= 3 && !FILLER.has(w)),
      ),
  );
  // A word only one choice's label has: "footer" in "Save in the footer".
  const hits = keys.map((own, i) =>
    [...own].some((w) => heard.has(w) && keys.every((k, j) => j === i || !k.has(w))),
  );
  const picked = hits.flatMap((h, i) => (h ? [i] : []));
  return picked.length === 1 ? (picked[0] ?? null) : null;
}
