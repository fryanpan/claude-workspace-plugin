/**
 * What Bryan did in the last hour, as the coach's judgement reads it.
 *
 * The rows are the activity record's (`activity.jsonl`), as the live feed
 * hands them over (`coach/stream.ts`): docs and mockups opened and read
 * (with active reading time), edit sessions, and the comments and replies
 * written. Only rows marked `isOwner` count, so an agent's work never reads
 * as his.
 *
 * They are folded into one line per doc, newest last, so the prompt carries
 * what the time went to rather than every event. Comment text is cut to its
 * first 200 characters.
 */
import { zonedParts } from '@claude-workspaces/core/schedule-timezone';
import type { Event } from '../activity.ts';

/** At most this many docs in the prompt; the most recent are kept. */
export const MAX_DIGEST_DOCS = 40;
const MAX_COMMENTS_PER_DOC = 3;
const COMMENT_CHARS = 200;
const TITLE_CHARS = 120;

/** One doc's share of the day. */
export interface DigestDoc {
  docId: string;
  title: string;
  kind: string;
  board?: string;
  firstAt: number;
  lastAt: number;
  readMs: number;
  opens: number;
  edits: number;
  comments: string[];
}

export interface DocLabel {
  title?: string;
  board?: string;
}

/** The owner's rows at or after `since`, folded per doc, oldest first. */
export function digestActivity(
  rows: readonly unknown[],
  since: number,
  label: (docId: string) => DocLabel,
): DigestDoc[] {
  const byDoc = new Map<string, DigestDoc>();
  for (const raw of rows) {
    const e = raw as Partial<Event>;
    if (!e || e.isOwner !== true || typeof e.ts !== 'string' || !e.doc?.docId) continue;
    const at = Date.parse(e.ts);
    if (!Number.isFinite(at) || at < since) continue;
    const docId = e.doc.docId;
    let d = byDoc.get(docId);
    if (!d) {
      const l = label(docId);
      d = {
        docId,
        title: (l.title ?? e.doc.title ?? docId).slice(0, TITLE_CHARS),
        kind: e.doc.kind ?? 'markdown',
        ...(l.board ? { board: l.board } : {}),
        firstAt: at,
        lastAt: at,
        readMs: 0,
        opens: 0,
        edits: 0,
        comments: [],
      };
      byDoc.set(docId, d);
    }
    d.firstAt = Math.min(d.firstAt, at);
    d.lastAt = Math.max(d.lastAt, at);
    const p = e.payload ?? {};
    if (e.type === 'read_session' && typeof p.durationMs === 'number') d.readMs += p.durationMs;
    else if (e.type === 'doc_open') d.opens += 1;
    else if (e.type === 'edit_session') d.edits += 1;
    else if ((e.type === 'comment' || e.type === 'reply') && typeof p.text === 'string') {
      if (d.comments.length < MAX_COMMENTS_PER_DOC) {
        d.comments.push(p.text.replace(/\s+/g, ' ').trim().slice(0, COMMENT_CHARS));
      }
    }
  }
  return [...byDoc.values()].sort((a, b) => a.lastAt - b.lastAt).slice(-MAX_DIGEST_DOCS);
}

const hhmm = (instant: number, timeZone: string): string => {
  const p = zonedParts(instant, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/** One prompt line per doc: when, what, and what he did there. */
export function digestLines(docs: readonly DigestDoc[], timeZone: string): string[] {
  return docs.map((d) => {
    const did: string[] = [];
    if (d.readMs >= 60_000) did.push(`read ${Math.round(d.readMs / 60_000)} min`);
    else if (d.opens > 0 || d.readMs > 0) did.push('looked at');
    if (d.edits > 0) did.push(`edited (${d.edits}×)`);
    for (const c of d.comments) did.push(`commented: "${c}"`);
    const where = d.board ? ` on board "${d.board}"` : '';
    return `${hhmm(d.firstAt, timeZone)}–${hhmm(d.lastAt, timeZone)} ${d.kind} "${d.title}"${where}: ${did.join('; ') || 'opened'}`;
  });
}
