/**
 * Workflow B: what Bryan is doing right now, and the free trigger that says
 * when a moment is worth one model call.
 *
 * Two sources, both his alone:
 *
 *  - **where-I-am**, from his board and doc pages (`POST /coach/here`): the
 *    board, the doc, whether the tab is visible, how far down he is and the
 *    heading in view. Sent on load, on show and hide, on scroll and on input,
 *    each at most every 30 seconds by the page.
 *  - **the activity record**: each owner row as it is written (opens, edits,
 *    comments, replies, reading sessions), handed over by `onActivity` in
 *    `activity.ts`. A reading session arrives when it ends, so it feeds the
 *    prompt, not the trigger.
 *
 * ACTIVE TIME. Two signals on the same focus less than `ACTIVE_GAP_MS` apart
 * count the gap between them as active. A hidden tab ends the span, and a
 * longer silence is idle and counts nothing.
 *
 * THE TRIGGER (free, no model). A candidate moment is a change in what he is
 * doing: he moves to a new doc or board after at least `SWITCH_AFTER_MS`
 * active on the last one, or he has spent `STAY_MS` active on one thing
 * (and again every `STAY_MS` after). Whether a candidate may be judged at
 * all is the caller's spacing rule (`coach/moment.ts`).
 *
 * Pure apart from the clock it is handed, so the tests drive a whole day.
 */
import { zonedParts } from '@claude-workspaces/core/schedule-timezone';
import type { Event } from '../activity.ts';
import { type DocLabel, digestActivity, digestLines } from './digest.ts';

export const ACTIVE_GAP_MS = 3 * 60_000;
export const SWITCH_AFTER_MS = 10 * 60_000;
export const STAY_MS = 20 * 60_000;
/** How far back the prompt looks. */
export const LOOKBACK_MS = 60 * 60_000;
const KEEP_MS = 2 * LOOKBACK_MS;

export interface HereSignal {
  at: number;
  workspaceId: string;
  docId?: string;
  visible: boolean;
  scrollPct?: number;
  heading?: string;
}

export type TriggerCause = 'switched' | 'stayed';

/** One stretch on one thing: a doc, or a board's own page. */
export interface FocusStretch {
  key: string;
  workspaceId: string;
  docId?: string;
  startedAt: number;
  lastAt: number;
  activeMs: number;
  /** Active time at the last candidate on this stretch. */
  judgedAtMs: number;
  /** False after a hidden tab, until the next visible signal. */
  live: boolean;
  heading?: string;
  scrollPct?: number;
}

const keyOf = (workspaceId: string, docId?: string) =>
  docId ? `doc:${docId}` : `board:${workspaceId}`;

export class CoachStream {
  private stretches: FocusStretch[] = [];
  private rows: Event[] = [];

  /** The stretch he is on, if any. */
  get current(): FocusStretch | undefined {
    return this.stretches.at(-1);
  }

  /** A page said where he is. Returns the trigger it tripped, if any. */
  here(s: HereSignal): TriggerCause | null {
    return this.observe(s.at, s.workspaceId, s.docId, s.visible, s);
  }

  /** An owner row from the activity record. */
  activity(
    row: Event,
    at: number,
    workspaceOf: (docId: string) => string | undefined,
  ): TriggerCause | null {
    if (!row.isOwner) return null;
    this.rows.push(row);
    this.prune(at);
    // A reading session is reported when it ends: context, not a signal.
    if (row.type === 'read_session') return null;
    const docId = row.doc?.docId;
    const ws = docId ? workspaceOf(docId) : undefined;
    if (!docId || !ws) return null;
    return this.observe(at, ws, docId, true, {});
  }

  private observe(
    at: number,
    workspaceId: string,
    docId: string | undefined,
    visible: boolean,
    where: Pick<HereSignal, 'scrollPct' | 'heading'>,
  ): TriggerCause | null {
    const key = keyOf(workspaceId, docId);
    const cur = this.current;
    if (!visible) {
      // A hidden tab ends the active span, whichever page sent it.
      if (cur?.live && cur.key === key && at - cur.lastAt <= ACTIVE_GAP_MS) {
        cur.activeMs += Math.max(0, at - cur.lastAt);
        cur.lastAt = at;
      }
      if (cur) cur.live = false;
      return null;
    }
    if (cur && cur.key === key) {
      if (cur.live && at - cur.lastAt <= ACTIVE_GAP_MS)
        cur.activeMs += Math.max(0, at - cur.lastAt);
      cur.lastAt = at;
      cur.live = true;
      if (where.heading !== undefined) cur.heading = where.heading;
      if (where.scrollPct !== undefined) cur.scrollPct = where.scrollPct;
      this.prune(at);
      if (cur.activeMs - cur.judgedAtMs >= STAY_MS) {
        cur.judgedAtMs = cur.activeMs;
        return 'stayed';
      }
      return null;
    }
    // Time up to this signal still belongs to the stretch being left.
    if (cur?.live && at - cur.lastAt <= ACTIVE_GAP_MS) {
      cur.activeMs += Math.max(0, at - cur.lastAt);
      cur.lastAt = at;
    }
    if (cur) cur.live = false;
    this.stretches.push({
      key,
      workspaceId,
      ...(docId ? { docId } : {}),
      startedAt: at,
      lastAt: at,
      activeMs: 0,
      judgedAtMs: 0,
      live: true,
      ...(where.heading !== undefined ? { heading: where.heading } : {}),
      ...(where.scrollPct !== undefined ? { scrollPct: where.scrollPct } : {}),
    });
    this.prune(at);
    return cur && cur.activeMs >= SWITCH_AFTER_MS ? 'switched' : null;
  }

  private prune(at: number): void {
    const cut = at - KEEP_MS;
    this.rows = this.rows.filter((r) => Date.parse(r.ts) >= cut);
    const keep = this.stretches.filter((s) => s.lastAt >= cut);
    // The current stretch always stays.
    const cur = this.current;
    if (cur && !keep.includes(cur)) keep.push(cur);
    this.stretches = keep;
  }

  /** The last hour, as the prompt reads it: where he was, then what he did. */
  lines(
    now: number,
    timeZone: string,
    label: (docId: string) => DocLabel,
    boardName: (workspaceId: string) => string | undefined,
  ): {
    now: string | null;
    where: string[];
    did: string[];
  } {
    const since = now - LOOKBACK_MS;
    const name = (s: FocusStretch) => {
      if (!s.docId) return `the page of board "${boardName(s.workspaceId) ?? s.workspaceId}"`;
      const l = label(s.docId);
      return `"${l.title ?? s.docId}"${l.board ? ` on board "${l.board}"` : ''}`;
    };
    const where = this.stretches
      .filter((s) => s.lastAt >= since && s !== this.current)
      .map(
        (s) =>
          `${hhmm(s.startedAt, timeZone)}–${hhmm(s.lastAt, timeZone)} ${name(s)}: ${mins(s.activeMs)} active`,
      );
    const cur = this.current;
    const nowLine =
      cur && cur.lastAt >= since
        ? `Since ${hhmm(cur.startedAt, timeZone)} on ${name(cur)}: ${mins(cur.activeMs)} active${
            cur.heading ? `, reading the part headed "${cur.heading}"` : ''
          }${cur.scrollPct !== undefined ? `, ${cur.scrollPct}% of the way down` : ''}.`
        : null;
    const did = digestLines(digestActivity(this.rows, since, label), timeZone);
    return { now: nowLine, where, did };
  }
}

const hhmm = (instant: number, timeZone: string): string => {
  const p = zonedParts(instant, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;
