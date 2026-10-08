/**
 * An open ask that no longer applies, read off its thread.
 *
 * Bryan, 2026-10-07: "Why are there invalid review items still on my board
 * from text that's been orphaned and is no longer needed?" An item was
 * anchored on a mock's button; the agent removed the button and said so on
 * the thread, and the item stayed on Home. Two rules decide it, both read
 * from the thread as it stands, so an item filed before this existed is
 * judged the same way and nothing is rewritten:
 *
 *  - **orphaned** — the thread's anchor is orphaned: the words or element it
 *    was about are gone from the doc. A re-anchor brings the ask back.
 *  - **settled** — a LATER comment by the asker itself, carrying no
 *    declaration of its own, says the subject was removed or the work was
 *    done (`settlesAsk`). Only the asker's own words count: a person
 *    replying is answering, which is a different exit.
 *
 * The item is not destroyed. Its words stay on the thread, marked as no
 * longer asked, and the queue stops carrying it. The asker is told once, so it
 * can withdraw the item or file a fresh one.
 *
 * `settlesAsk` is a narrow phrase rule, not a model, so it can be tested and
 * costs nothing per reply. What it misses: a paraphrase outside its phrases
 * ("the button's gone", "all sorted"), a bare "done", a settling reply from a
 * different agent, and an anchor the server never marks orphaned (an element
 * removed from a mock is found missing by the widget, not the server). What
 * it can wrongly catch: an asker's reply that reports removing something
 * unrelated while the question still stands, without a question mark or a
 * "still need".
 */

/** Why an ask stopped applying. */
export type StaleAskRule = 'orphaned' | 'settled';

export interface StaleAsk {
  rule: StaleAskRule;
  /** When it stopped applying: the settling comment's time, or the time the
   *  anchor was last seen. */
  at: number;
  /** The asker's comment that settled it, for `settled`. */
  commentId?: string;
}

/** The fixed line the thread shows on a stale ask, and the asker is told. */
export const STALE_ASK_NOTE: Record<StaleAskRule, string> = {
  orphaned: 'No longer asked: what it was about is gone from the page.',
  settled: 'No longer asked: its asker said this was settled.',
};

interface CommentLike {
  id: string;
  ts: number;
  text: string;
  author: { id?: string; name?: string };
  review?: unknown;
}

interface ThreadLike {
  anchor?: { kind: string; lastSeenAt?: number };
  comments?: ReadonlyArray<CommentLike>;
}

/** Phrases that say the subject is gone or the question is moot. */
const SETTLED_RE = [
  /\bno longer (?:needed|necessary|applies|apply|relevant|an issue|a question|asked)\b/i,
  /\b(?:is|was|are|were|has been|have been|now)\s+(?:removed|deleted|gone)\b/i,
  /\b(?:i|we)(?:\s+have|'ve)?\s+(?:removed|deleted|dropped)\b/i,
  /\bmoot\b/i,
  /\b(?:never ?mind|disregard (?:this|that|the question|my question))\b/i,
  /\b(?:already|now)\s+(?:done|fixed|shipped|merged)\b/i,
  /\b(?:i|we)\s+(?:went ahead|did it|ran it)\b/i,
];
/** A reply that still asks is not a settlement, whatever else it says. */
const STILL_ASKING_RE = /\?|\bstill (?:need|needs|want|wants|waiting|open|asking)\b/i;

/** Does this text, from the asker, settle its own earlier ask? */
export function settlesAsk(text: string): boolean {
  if (STILL_ASKING_RE.test(text)) return false;
  return SETTLED_RE.some((re) => re.test(text));
}

const sameAuthor = (a: CommentLike['author'], b: CommentLike['author']): boolean =>
  a.id !== undefined && b.id !== undefined ? a.id === b.id : a.name === b.name;

/**
 * Whether the declaration `declaring` on `thread` no longer applies, and why.
 * Orphaned wins over settled: it is the fact about the doc, and it is the one
 * a re-anchor can undo.
 */
export function staleAsk(thread: ThreadLike, declaring: CommentLike): StaleAsk | undefined {
  if (thread.anchor?.kind === 'orphan') {
    return { rule: 'orphaned', at: thread.anchor.lastSeenAt ?? declaring.ts };
  }
  const later = [...(thread.comments ?? [])]
    .filter((c) => c.ts > declaring.ts && c.id !== declaring.id)
    .sort((a, b) => a.ts - b.ts);
  for (const c of later) {
    if (c.review !== undefined) continue;
    if (!sameAuthor(c.author, declaring.author)) continue;
    if (settlesAsk(c.text)) return { rule: 'settled', at: c.ts, commentId: c.id };
  }
  return undefined;
}
